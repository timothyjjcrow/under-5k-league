import { prisma } from "./prisma";
import {
  CHECKIN_NUDGE_THROTTLE_SECONDS,
  MATCH_PHASE,
  MATCH_STATUS,
} from "./constants";
import {
  CHECKIN_REFUSAL_MESSAGE,
  checkinClosedReason,
  checkinNudgeKey,
  teamAvailability,
} from "./availability";
import { loadSidePlayerIds } from "./availability-service";
import {
  checkinNudgeAnnouncement,
  getWebhookUrl,
  sendDiscordMessage,
} from "./discord";
import { mentionsOf } from "./discord-mentions";
import { isPlayoffPhase } from "./league-lifecycle";
import { singleActiveSeason } from "./season";
import { claimThrottle } from "./settings";

// A captain's one-button "please check in" for their own team. The weekly
// reminder already pings everyone who hasn't answered about a day ahead; this
// is the match-night follow-up a captain chasing a missing fifth used to do by
// copying names into Discord. It is optional and adds no step anywhere.
//
// Rules: only a captain of this match, only their own team's players, only
// those with no answer for the current kickoff (never the captain themselves),
// only while check-in is open, and at most once per team per match every
// CHECKIN_NUDGE_THROTTLE_SECONDS. The throttle is an atomic Setting claim,
// taken after every other check so a refused attempt never burns it, and
// released if Discord won't take the message.

export type CheckinNudgeResult =
  | {
      ok: true;
      /** Players named in the message. */
      reminded: number;
      /** Of those, how many were @-mentioned (linked Discord). */
      pinged: number;
    }
  | { ok: false; error: string };

export async function sendCheckinNudge(opts: {
  matchId: string;
  captainId: string;
  nowMs: number;
}): Promise<CheckinNudgeResult> {
  const { matchId, captainId, nowMs } = opts;
  const [season, match] = await Promise.all([
    prisma.season
      .findMany({
        where: { isActive: true },
        orderBy: { createdAt: "desc" },
        take: 2,
        select: { id: true, status: true, draft: { select: { status: true } } },
      })
      .then(singleActiveSeason),
    prisma.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        seasonId: true,
        week: true,
        phase: true,
        status: true,
        scheduledAt: true,
        scheduleRevision: true,
        homeTeamId: true,
        awayTeamId: true,
        homeTeam: { select: { name: true, captainId: true, withdrawn: true } },
        awayTeam: { select: { name: true, captainId: true, withdrawn: true } },
      },
    }),
  ]);
  if (!match) return { ok: false, error: "Unknown match" };
  const teamId =
    match.homeTeam.captainId === captainId
      ? match.homeTeamId
      : match.awayTeam.captainId === captainId
        ? match.awayTeamId
        : null;
  if (!teamId) {
    return {
      ok: false,
      error: "Only a captain in this match can remind their team to check in.",
    };
  }
  const team = teamId === match.homeTeamId ? match.homeTeam : match.awayTeam;
  if (!season || match.seasonId !== season.id) {
    return { ok: false, error: "That match belongs to an archived season" };
  }
  if (team.withdrawn) {
    return { ok: false, error: "Your team has withdrawn from the season." };
  }
  if (match.status === MATCH_STATUS.LIVE) {
    return {
      ok: false,
      error: "The series has started, so check-in for this match is closed.",
    };
  }
  const closed = checkinClosedReason(
    season.status,
    season.draft?.status,
    match,
    nowMs,
  );
  if (closed) return { ok: false, error: CHECKIN_REFUSAL_MESSAGE[closed] };

  // The side as check-in sees it: roster minus covered seats, plus standins.
  const [side, rows] = await Promise.all([
    loadSidePlayerIds(prisma, match, teamId),
    prisma.matchAvailability.findMany({
      where: { matchId: match.id, scheduleRevision: match.scheduleRevision },
      select: { userId: true, status: true },
    }),
  ]);
  const waitingIds = teamAvailability([...side], rows).unansweredUserIds.filter(
    (id) => id !== captainId,
  );
  if (waitingIds.length === 0) {
    return { ok: false, error: "Everyone on your team has already answered." };
  }

  // No channel means nothing to send: refuse before claiming, so setting the
  // webhook up later isn't met by a window this attempt burned.
  if (!(await getWebhookUrl())) {
    return {
      ok: false,
      error: "This league has no Discord channel set up for reminders.",
    };
  }
  const key = checkinNudgeKey(match.id, teamId);
  if (!(await claimThrottle(key, CHECKIN_NUDGE_THROTTLE_SECONDS, nowMs))) {
    return {
      ok: false,
      error: `Your team already got a check-in reminder in the last ${CHECKIN_NUDGE_THROTTLE_SECONDS / 3600} hours.`,
    };
  }

  // Give the window back if nothing went out, but only the claim this call
  // wrote: a newer claim (another tab, a later window) keeps its row.
  let sent = false;
  let reminded = 0;
  let pinged = 0;
  try {
    const people = await prisma.user.findMany({
      where: { id: { in: [...waitingIds, captainId] } },
      select: { id: true, name: true, discordId: true },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const waitingOn = waitingIds.flatMap((id) => {
      const person = byId.get(id);
      return person ? [{ name: person.name, discordId: person.discordId }] : [];
    });
    const announcement = checkinNudgeAnnouncement({
      captainName: byId.get(captainId)?.name ?? "Your captain",
      teamName: team.name,
      homeName: match.homeTeam.name,
      awayName: match.awayTeam.name,
      week: match.week,
      isPlayoff: isPlayoffPhase(match.phase),
      isTiebreaker: match.phase === MATCH_PHASE.TIEBREAKER,
      whenMs: match.scheduledAt?.getTime() ?? null,
      matchId: match.id,
      waitingOn,
    });
    reminded = waitingOn.length;
    pinged = announcement.mentionUserIds.length;
    sent = await sendDiscordMessage(
      announcement.content,
      mentionsOf(announcement.mentionUserIds),
    );
  } finally {
    if (!sent) {
      await prisma.setting.deleteMany({
        where: { key, value: new Date(nowMs).toISOString() },
      });
    }
  }
  if (!sent) {
    return {
      ok: false,
      error: "Couldn't post the reminder to Discord. Try again in a minute.",
    };
  }
  return { ok: true, reminded, pinged };
}

/**
 * When this team's last reminder for the match went out, while it still
 * blocks another (the match page shows it instead of the button). Null when a
 * reminder can be sent.
 */
export async function checkinNudgeBlockedSince(
  matchId: string,
  teamId: string,
  nowMs: number,
): Promise<Date | null> {
  const row = await prisma.setting.findUnique({
    where: { key: checkinNudgeKey(matchId, teamId) },
    select: { value: true },
  });
  const sentMs = row ? Date.parse(row.value) : NaN;
  return Number.isFinite(sentMs) &&
    nowMs - sentMs < CHECKIN_NUDGE_THROTTLE_SECONDS * 1000
    ? new Date(sentMs)
    : null;
}

/** The captain's toast after a reminder went out. */
export function checkinNudgeToast(reminded: number, pinged: number): string {
  const who =
    reminded === 1
      ? "the 1 player who hasn't answered"
      : `the ${reminded} players who haven't answered`;
  const unlinked = reminded - pinged;
  const note =
    unlinked <= 0
      ? ""
      : unlinked === reminded
        ? reminded === 1
          ? " They haven't linked Discord, so they were named without a ping."
          : " None of them have linked Discord, so they were named without a ping."
        : ` ${unlinked} of them ${unlinked === 1 ? "hasn't" : "haven't"} linked Discord, so they were named without a ping.`;
  return `Posted a check-in reminder in Discord for ${who}.${note}`;
}
