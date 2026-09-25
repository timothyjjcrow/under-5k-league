import { predictionOpen } from "./pickem";
import { isPlayoffPhase } from "./league-lifecycle";
import { prisma } from "./prisma";
import {
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
  WEEK_REMINDER,
} from "./constants";
import {
  draftReminderAnnouncement,
  getWebhookUrl,
  sendDiscordMessage,
  weekReminderAnnouncement,
} from "./discord";
import {
  expectedSideSize,
  matchNightRoster,
  teamAvailability,
} from "./availability";
import { draftReminderKey, weekReminderKey } from "./settings";
import { draftReminderDue } from "./draft-setup";
import { DRAFT_READINESS, draftReadiness } from "./draft-readiness";
import { raceHook } from "./race-hook";
import { mentionsOf } from "./discord-mentions";
import {
  announcementDedupeKey,
  claimAnnouncementMarker,
  markAnnouncementFailed,
  markAnnouncementSent,
  recoverableAnnouncementMarker,
  releaseAnnouncementClaim,
} from "./announcement-marker";

/**
 * Scheduled match-night reminder: the first automation pass after a league
 * night enters the reminder window announces the week's fixtures (with reader-local
 * <t:…:R> kickoffs and per-team check-in counts) to Discord — attendance
 * stops depending on an admin remembering to post.
 *
 * Runs only from the authenticated, leased automation worker. The no-op path
 * is two cheap reads: the webhook setting and one
 * indexed Match query. Announced at most once per kickoff cluster: the marker
 * row is CREATED atomically (Setting.key is the id), so concurrent triggers
 * race to a P2002 instead of double-sending — deliberately stronger than
 * honors-service's read-then-upsert, because the trigger here is concurrent
 * traffic rather than a single admin action. The send itself is AWAITED:
 * fire-and-forget promises can be killed on serverless hosts.
 *
 * Match.week is set on playoff rounds too (lastRegularWeek+1, +1 per round),
 * so the per-week marker covers both phases.
 */
export async function maybeAnnounceUpcomingWeek(season: {
  id: string;
  status: string;
  /** The expected side size — the denominator the check-in counts render out
   *  of, so a short roster can't report itself as fully checked in. */
  teamSize: number;
}): Promise<boolean> {
  if (
    season.status !== SEASON_STATUS.REGULAR_SEASON &&
    season.status !== SEASON_STATUS.PLAYOFFS
  ) {
    return false;
  }
  if (!(await getWebhookUrl())) return false;

  const now = Date.now();
  const candidates = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      status: MATCH_STATUS.SCHEDULED,
      scheduledAt: {
        gte: new Date(now - WEEK_REMINDER.BEHIND_HOURS * 3600_000),
        lte: new Date(now + WEEK_REMINDER.AHEAD_HOURS * 3600_000),
      },
    },
    orderBy: { scheduledAt: "asc" },
    select: { week: true, phase: true, scheduledAt: true },
  });
  if (candidates.length === 0) return false;

  // A numbered week can split across nights after a captain/admin retime.
  // Treat each exact kickoff as its own reminder cluster; one early outlier
  // can no longer burn the whole week's marker and suppress the actual league
  // night. The common case (every fixture shares one kickoff) remains one
  // message. Find the first cluster that has not already won its claim.
  const clusters = [
    ...new Map(
      candidates.map((m) => [`${m.week}:${m.scheduledAt!.getTime()}`, m]),
    ).values(),
  ];
  const markerKeys = clusters.map((m) =>
    weekReminderKey(season.id, m.week, m.scheduledAt!.getTime()),
  );
  const existing = new Map(
    (
      await prisma.setting.findMany({
        where: { key: { in: markerKeys } },
        select: { key: true, value: true },
      })
    ).map((row) => [row.key, row.value]),
  );
  const next = clusters.find(
    (m) => {
      const value = existing.get(
        weekReminderKey(season.id, m.week, m.scheduledAt!.getTime()),
      );
      return value === undefined || recoverableAnnouncementMarker(value, now);
    },
  );
  if (!next) return false;
  const markerKey = weekReminderKey(
    season.id,
    next.week,
    next.scheduledAt!.getTime(),
  );

  // Claim before building the message — one winner per kickoff cluster. The
  // lease recovers a process death before enqueue, while its stable event id
  // deduplicates a death after enqueue but before marker finalization.
  const claim = await claimAnnouncementMarker(markerKey, now);
  if (!claim) return false;

  // Test seam: the gap between the claim above and the fetch below is where
  // an auto-sync completion (any page view) can empty the week.
  await raceHook("weekReminder.afterClaim");

  const matches = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      week: next.week,
      status: MATCH_STATUS.SCHEDULED,
      scheduledAt: next.scheduledAt,
    },
    include: {
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
    orderBy: { scheduledAt: "asc" },
  });
  if (matches.length === 0) {
    // Release the claim like the failed-send path below: the week completed
    // (or lost its times) between the probe and this fetch, and a burned
    // marker would permanently suppress the reminder if a retime brings
    // fixtures back. No loop risk: probe and fetch share predicates, so no
    // consistent DB state satisfies one and empties the other — the next
    // call stops at the probe without claiming.
    await releaseAnnouncementClaim(claim);
    return false;
  }

  // Standin-aware check-in counts — same helpers as /schedule and the
  // dashboard's ThisWeek strip, so the reminder can't disagree with the site.
  const teamIds = [
    ...new Set(matches.flatMap((m) => [m.homeTeamId, m.awayTeamId])),
  ];
  const matchIds = matches.map((m) => m.id);
  const [members, rsvps, assignments] = await Promise.all([
    prisma.teamMember.findMany({
      where: { seasonId: season.id, teamId: { in: teamIds } },
      select: { teamId: true, userId: true },
    }),
    prisma.matchAvailability.findMany({
      where: { matchId: { in: matchIds } },
      select: { matchId: true, userId: true, status: true, scheduleRevision: true },
    }),
    prisma.standinAssignment.findMany({
      where: { matchId: { in: matchIds } },
      select: {
        matchId: true,
        teamId: true,
        standinUserId: true,
        replacingUserId: true,
      },
    }),
  ]);
  const rosterByTeam = new Map<string, string[]>();
  for (const m of members) {
    const arr = rosterByTeam.get(m.teamId) ?? [];
    arr.push(m.userId);
    rosterByTeam.set(m.teamId, arr);
  }
  const sideRoster = (matchId: string, teamId: string) =>
    matchNightRoster(
      rosterByTeam.get(teamId) ?? [],
      assignments.filter((a) => a.matchId === matchId && a.teamId === teamId),
    );

  const draft = matches.map((m) => {
    const rows = rsvps.filter((r) => r.matchId === m.id && r.scheduleRevision === m.scheduleRevision);
    const home = sideRoster(m.id, m.homeTeamId);
    const away = sideRoster(m.id, m.awayTeamId);
    const homeAv = teamAvailability(home, rows);
    const awayAv = teamAvailability(away, rows);
    return {
      matchId: m.id,
      homeName: m.homeTeam.name,
      awayName: m.awayTeam.name,
      scheduledAt: m.scheduledAt!.getTime(),
      homeIn: homeAv.confirmed,
      // Out of the season's side size — a short roster used to report itself
      // as fully checked in ("4/4") in the channel.
      homeSize: expectedSideSize(season.teamSize, home.length),
      awayIn: awayAv.confirmed,
      awaySize: expectedSideSize(season.teamSize, away.length),
      waitingIds: [...homeAv.unansweredUserIds, ...awayAv.unansweredUserIds],
    };
  });

  // Name the people who owe an answer, and MENTION the ones who linked
  // Discord. The counts above state a number into a channel; the people who
  // haven't checked in are by definition the ones not reading it.
  const waitingIds = [...new Set(draft.flatMap((d) => d.waitingIds))];
  const waitingUsers = waitingIds.length
    ? await prisma.user.findMany({
        where: { id: { in: waitingIds } },
        select: { id: true, name: true, discordId: true },
      })
    : [];
  const userById = new Map(waitingUsers.map((u) => [u.id, u]));
  const fixtures = draft.map(({ waitingIds: ids, ...f }) => ({
    ...f,
    waitingOn: ids.flatMap((id) => {
      const u = userById.get(id);
      return u ? [{ name: u.name, discordId: u.discordId }] : [];
    }),
  }));

  const announcement = weekReminderAnnouncement({
    week: next.week,
    isPlayoff: isPlayoffPhase(next.phase),
    isTiebreaker: next.phase === MATCH_PHASE.TIEBREAKER,
    fixtures,
    pickemOpen: matches.some((m) => predictionOpen(m)),
  });
  const sent = await sendDiscordMessage(
    announcement.content,
    // Only these exact ids may ring a phone — parse:[] still blocks everything
    // else, so a team name or persona in the same message stays inert. The
    // builder omits these ids whenever their fixture/waiter line cannot fit in
    // Discord's 2,000-character body limit.
    mentionsOf(announcement.mentionUserIds),
    {
      dedupeKey: announcementDedupeKey("reminder", claim),
      marker: { key: claim.key, eventId: claim.eventId },
    },
  );
  if (!sent) {
    await markAnnouncementFailed(claim);
    return false;
  }
  return markAnnouncementSent(claim);
}

/**
 * Scheduled draft-night reminder: the first automation pass after the draft
 * enters the DRAFT_REMINDER window posts the time (reader-local <t:…:F> and
 * <t:…:R>), the pool and captain counts, and links to the draft room and the
 * signup page. It mentions the designated captains (the auction cannot run
 * without them) and the linked players who haven't confirmed THIS draft time.
 *
 * Due only while setup is open (SIGNUPS, or DRAFT with the auction not yet
 * started) and draftAt is still ahead; draftReminderDue is the one definition
 * of that window, shared with the automation gate. Announced at most once per
 * draftAt REVISION: the marker key carries season + draftRevision, so moving
 * the draft re-arms the reminder under a fresh key, and setDraftNight
 * invalidates any in-flight claim or queued send for the old time. The claim
 * machinery is the week reminder's: an atomic CREATE, a lease that recovers a
 * process death, and a failed send that stays retryable instead of eating the
 * announcement. No webhook returns before the claim, so it never burns one.
 */
export async function maybeAnnounceDraftNight(season: {
  id: string;
  status: string;
  draftAt: Date | null;
  draftRevision: number;
}): Promise<boolean> {
  if (
    season.status !== SEASON_STATUS.SIGNUPS &&
    season.status !== SEASON_STATUS.DRAFT
  ) {
    return false;
  }
  const now = Date.now();
  const draftAtMs = season.draftAt?.getTime() ?? null;
  // Cheap pre-check before any IO; the real Draft status is read below.
  if (
    draftAtMs == null ||
    !draftReminderDue(season.status, null, draftAtMs, now)
  ) {
    return false;
  }
  if (!(await getWebhookUrl())) return false;

  const markerKey = draftReminderKey(season.id, season.draftRevision);
  const [draft, existing] = await Promise.all([
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true },
    }),
    prisma.setting.findUnique({
      where: { key: markerKey },
      select: { value: true },
    }),
  ]);
  if (!draftReminderDue(season.status, draft?.status, draftAtMs, now)) {
    return false;
  }
  if (existing && !recoverableAnnouncementMarker(existing.value, now)) {
    return false;
  }

  const claim = await claimAnnouncementMarker(markerKey, now);
  if (!claim) return false;

  // Test seam: between the probe above and the re-read below, an admin can
  // move the draft (setDraftNight) or press Start (startDraft).
  await raceHook("draftReminder.afterClaim");

  // Re-read everything the message states AFTER the claim, so the post can't
  // quote a time or a pool that changed while this run was deciding.
  const [current, currentDraft, registrations, teams] = await Promise.all([
    prisma.season.findUnique({
      where: { id: season.id },
      select: {
        name: true,
        status: true,
        isActive: true,
        draftAt: true,
        draftRevision: true,
      },
    }),
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true },
    }),
    prisma.registration.findMany({
      where: {
        seasonId: season.id,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.PLAYER,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        userId: true,
        draftConfirmedRevision: true,
        draftConfirmedAt: true,
        user: { select: { name: true, discordId: true } },
      },
    }),
    prisma.team.findMany({
      where: { seasonId: season.id },
      orderBy: [{ draftOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        captainId: true,
        captain: { select: { name: true, discordId: true } },
      },
    }),
  ]);
  const currentDraftAtMs = current?.draftAt?.getTime() ?? null;
  if (
    !current?.isActive ||
    current.draftRevision !== season.draftRevision ||
    currentDraftAtMs !== draftAtMs ||
    !draftReminderDue(
      current.status,
      currentDraft?.status,
      currentDraftAtMs,
      Date.now(),
    )
  ) {
    // Release rather than burn: a moved draft re-arms under its own revision
    // key, and a started auction or archived season never passes the probe
    // above again, so releasing cannot loop.
    await releaseAnnouncementClaim(claim);
    return false;
  }

  // Captains are always named on their own line, so they're left out of the
  // unconfirmed list rather than printed (and counted) twice. Linked players
  // sort first so the capped unconfirmed slots go to people a mention reaches.
  const captainIds = new Set(teams.map((t) => t.captainId));
  const unconfirmed = registrations.filter(
    (r) =>
      !captainIds.has(r.userId) &&
      draftReadiness(r, current.draftRevision) !== DRAFT_READINESS.READY,
  );
  const linkedFirst = [
    ...unconfirmed.filter((r) => r.user.discordId),
    ...unconfirmed.filter((r) => !r.user.discordId),
  ];

  const announcement = draftReminderAnnouncement({
    seasonName: current.name,
    draftAtMs: currentDraftAtMs!,
    playerSignupsOpen: current.status === SEASON_STATUS.SIGNUPS,
    playerCount: registrations.length,
    captains: teams.map((t) => ({
      name: t.captain.name,
      discordId: t.captain.discordId,
    })),
    unconfirmed: linkedFirst.map((r) => ({
      name: r.user.name,
      discordId: r.user.discordId,
    })),
  });
  const sent = await sendDiscordMessage(
    announcement.content,
    // Exactly the ids visibly named in the post; parse:[] still blocks every
    // other mention, so a persona in the same message stays inert.
    mentionsOf(announcement.mentionUserIds),
    {
      dedupeKey: announcementDedupeKey("reminder", claim),
      marker: { key: claim.key, eventId: claim.eventId },
    },
  );
  if (!sent) {
    await markAnnouncementFailed(claim);
    return false;
  }
  return markAnnouncementSent(claim);
}
