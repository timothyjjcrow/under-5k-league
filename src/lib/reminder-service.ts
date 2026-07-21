import { prisma } from "./prisma";
import { MATCH_STATUS, SEASON_STATUS, WEEK_REMINDER } from "./constants";
import {
  getWebhookUrl,
  sendDiscordMessage,
  weekReminderMessage,
} from "./discord";
import { matchNightRoster, teamAvailability } from "./availability";

/**
 * Lazy match-night reminder: the first page load after a league night enters
 * the reminder window announces the week's fixtures (with reader-local
 * <t:…:R> kickoffs and per-team check-in counts) to Discord — attendance
 * stops depending on an admin remembering to post.
 *
 * Runs from the dashboard and /schedule renders (both cookie-dynamic, so it
 * executes per request — mid-season there is no polled route to hang it on).
 * The no-op path is two cheap reads: the webhook setting and one indexed
 * Match query. Announced at most once per season+week: the marker row is
 * CREATED atomically (Setting.key is the id), so concurrent page loads race
 * to a P2002 instead of double-sending — deliberately stronger than
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
}): Promise<boolean> {
  if (
    season.status !== SEASON_STATUS.REGULAR_SEASON &&
    season.status !== SEASON_STATUS.PLAYOFFS
  ) {
    return false;
  }
  if (!(await getWebhookUrl())) return false;

  const now = Date.now();
  const next = await prisma.match.findFirst({
    where: {
      seasonId: season.id,
      status: { not: MATCH_STATUS.COMPLETED },
      scheduledAt: {
        gte: new Date(now - WEEK_REMINDER.BEHIND_HOURS * 3600_000),
        lte: new Date(now + WEEK_REMINDER.AHEAD_HOURS * 3600_000),
      },
    },
    orderBy: { scheduledAt: "asc" },
    select: { week: true, phase: true },
  });
  if (!next) return false;

  // Claim before building the message — one winner per season+week.
  try {
    await prisma.setting.create({
      data: {
        key: `weekReminder:${season.id}:${next.week}`,
        value: new Date().toISOString(),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return false; // already sent
    throw e;
  }

  const matches = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      week: next.week,
      status: { not: MATCH_STATUS.COMPLETED },
      scheduledAt: { not: null },
    },
    include: {
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
    orderBy: { scheduledAt: "asc" },
  });
  if (matches.length === 0) return false;

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
      select: { matchId: true, userId: true, status: true },
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

  const fixtures = matches.map((m) => {
    const rows = rsvps.filter((r) => r.matchId === m.id);
    const home = sideRoster(m.id, m.homeTeamId);
    const away = sideRoster(m.id, m.awayTeamId);
    return {
      matchId: m.id,
      homeName: m.homeTeam.name,
      awayName: m.awayTeam.name,
      scheduledAt: m.scheduledAt!.getTime(),
      homeIn: teamAvailability(home, rows).confirmed,
      homeSize: home.length,
      awayIn: teamAvailability(away, rows).confirmed,
      awaySize: away.length,
    };
  });

  const sent = await sendDiscordMessage(
    weekReminderMessage({
      week: next.week,
      isPlayoff: next.phase !== "REGULAR",
      fixtures,
    }),
  );
  if (!sent) {
    // A Discord blip must not eat the week's reminder — release the claim so
    // the next page load inside the window retries.
    await prisma.setting.deleteMany({
      where: { key: `weekReminder:${season.id}:${next.week}` },
    });
    return false;
  }
  return true;
}
