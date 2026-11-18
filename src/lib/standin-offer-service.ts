// Standin offers: the reads behind the Standins page and the captain's
// "Said they can play" list, and the two writes (offer, take it back). The
// rules are standin-offer.ts; booking an offer is assignStandinGuarded, which
// deletes the booked standin's offers in that match in its own transaction.
//
// An offer is advisory. It holds no seat, so nothing here is a guarded claim:
// the unique key makes a second tap a no-op, every reader drops offers from
// players the booking rules would refuse (`eligible`), and the booking itself
// re-checks everything.

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  STANDIN_REQUEST_STATUS,
} from "./constants";
import { AVAILABILITY } from "./availability";
import { standinOfferedMessage, type MentionAllowlist } from "./discord";
import { mentionUsers } from "./discord-mentions";
import { isPlayoffPhase, standinAssignmentOpen } from "./league-lifecycle";
import { roundLabelsForPost } from "./playoff-rounds";
import { isUniqueViolation } from "./prisma-errors";
import { getSeasonDraftStatus } from "./queries";
import { getActiveSeason } from "./season";
import { standinConflict } from "./standin";
import {
  sortStandinOffers,
  standinBoardWindow,
  standinOfferStanding,
  standinOfferedToast,
  standinSideNeed,
  type StandinOfferCommitment,
  type StandinOfferStanding,
  type StandinSideNeed,
} from "./standin-offer";

const BOARD_MATCH_SELECT = {
  id: true,
  seasonId: true,
  week: true,
  phase: true,
  bracketSlot: true,
  status: true,
  scheduledAt: true,
  scheduleRevision: true,
  homeTeamId: true,
  awayTeamId: true,
  homeTeam: { select: { name: true, captainId: true, withdrawn: true } },
  awayTeam: { select: { name: true, captainId: true, withdrawn: true } },
  standins: {
    select: { teamId: true, standinUserId: true, replacingUserId: true },
  },
  standinRequests: {
    where: { status: STANDIN_REQUEST_STATUS.PENDING },
    select: { teamId: true, standinUserId: true, replacingUserId: true },
  },
  standinOffers: {
    select: { teamId: true, userId: true, createdAt: true },
  },
} satisfies Prisma.MatchSelect;

type BoardMatch = Prisma.MatchGetPayload<{ select: typeof BOARD_MATCH_SELECT }>;

/** One side of a fixture that still needs someone, as the board lists it. */
export type StandinBoardNeed = StandinSideNeed & {
  matchId: string;
  teamId: string;
  teamName: string;
  captainId: string;
  opponentName: string;
  homeName: string;
  awayName: string;
  week: number;
  phase: string;
  /** "Week 3", "Semifinal": the fixture's name everywhere else. */
  roundLabel: string;
  scheduledAt: Date | null;
  /** Standins on this side's list the booking rules would still take. */
  offerCount: number;
  /** Their ids, first come first: the captain's list reads these. */
  offerUserIds: string[];
};

/**
 * Every side that needs a standin among `matches`. Shared by the board (a
 * window of fixtures) and the offer write (one fixture), so a standin can
 * only ever join a list the board would show.
 */
async function needsFor(
  season: { id: string; teamSize: number },
  matches: readonly BoardMatch[],
): Promise<StandinBoardNeed[]> {
  if (matches.length === 0) return [];
  const teamIds = [
    ...new Set(matches.flatMap((m) => [m.homeTeamId, m.awayTeamId])),
  ];
  const offerUserIds = [
    ...new Set(matches.flatMap((m) => m.standinOffers.map((o) => o.userId))),
  ];
  const [members, outs, labels, offerers] = await Promise.all([
    prisma.teamMember.findMany({
      where: { seasonId: season.id, teamId: { in: teamIds } },
      select: { teamId: true, userId: true, user: { select: { name: true } } },
    }),
    prisma.matchAvailability.findMany({
      where: {
        matchId: { in: matches.map((m) => m.id) },
        status: AVAILABILITY.OUT,
      },
      select: { matchId: true, userId: true, scheduleRevision: true },
    }),
    roundLabelsForPost(matches),
    loadOfferers(season.id, offerUserIds),
  ]);
  const mmrs = await prisma.registration.findMany({
    where: { seasonId: season.id, userId: { in: members.map((m) => m.userId) } },
    select: { userId: true, mmr: true },
  });
  const mmrOf = new Map(mmrs.map((r) => [r.userId, r.mmr]));

  const needs: StandinBoardNeed[] = [];
  for (const match of matches) {
    // This kickoff's answers only: a retime bumps the revision, and an older
    // OUT was for a night nobody is playing.
    const outUserIds = new Set(
      outs
        .filter(
          (o) =>
            o.matchId === match.id &&
            o.scheduleRevision === match.scheduleRevision,
        )
        .map((o) => o.userId),
    );
    for (const teamId of [match.homeTeamId, match.awayTeamId]) {
      const home = teamId === match.homeTeamId;
      const team = home ? match.homeTeam : match.awayTeam;
      const opponent = home ? match.awayTeam : match.homeTeam;
      // A withdrawn team forfeits its fixtures; its "short" is permanent.
      if (team.withdrawn) continue;
      const roster = members
        .filter((m) => m.teamId === teamId)
        .map((m) => ({
          userId: m.userId,
          name: m.user.name,
          mmr: mmrOf.get(m.userId) ?? 0,
        }));
      const named = (rows: readonly { replacingUserId: string | null }[]) =>
        new Set(
          rows.flatMap((r) => (r.replacingUserId ? [r.replacingUserId] : [])),
        );
      const need = standinSideNeed({
        teamSize: season.teamSize,
        roster,
        outUserIds,
        bookedUserIds: named(match.standins),
        askedUserIds: named(match.standinRequests),
        emptySeatsTaken:
          match.standins.filter(
            (a) => a.teamId === teamId && a.replacingUserId === null,
          ).length +
          match.standinRequests.filter(
            (r) => r.teamId === teamId && r.replacingUserId === null,
          ).length,
      });
      if (need.seats === 0) continue;
      const taken = new Set([
        ...match.standins.map((a) => a.standinUserId),
        ...match.standinRequests.map((r) => r.standinUserId),
      ]);
      const listed = sortStandinOffers(
        match.standinOffers.filter((o) => {
          if (o.teamId !== teamId || taken.has(o.userId)) return false;
          const offerer = offerers.get(o.userId);
          return (
            !!offerer &&
            !offerer.bookedSlots.some(
              (slot) => slot.matchId !== match.id && standinConflict(match, slot),
            )
          );
        }),
      );
      needs.push({
        ...need,
        matchId: match.id,
        teamId,
        teamName: team.name,
        captainId: team.captainId,
        opponentName: opponent.name,
        homeName: match.homeTeam.name,
        awayName: match.awayTeam.name,
        week: match.week,
        phase: match.phase,
        roundLabel: labels.get(match.id) ?? `Week ${match.week}`,
        scheduledAt: match.scheduledAt,
        offerCount: listed.length,
        offerUserIds: listed.map((o) => o.userId),
      });
    }
  }
  return needs;
}

/**
 * The offerers a booking could still take: an ACTIVE signup and no roster
 * seat (any ACTIVE unrostered signup can cover, whatever its type), each with
 * the unplayed fixtures they are already booked on, for the same-night rule.
 */
async function loadOfferers(
  seasonId: string,
  userIds: readonly string[],
): Promise<
  Map<string, { bookedSlots: { matchId: string; scheduledAt: Date | null; week: number }[] }>
> {
  if (userIds.length === 0) return new Map();
  const ids = [...userIds];
  const [signups, seats, bookings] = await Promise.all([
    prisma.registration.findMany({
      where: {
        seasonId,
        userId: { in: ids },
        status: REGISTRATION_STATUS.ACTIVE,
      },
      select: { userId: true },
    }),
    prisma.teamMember.findMany({
      where: { seasonId, userId: { in: ids } },
      select: { userId: true },
    }),
    prisma.standinAssignment.findMany({
      where: {
        standinUserId: { in: ids },
        match: { seasonId, status: { not: MATCH_STATUS.COMPLETED } },
      },
      select: {
        standinUserId: true,
        matchId: true,
        match: { select: { scheduledAt: true, week: true } },
      },
    }),
  ]);
  const rostered = new Set(seats.map((s) => s.userId));
  return new Map(
    signups
      .filter((s) => !rostered.has(s.userId))
      .map((s) => [
        s.userId,
        {
          bookedSlots: bookings
            .filter((b) => b.standinUserId === s.userId)
            .map((b) => ({
              matchId: b.matchId,
              scheduledAt: b.match.scheduledAt,
              week: b.match.week,
            })),
        },
      ]),
  );
}

/**
 * The games that need a standin, soonest first: every unplayed fixture of
 * the season kicking off within the board's window whose side has a seat
 * without cover. Empty while booking is closed (`standinAssignmentOpen`'s
 * phase half): before the auction has run, and once the season is over.
 */
export async function loadStandinBoard(
  season: { id: string; status: string; teamSize: number },
  nowMs: number,
): Promise<StandinBoardNeed[]> {
  const draftStatus = await getSeasonDraftStatus(season.id);
  if (!standinAssignmentOpen(season.status, draftStatus, MATCH_STATUS.SCHEDULED))
    return [];
  const { from, to } = standinBoardWindow(nowMs);
  const matches = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      status: { not: MATCH_STATUS.COMPLETED },
      scheduledAt: { gte: from, lte: to },
    },
    select: BOARD_MATCH_SELECT,
    // Exact stored keys, the id last: the same order every render.
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
  });
  return needsFor(season, matches);
}

/**
 * One side's need, whenever its match is: for a game someone was sent to by
 * its link (the board only lists the coming week). Null when the side needs
 * nobody, the match isn't in this season, or booking is closed.
 */
export async function loadStandinNeed(
  season: { id: string; status: string; teamSize: number },
  matchId: string,
  teamId: string,
): Promise<StandinBoardNeed | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: BOARD_MATCH_SELECT,
  });
  if (!match || match.seasonId !== season.id) return null;
  const draftStatus = await getSeasonDraftStatus(season.id);
  if (!standinAssignmentOpen(season.status, draftStatus, match.status))
    return null;
  const needs = await needsFor(season, [match]);
  return needs.find((n) => n.teamId === teamId) ?? null;
}

/**
 * Every side's need among `matchIds` (the season's, unplayed or not), keyed
 * `${matchId}:${teamId}`: the board's own judgement, for the captain's
 * to-dos, so "needs cover" means the same seats on every page. Sides that
 * need nobody are absent; so is every side while booking is closed.
 */
export async function loadSideNeeds(
  season: { id: string; status: string; teamSize: number },
  matchIds: readonly string[],
): Promise<Map<string, StandinBoardNeed>> {
  if (matchIds.length === 0) return new Map();
  const draftStatus = await getSeasonDraftStatus(season.id);
  const matches = (
    await prisma.match.findMany({
      where: { seasonId: season.id, id: { in: [...matchIds] } },
      select: BOARD_MATCH_SELECT,
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    })
  ).filter((m) => standinAssignmentOpen(season.status, draftStatus, m.status));
  const needs = await needsFor(season, matches);
  return new Map(needs.map((n) => [offerKey(n.matchId, n.teamId), n]));
}

/** One game on the board, as the callouts name it. */
export type StandinBoardSummaryNeed = Pick<
  StandinBoardNeed,
  | "matchId"
  | "teamId"
  | "teamName"
  | "opponentName"
  | "scheduledAt"
  | "seats"
>;

/** How many games need a standin, and the soonest, for a one-line callout. */
export type StandinBoardSummary = {
  count: number;
  first: StandinBoardSummaryNeed | null;
  /**
   * Every game, soonest first. Home matches the viewer's own offers (read
   * fresh, never from this cache) against it.
   */
  needs: StandinBoardSummaryNeed[];
};

const SUMMARY_TTL_MS = 30_000;
// Per process, on purpose (Rule P): Home asks for this on every view by a
// visitor with no signup, signed out included, and the board is six reads.
// A count that is half a minute old is still the right thing to say.
const summaryMemo = new Map<
  string,
  { atMs: number; summary: Promise<StandinBoardSummary> }
>();

/**
 * The board as a count, reused for `SUMMARY_TTL_MS` per season and phase.
 * Only for callouts that say "N games need a standin": the Standins page and
 * every write read the board itself.
 */
export function loadStandinBoardSummary(
  season: { id: string; status: string; teamSize: number },
  nowMs: number,
): Promise<StandinBoardSummary> {
  const key = `${season.id}:${season.status}:${season.teamSize}`;
  const hit = summaryMemo.get(key);
  if (hit && nowMs - hit.atMs < SUMMARY_TTL_MS) return hit.summary;
  const summary = loadStandinBoard(season, nowMs).then(
    (all): StandinBoardSummary => {
      const needs = all.map((n) => ({
        matchId: n.matchId,
        teamId: n.teamId,
        teamName: n.teamName,
        opponentName: n.opponentName,
        scheduledAt: n.scheduledAt,
        seats: n.seats,
      }));
      return { count: needs.length, first: needs[0] ?? null, needs };
    },
  );
  summaryMemo.set(key, { atMs: nowMs, summary });
  // A failed read must not be served for the rest of the window.
  summary.catch(() => {
    if (summaryMemo.get(key)?.summary === summary) summaryMemo.delete(key);
  });
  return summary;
}

/** What the booking rules know about one viewer, for `standinOfferStanding`. */
export type StandinOfferViewer = {
  activeSignup: boolean;
  rostered: boolean;
  /** Signup MMR; 0 = unknown, or no signup. */
  mmr: number;
  commitments: StandinOfferCommitment[];
  /** `${matchId}:${teamId}` for every list they are on. */
  offered: ReadonlySet<string>;
};

const offerKey = (matchId: string, teamId: string) => `${matchId}:${teamId}`;

/** The viewer's signup, seat, bookings, waiting requests, declines and offers. */
export async function loadStandinOfferViewer(
  seasonId: string,
  userId: string,
): Promise<StandinOfferViewer> {
  const unplayed = { seasonId, status: { not: MATCH_STATUS.COMPLETED } };
  const slot = {
    select: {
      scheduledAt: true,
      week: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  } as const;
  const [signup, seat, bookings, requests, offers] = await Promise.all([
    prisma.registration.findUnique({
      where: { seasonId_userId: { seasonId, userId } },
      select: { status: true, mmr: true },
    }),
    prisma.teamMember.findUnique({
      where: { seasonId_userId: { seasonId, userId } },
      select: { id: true },
    }),
    prisma.standinAssignment.findMany({
      where: { standinUserId: userId, match: unplayed },
      select: { matchId: true, teamId: true, match: slot },
    }),
    prisma.standinRequest.findMany({
      where: {
        standinUserId: userId,
        status: {
          in: [STANDIN_REQUEST_STATUS.PENDING, STANDIN_REQUEST_STATUS.DECLINED],
        },
        match: unplayed,
      },
      select: { matchId: true, teamId: true, status: true, match: slot },
    }),
    prisma.standinOffer.findMany({
      where: { userId, match: unplayed },
      select: { matchId: true, teamId: true },
    }),
  ]);
  const commitment = (
    row: (typeof bookings)[number],
    kind: StandinOfferCommitment["kind"],
  ): StandinOfferCommitment => ({
    matchId: row.matchId,
    teamId: row.teamId,
    scheduledAt: row.match.scheduledAt,
    week: row.match.week,
    homeName: row.match.homeTeam.name,
    awayName: row.match.awayTeam.name,
    kind,
  });
  const activeSignup = signup?.status === REGISTRATION_STATUS.ACTIVE;
  return {
    activeSignup,
    rostered: !!seat,
    mmr: activeSignup ? (signup?.mmr ?? 0) : 0,
    commitments: [
      ...bookings.map((b) => commitment(b, "booked")),
      ...requests.map((r) =>
        commitment(
          r,
          r.status === STANDIN_REQUEST_STATUS.PENDING ? "asked" : "declined",
        ),
      ),
    ],
    offered: new Set(offers.map((o) => offerKey(o.matchId, o.teamId))),
  };
}

/** Where `viewer` (null = signed out) stands on one need. */
export function standingOn(
  need: StandinBoardNeed,
  viewer: StandinOfferViewer | null,
): StandinOfferStanding {
  return standinOfferStanding({
    signedIn: !!viewer,
    activeSignup: viewer?.activeSignup ?? false,
    rostered: viewer?.rostered ?? false,
    mmr: viewer?.mmr ?? 0,
    offered: viewer?.offered.has(offerKey(need.matchId, need.teamId)) ?? false,
    need,
    commitments: viewer?.commitments ?? [],
  });
}

export type StandinOfferResult =
  | { ok: false; error: string }
  | {
      ok: true;
      message: string;
      /**
       * Set when the offer is new: the post for that side's captain, and the
       * throttle key the action claims before sending it. A second tap, or
       * an offer that was already there, posts nothing.
       */
      post?: {
        announcement: string;
        mentions: MentionAllowlist | undefined;
        throttleKey: string;
      };
    };

/** The first offer for a side per kickoff pings its captain; see the action. */
function offerPingKey(matchId: string, teamId: string, revision: number) {
  return `standinOfferPing:${matchId}:${teamId}:${revision}`;
}

/**
 * A standin says "I can play" for one side of a match. Refused wherever a
 * booking of them would be (`standinOfferStanding`) and where the side needs
 * nobody, so the list only ever holds people the captain could book. An
 * offer over the MMR allowance is taken: the captain's pick then asks the
 * other captain, as it would from the pool.
 */
export async function offerToStandIn(opts: {
  matchId: string;
  teamId: string;
  userId: string;
}): Promise<StandinOfferResult> {
  const { matchId, teamId, userId } = opts;
  if (!matchId || !teamId) return { ok: false, error: "Pick a game" };
  const season = await getActiveSeason();
  if (!season) return { ok: false, error: "No active season" };
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: BOARD_MATCH_SELECT,
  });
  if (!match || match.seasonId !== season.id)
    return { ok: false, error: "That game isn't in the current season" };
  if (teamId !== match.homeTeamId && teamId !== match.awayTeamId)
    return { ok: false, error: "That team isn't in this match" };
  const draftStatus = await getSeasonDraftStatus(season.id);
  if (!standinAssignmentOpen(season.status, draftStatus, match.status)) {
    return {
      ok: false,
      error:
        match.status === MATCH_STATUS.COMPLETED
          ? "This match is already played"
          : "Standins aren't being booked right now",
    };
  }
  const [needs, viewer, standin] = await Promise.all([
    needsFor(season, [match]),
    loadStandinOfferViewer(season.id, userId),
    prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
  ]);
  const need = needs.find((n) => n.teamId === teamId);
  if (!need) {
    const team = teamId === match.homeTeamId ? match.homeTeam : match.awayTeam;
    return {
      ok: false,
      error: `${team.name} has its cover for this match now. Thanks for offering!`,
    };
  }
  const standing = standingOn(need, viewer);
  if (standing.kind === "no-signup") {
    return {
      ok: false,
      error:
        "Register as a standin first (on your account page), then say you can play.",
    };
  }
  if (standing.kind === "blocked") return { ok: false, error: standing.reason };
  if (standing.kind === "offered") {
    return { ok: true, message: `You're already on the list for ${need.teamName}.` };
  }
  if (standing.kind !== "open") return { ok: false, error: "Sign in required" };

  try {
    await prisma.standinOffer.create({ data: { matchId, teamId, userId } });
  } catch (e) {
    // Two taps: the unique key keeps one row, and the second is just "in".
    if (isUniqueViolation(e)) {
      return { ok: true, message: `You're already on the list for ${need.teamName}.` };
    }
    throw e;
  }
  return {
    ok: true,
    message: standinOfferedToast(need.teamName),
    post: {
      announcement: standinOfferedMessage({
        standinName: standin?.name ?? "A standin",
        standinMmr: viewer.mmr,
        teamName: need.teamName,
        homeName: need.homeName,
        awayName: need.awayName,
        week: need.week,
        isPlayoff: isPlayoffPhase(need.phase),
        isTiebreaker: need.phase === MATCH_PHASE.TIEBREAKER,
        roundLabel: need.roundLabel,
        whenMs: need.scheduledAt?.getTime() ?? null,
        matchId,
      }),
      mentions: await mentionUsers([need.captainId]),
      throttleKey: offerPingKey(matchId, teamId, match.scheduleRevision),
    },
  };
}

/**
 * Take an offer back. Cleanup, so it is legal in every phase and on a played
 * match, and a row already gone (booked, or a second tap) is not an error.
 */
export async function withdrawStandinOffer(opts: {
  matchId: string;
  teamId: string;
  userId: string;
}): Promise<{ ok: true; message: string }> {
  const gone = await prisma.standinOffer.deleteMany({
    where: { matchId: opts.matchId, teamId: opts.teamId, userId: opts.userId },
  });
  return {
    ok: true,
    message:
      gone.count > 0
        ? "You're off the list for that game."
        : "You weren't on that list any more.",
  };
}
