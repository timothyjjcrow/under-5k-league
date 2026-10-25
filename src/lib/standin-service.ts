import { fixtureLogLabel } from "./admin-log-copy";
import { isPlayoffPhase } from "./league-lifecycle";
import { Prisma, type Season } from "@prisma/client";
import { prisma } from "./prisma";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  SEASON_STATUS,
  STANDIN_REQUEST_STATUS,
} from "./constants";
import { getActiveSeason } from "./season";
import {
  standinApprovalRequestedMessage,
  standinAssignedMessage,
  standinRemovedMessage,
  standinRequestCancelledMessage,
  standinRequestDeclinedMessage,
  type MentionAllowlist,
  type StandinRequestCancelReason,
} from "./discord";
import { mentionsOf } from "./discord-mentions";
import { AVAILABILITY } from "./availability";
import {
  agreeTooLateError,
  coverBaselineMmr,
  namedCoverBaseline,
  standinApprovalReason,
  standinConflict,
  standinDeclinedError,
  standinNeedsApproval,
  type LowerOutPlayer,
} from "./standin";
import { isSerializationConflict } from "./prisma-errors";
import { roundLabelsForPost } from "./playoff-rounds";
import { raceHook } from "./race-hook";

/**
 * A precondition re-checked INSIDE the assign transaction stopped holding.
 * Thrown, never returned — the callback resolving would commit the assignment
 * it exists to prevent.
 */
class StandinRaceError extends Error {}

/**
 * A booking check `recheckCover` re-ran inside the transaction failed: the
 * seat, the signup or the night moved. Agreeing words it for the approver
 * (`agreeTooLateError`); every other path shows it as it is.
 */
class CoverRecheckError extends StandinRaceError {}

// Standin assignment, captain-self-serve edition (reschedule-service pattern:
// the integration-tested guards live here; the thin actions add auth, toasts,
// and the best-effort Discord send). Previously admin-only — which made
// standin coverage the biggest weekly admin relay: OUT ping → captain DMs the
// admin → admin fills the form. Captains can now line up their own cover;
// `actingCaptainId: null` is the admin override (any team, same guards).

export type StandinServiceResult =
  | {
      ok: true;
      message: string;
      /**
       * One line for the admin activity log, with the names spelled out: the
       * log has no foreign keys, so an id written there can never be read back.
       */
      summary: string;
      /** The match's season, so the admin log files the entry under it. */
      seasonId: string;
      announcement: string;
      /** Who the announcement is FOR — the action passes it to the send. */
      mentions?: MentionAllowlist;
      /**
       * Whose Discord the announcement has to reach (the action's toast says
       * when it structurally can't): the standin for a booking, the other
       * captain for a request, the asking captain for a decline.
       */
      reachUserId?: string;
      /** A request for the other captain's OK was filed; nothing is booked. */
      pending?: true;
    }
  | { ok: false; error: string };

/**
 * Standins whose cover now CLASHES because a match moved.
 *
 * `standinConflict` was only ever consulted at assign time, and every retime
 * path (`setWeekNight`, `setMatchTime`, and a captain accepting a reschedule)
 * moves a fixture onto a night the assign-time check already approved. Nothing
 * re-checked, and nothing displayed it: a standin silently ended up booked for
 * two games at the same minute, invisible on every surface right up to kickoff.
 *
 * Refusing the retime would be the wrong fix — the retime is the legitimate
 * act and the cover is the stale thing — so this REPORTS instead, the same
 * shape `releasePlayer` uses for cover it declines to cancel by the back door.
 * Returns one line per clash, ready to append to a toast.
 */
export async function clashesAfterRetime(
  seasonId: string,
  matchIds: string[],
): Promise<string[]> {
  if (matchIds.length === 0) return [];
  const moved = await prisma.match.findMany({
    where: { id: { in: matchIds } },
    select: {
      id: true,
      scheduledAt: true,
      week: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      standins: { select: { standinUserId: true } },
    },
  });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of moved) {
    for (const a of m.standins) {
      const others = await findClashingCover(prisma, {
        matchId: m.id,
        standinUserId: a.standinUserId,
        seasonId,
      });
      const clash = others.find((o) => standinConflict(m, o.match));
      if (!clash) continue;
      // One line per standin per pair, whichever direction we meet it from.
      const key = [a.standinUserId, ...[m.id, clash.matchId].sort()].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      const who = await prisma.user.findUnique({
        where: { id: a.standinUserId },
        select: { name: true },
      });
      out.push(
        `${who?.name ?? "A standin"} now covers both ${m.homeTeam.name} v ${m.awayTeam.name} and ${clash.match.homeTeam.name} v ${clash.match.awayTeam.name}`,
      );
    }
  }
  return out;
}

/** Cover this standin already owes on OTHER unplayed matches this season. */
async function findClashingCover(
  db: Pick<typeof prisma, "standinAssignment">,
  opts: { matchId: string; standinUserId: string; seasonId: string },
) {
  return db.standinAssignment.findMany({
    where: {
      standinUserId: opts.standinUserId,
      matchId: { not: opts.matchId },
      match: {
        seasonId: opts.seasonId,
        status: { not: MATCH_STATUS.COMPLETED },
      },
    },
    include: {
      match: {
        select: {
          scheduledAt: true,
          week: true,
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      },
    },
  });
}

function clashError(
  standinName: string | undefined,
  clash: { match: { homeTeam: { name: string }; awayTeam: { name: string } } },
): string {
  const who = standinName ?? "That standin";
  return `${who} is already covering ${clash.match.homeTeam.name} vs ${clash.match.awayTeam.name} that night — they can't play both. Remove that assignment first.`;
}

/**
 * A pending StandinRequest as the match page's Standins card and /admin's
 * standin block show it: who asked, for whom, and the MMRs it was asked on.
 */
export const STANDIN_REQUEST_VIEW = {
  standin: { select: { name: true } },
  replaced: { select: { name: true } },
  requestedBy: { select: { name: true } },
  // The lower teammate who said they're out, when they set the baseline.
  baselinePlayer: { select: { name: true } },
} satisfies Prisma.StandinRequestInclude;

export type StandinRequestView = Prisma.StandinRequestGetPayload<{
  include: typeof STANDIN_REQUEST_VIEW;
}>;

/** The match fields every cover check reads, loaded once. */
const COVER_MATCH_INCLUDE = {
  games: { select: { id: true } },
  homeTeam: { select: { name: true, captainId: true } },
  awayTeam: { select: { name: true, captainId: true } },
} satisfies Prisma.MatchInclude;

type CoverMatch = Prisma.MatchGetPayload<{
  include: typeof COVER_MATCH_INCLUDE;
}>;

/** Who would cover which seat in which match. */
type CoverTarget = {
  matchId: string;
  standinUserId: string;
  /** The covered player, or null for an EMPTY seat (`teamId` says whose). */
  replacingUserId: string | null;
  teamId?: string;
};

/** What the read-time checks learned about a cover they allowed. */
type JudgedCover = {
  season: Season;
  match: CoverMatch;
  /** The standin's signup MMR; 0 = unknown. */
  standinMmr: number;
  standinUser: { name: string; discordId: string | null } | null;
  coverTeamId: string;
  coverTeamName: string;
  coverTeamCaptainId: string;
  replacedName: string | null;
  /** The covered player's signup MMR; null when there's no signup. */
  replacedMmr: number | null;
  /** How to swap a taken seat, honest about a series already under way. */
  swapHint: string;
};

/** A request that isn't this one: an approval must not trip over itself. */
function otherThan(requestId: string | undefined) {
  return requestId ? { not: requestId } : undefined;
}

/**
 * Every read-time check a booking must pass, shared by a captain's or an
 * admin's booking, a captain's request for the other captain's OK, and the
 * other captain agreeing to one. A PENDING request holds its seat and its
 * standin in this match, exactly as a booking does; `excludeRequestId` is the
 * request being agreed to, which must not block itself.
 */
async function judgeCover(
  target: CoverTarget,
  opts: { actingCaptainId: string | null; excludeRequestId?: string },
): Promise<{ ok: true; cover: JudgedCover } | { ok: false; error: string }> {
  const { matchId, standinUserId, replacingUserId } = target;
  const { actingCaptainId } = opts;
  const notThis = otherThan(opts.excludeRequestId);
  if (!matchId || !standinUserId)
    return { ok: false, error: "Pick a standin" };
  if (!replacingUserId && !target.teamId)
    return {
      ok: false,
      error: "Pick the player they cover, or the team whose seat they fill",
    };
  if (standinUserId === replacingUserId)
    return { ok: false, error: "A player can't stand in for themselves" };

  const season = await getActiveSeason();
  if (!season) return { ok: false, error: "No active season" };
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: COVER_MATCH_INCLUDE,
  });
  if (!match) return { ok: false, error: "Unknown match" };
  // Every lookup below keys on the ACTIVE season — an archived season's
  // unplayed match (reactivation, early season turnover) would pass each
  // guard with misleading cross-season errors, so refuse it up front.
  if (match.seasonId !== season.id) {
    return {
      ok: false,
      error: "This match belongs to an archived season — standins apply to the active season only",
    };
  }
  if (match.status === MATCH_STATUS.COMPLETED)
    return { ok: false, error: "This match is already played" };

  // PHASE GATE (read-time, the signFreeAgent shape — phase flips are slow
  // admin acts), judged AFTER the archived/completed checks so the more
  // specific refusal always wins. Cover is a statement about a SETTLED
  // roster: during SIGNUPS and a running auction the rosters are still
  // forming, so a booking made there survives into whatever the draft
  // produces — the re-run-auction case, where a stale empty-seat cover
  // inflates a freshly drafted side to six. COMPLETE has nothing left to
  // cover. The one DRAFT-phase window that stays open is draft COMPLETE
  // (pool-dry short rosters arranging their week-1 cover — the reason empty
  // seats exist). Removal is deliberately NOT gated: clearing stale cover is
  // legal cleanup in every phase.
  if (season.status === SEASON_STATUS.SIGNUPS) {
    return {
      ok: false,
      error:
        "Standins cover matches for drafted rosters — run the draft before arranging cover",
    };
  }
  if (season.status === SEASON_STATUS.COMPLETE) {
    return { ok: false, error: "The season is over — there's nothing left to cover" };
  }
  if (season.status === SEASON_STATUS.DRAFT) {
    const draftRow = await prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true },
    });
    if (draftRow?.status !== DRAFT_STATUS.COMPLETE) {
      // Keyed on STATUS, not row existence: a post-abort season carries a
      // NOT_STARTED row, and telling that admin "the draft is still running"
      // sends them hunting for an auction that isn't.
      const notRunYet =
        !draftRow || draftRow.status === DRAFT_STATUS.NOT_STARTED;
      return {
        ok: false,
        error: notRunYet
          ? "The auction hasn't run yet — standins cover drafted rosters"
          : "The draft is still running — arrange cover once rosters are locked",
      };
    }
  }

  // The standin must be a real signup who ISN'T on a roster this season — a
  // rostered player covering another team would land in BOTH account sets on
  // import, mis-crediting their box-score lines (a "double agent").
  const [standinReg, standinRoster, standinUser] = await Promise.all([
    prisma.registration.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: standinUserId } },
    }),
    prisma.teamMember.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: standinUserId } },
    }),
    prisma.user.findUnique({
      where: { id: standinUserId },
      // discordId rides along so the announcement can mention the standin
      // without a second query — see the mentions on the return below.
      select: { name: true, discordId: true },
    }),
  ]);
  if (!standinReg || standinReg.status !== REGISTRATION_STATUS.ACTIVE)
    return { ok: false, error: "That standin has no active signup this season" };
  if (standinRoster)
    return { ok: false, error: "That player is on a roster — they can't stand in" };

  // WHICH TEAM is the standin filling for? Normally the replaced player's own
  // roster answers it. For an empty seat there is no replaced player, so the
  // caller names the team and we validate it the same way.
  let coverTeamId: string;
  let coverTeamName: string;
  let coverTeamCaptainId: string;
  let replacedName: string | null = null;
  // The replaced player's registration MMR: the yardstick for the standin
  // MMR rule. 0/missing reads as unknown.
  let replacedMmr: number | null = null;

  if (replacingUserId) {
    const [membership, replacedReg] = await Promise.all([
      prisma.teamMember.findUnique({
        where: {
          seasonId_userId: { seasonId: season.id, userId: replacingUserId },
        },
        include: {
          team: { select: { captainId: true, name: true } },
          user: { select: { name: true } },
        },
      }),
      prisma.registration.findUnique({
        where: {
          seasonId_userId: { seasonId: season.id, userId: replacingUserId },
        },
        select: { mmr: true },
      }),
    ]);
    if (!membership)
      return { ok: false, error: "Replaced player is not on a team" };
    replacedMmr = replacedReg?.mmr ?? null;
    if (
      membership.teamId !== match.homeTeamId &&
      membership.teamId !== match.awayTeamId
    ) {
      return { ok: false, error: "That player's team isn't in this match" };
    }
    coverTeamId = membership.teamId;
    coverTeamName = membership.team.name;
    coverTeamCaptainId = membership.team.captainId;
    replacedName = membership.user.name;
  } else {
    const teamId = target.teamId as string;
    if (teamId !== match.homeTeamId && teamId !== match.awayTeamId) {
      return { ok: false, error: "That team isn't in this match" };
    }
    const team = await prisma.team.findFirst({
      where: { id: teamId, seasonId: season.id },
      select: {
        name: true,
        captainId: true,
        _count: { select: { members: true } },
      },
    });
    if (!team) return { ok: false, error: "Unknown team" };
    // An "empty seat" has to actually BE empty. Without this, filling a full
    // roster's imaginary seat would put SIX players on the side: unlike the
    // replacement case, nobody is removed to make room, so the count feeds
    // straight through matchNightRoster into /schedule, the dashboard strip,
    // the Discord week reminder and the import account sets.
    const emptySeats = season.teamSize - team._count.members;
    if (emptySeats <= 0) {
      return {
        ok: false,
        error: `${team.name} has a full roster — pick the player being covered instead`,
      };
    }
    // …and one standin per empty seat, no more. A request waiting for the
    // other captain holds a seat too.
    const [filled, asked] = await Promise.all([
      prisma.standinAssignment.count({
        where: { matchId, teamId, replacingUserId: null },
      }),
      prisma.standinRequest.count({
        where: {
          matchId,
          teamId,
          replacingUserId: null,
          status: STANDIN_REQUEST_STATUS.PENDING,
          id: notThis,
        },
      }),
    ]);
    if (filled >= emptySeats) {
      return {
        ok: false,
        error: `${team.name}'s ${emptySeats} open seat(s) are already covered for this match`,
      };
    }
    if (filled + asked >= emptySeats) {
      return { ok: false, error: openSeatAskedError(team.name) };
    }
    coverTeamId = teamId;
    coverTeamName = team.name;
    coverTeamCaptainId = team.captainId;
  }

  // Captains manage their OWN roster's cover; the other side is not theirs.
  if (actingCaptainId && coverTeamCaptainId !== actingCaptainId) {
    return {
      ok: false,
      error: "Only that team's captain (or an admin) can assign this standin",
    };
  }

  // One standin covers one seat in one match — assigning the same person to
  // both sides (or twice) would double-count their stats on import. And one
  // SEAT takes one standin: a second cover for the same player would inflate
  // the match-night roster (6-player check-in counts) and the import account
  // sets — remove the first assignment to swap standins.
  const [already, standinAsked, seatTaken, seatAsked, otherNights] =
    await Promise.all([
      prisma.standinAssignment.findFirst({ where: { matchId, standinUserId } }),
      prisma.standinRequest.findFirst({
        where: {
          matchId,
          standinUserId,
          status: STANDIN_REQUEST_STATUS.PENDING,
          id: notThis,
        },
        select: { id: true },
      }),
      // Only meaningful when a NAMED player is being covered. With a null
      // replacingUserId this query would match every other empty-seat
      // assignment in the match and refuse the second one wrongly — the
      // open-seat budget above is what limits those.
      replacingUserId
        ? prisma.standinAssignment.findFirst({
            where: { matchId, replacingUserId },
            include: { standin: { select: { name: true } } },
          })
        : Promise.resolve(null),
      replacingUserId
        ? prisma.standinRequest.findFirst({
            where: {
              matchId,
              replacingUserId,
              status: STANDIN_REQUEST_STATUS.PENDING,
              id: notThis,
            },
            include: { standin: { select: { name: true } } },
          })
        : Promise.resolve(null),
      findClashingCover(prisma, { matchId, standinUserId, seasonId: season.id }),
    ]);
  if (already)
    return { ok: false, error: "That standin is already assigned to this match" };
  if (standinAsked) return { ok: false, error: STANDIN_ASKED_ERROR };
  // "Remove that assignment first" is only honest advice while the series
  // hasn't started — once a game imports, removeStandinGuarded refuses the
  // removal, so pointing at it sends the captain in a circle. Mid-series the
  // truthful answer is that the booking is settled: whoever actually plays
  // the remaining games is what the imports record.
  const swapHint =
    match.games.length > 0
      ? "the series has already started, so the booking can't be swapped — the remaining games record whoever actually plays"
      : "remove that assignment first to swap";
  if (seatTaken)
    return {
      ok: false,
      error: `${replacedName} is already covered by ${seatTaken.standin.name} — ${swapHint}`,
    };
  if (seatAsked)
    return {
      ok: false,
      error: seatAskedError(replacedName, seatAsked.standin.name),
    };
  const clash = otherNights.find((o) => standinConflict(match, o.match));
  if (clash)
    return { ok: false, error: clashError(standinUser?.name, clash) };

  return {
    ok: true,
    cover: {
      season,
      match,
      standinMmr: standinReg.mmr,
      standinUser,
      coverTeamId,
      coverTeamName,
      coverTeamCaptainId,
      replacedName,
      replacedMmr,
      swapHint,
    },
  };
}

const STANDIN_ASKED_ERROR =
  "That standin is already waiting for the other captain's OK in this match — that request has to be answered or cancelled first";

function seatAskedError(replacedName: string | null, standinName: string) {
  return `${replacedName}'s seat is waiting for the other captain's OK on ${standinName} — that request has to be answered or cancelled first`;
}

function openSeatAskedError(teamName: string) {
  return `${teamName}'s open seat is waiting for the other captain's OK on a standin — that request has to be answered or cancelled first`;
}

/**
 * Re-assert, INSIDE the caller's Serializable transaction, everything
 * judgeCover checked that a rival could change. Throws StandinRaceError,
 * never returns a refusal: past a write the callback resolving would commit.
 */
async function recheckCover(
  tx: Prisma.TransactionClient,
  target: CoverTarget,
  cover: JudgedCover,
  excludeRequestId?: string,
): Promise<void> {
  const { matchId, standinUserId, replacingUserId } = target;
  const { season, match, coverTeamId, coverTeamName, replacedName } = cover;
  const notThis = otherThan(excludeRequestId);
  // EVERY precondition is re-read in here, not just the registration.
  // Two reasons, both load-bearing:
  //
  // (1) Re-assertion. `already`, `seatTaken` and `standinRoster` were
  // read above, outside this transaction, and StandinAssignment has NO
  // unique constraint (only @@index([matchId])) — so nothing but these
  // reads stops two concurrent assigns double-covering one seat, which
  // inflates the match-night roster to six and double-counts the
  // standin's box-score lines on import.
  //
  // (2) SSI needs them in this transaction's READ SET. Serializable
  // detects a write-skew cycle only across what each side actually read;
  // re-reading only the Registration left the assign-vs-signFreeAgent
  // pair with no cycle to detect, so both could commit and a rostered
  // player could hold live cover.
  const [
    fresh,
    rostered,
    replacedSeat,
    already,
    standinAsked,
    seatTaken,
    otherNights,
  ] = await Promise.all([
    tx.registration.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: standinUserId } },
      select: { status: true },
    }),
    tx.teamMember.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: standinUserId } },
      select: { id: true },
    }),
    // The REPLACED player's seat, re-read for the same two reasons as the
    // rest: releasePlayer deletes it and CANCELS the cover in one
    // transaction, so an assign racing a release could recreate exactly
    // the stale-cover row that cleanup exists to prevent (the inflated
    // six-player side); and it has to sit in this transaction's READ SET
    // so SSI can see the assign-vs-release cycle at all — release reads
    // the assignments and writes the TeamMember, this reads the
    // TeamMember and writes an assignment.
    replacingUserId
      ? tx.teamMember.findUnique({
          where: {
            seasonId_userId: {
              seasonId: season.id,
              userId: replacingUserId,
            },
          },
          select: { teamId: true },
        })
      : Promise.resolve(undefined),
    tx.standinAssignment.findFirst({ where: { matchId, standinUserId } }),
    tx.standinRequest.findFirst({
      where: {
        matchId,
        standinUserId,
        status: STANDIN_REQUEST_STATUS.PENDING,
        id: notThis,
      },
      select: { id: true },
    }),
    replacingUserId
      ? Promise.all([
          tx.standinAssignment.findFirst({
            where: { matchId, replacingUserId },
            include: { standin: { select: { name: true } } },
          }),
          tx.standinRequest.findFirst({
            where: {
              matchId,
              replacingUserId,
              status: STANDIN_REQUEST_STATUS.PENDING,
              id: notThis,
            },
            include: { standin: { select: { name: true } } },
          }),
        ]).then(([taken, asked]) =>
          taken
            ? `${replacedName} is already covered by ${taken.standin.name} — ${cover.swapHint}`
            : asked
              ? seatAskedError(replacedName, asked.standin.name)
              : null,
        )
      : // The empty-seat equivalent: re-assert the OPEN SEAT BUDGET in the
        // read set, so two concurrent assigns can't both fill the last one
        // and put six players on the side. A pending request holds a seat.
        //
        // Sabotage-tested honestly (2026-08-02): deleting ONLY this
        // re-read stays green under standins-raced.itest.ts, because the
        // `already` findFirst's SIREAD range on the matchId index
        // incidentally conflicts with the rival's insert — belt-and-
        // braces under the CURRENT query plan, kept because a plan is
        // not a guarantee. Dropping the Serializable isolation level is
        // what the raced tests fail on, deterministically.
        Promise.all([
          tx.standinAssignment.count({
            where: { matchId, teamId: coverTeamId, replacingUserId: null },
          }),
          tx.standinRequest.count({
            where: {
              matchId,
              teamId: coverTeamId,
              replacingUserId: null,
              status: STANDIN_REQUEST_STATUS.PENDING,
              id: notThis,
            },
          }),
          tx.team.findUnique({
            where: { id: coverTeamId },
            select: { _count: { select: { members: true } } },
          }),
        ]).then(([filled, asked, seats]) => {
          const open =
            season.teamSize - (seats?._count.members ?? season.teamSize);
          return filled >= open
            ? `${coverTeamName}'s open seat(s) are already covered for this match`
            : filled + asked >= open
              ? openSeatAskedError(coverTeamName)
              : null;
        }),
    // Same reasoning as the other re-reads: two concurrent assigns for
    // the same standin on two fixtures the same night would each see a
    // clear field outside the transaction.
    findClashingCover(tx, { matchId, standinUserId, seasonId: season.id }),
  ]);
  if (!fresh || fresh.status !== REGISTRATION_STATUS.ACTIVE)
    throw new CoverRecheckError("That standin has no active signup this season");
  if (rostered)
    throw new CoverRecheckError(
      "That player is on a roster — they can't stand in",
    );
  if (replacingUserId && replacedSeat?.teamId !== coverTeamId)
    throw new CoverRecheckError(
      `${replacedName} just left that roster — reload and pick again`,
    );
  if (already)
    throw new CoverRecheckError(
      "That standin is already assigned to this match",
    );
  if (standinAsked) throw new CoverRecheckError(STANDIN_ASKED_ERROR);
  if (seatTaken) throw new CoverRecheckError(seatTaken);
  const clash = otherNights.find((o) => standinConflict(match, o.match));
  if (clash)
    throw new CoverRecheckError(clashError(cover.standinUser?.name, clash));
}

/**
 * The MMR the standin rule measures this cover against. Named cover: the
 * covered player's, or a lower teammate's who checked in OUT for this kickoff
 * and has no cover booked or asked for (`namedCoverBaseline`, which says
 * who). An empty seat: the lowest on the team (`coverBaselineMmr`).
 */
async function coverBaseline(
  target: CoverTarget,
  cover: JudgedCover,
): Promise<{ baselineMmr: number | null; lowerOut: LowerOutPlayer | null }> {
  if (target.replacingUserId) {
    const replacedUserId = target.replacingUserId;
    const teammates = await prisma.teamMember.findMany({
      where: { teamId: cover.coverTeamId, userId: { not: replacedUserId } },
      select: { userId: true, user: { select: { name: true } } },
    });
    const ids = teammates.map((m) => m.userId);
    const [out, regs, booked, asked] = await Promise.all([
      // This kickoff's answers only: a retime bumps scheduleRevision, and an
      // older answer was for a night nobody is playing.
      prisma.matchAvailability.findMany({
        where: {
          matchId: target.matchId,
          userId: { in: ids },
          status: AVAILABILITY.OUT,
          scheduleRevision: cover.match.scheduleRevision,
        },
        select: { userId: true },
      }),
      prisma.registration.findMany({
        where: { seasonId: cover.season.id, userId: { in: ids } },
        select: { userId: true, mmr: true },
      }),
      prisma.standinAssignment.findMany({
        where: { matchId: target.matchId, replacingUserId: { in: ids } },
        select: { replacingUserId: true },
      }),
      prisma.standinRequest.findMany({
        where: {
          matchId: target.matchId,
          replacingUserId: { in: ids },
          status: STANDIN_REQUEST_STATUS.PENDING,
        },
        select: { replacingUserId: true },
      }),
    ]);
    const mmrOf = new Map(regs.map((r) => [r.userId, r.mmr]));
    return namedCoverBaseline({
      replaced: { userId: replacedUserId, mmr: cover.replacedMmr },
      teammates: teammates.map((m) => ({
        userId: m.userId,
        name: m.user.name,
        mmr: mmrOf.get(m.userId) ?? 0,
      })),
      outUserIds: new Set(out.map((row) => row.userId)),
      coveredUserIds: new Set(
        [...booked, ...asked].flatMap((row) =>
          row.replacingUserId ? [row.replacingUserId] : [],
        ),
      ),
    });
  }
  const members = await prisma.teamMember.findMany({
    where: { teamId: cover.coverTeamId },
    select: { userId: true },
  });
  const regs = await prisma.registration.findMany({
    where: {
      seasonId: cover.season.id,
      userId: { in: members.map((m) => m.userId) },
    },
    select: { mmr: true },
  });
  return {
    baselineMmr: coverBaselineMmr({ rosterMmrs: regs.map((r) => r.mmr) }),
    lowerOut: null,
  };
}

/** One side of the match, with its captain. */
function side(match: CoverMatch, teamId: string) {
  return teamId === match.homeTeamId
    ? { id: match.homeTeamId, ...match.homeTeam }
    : { id: match.awayTeamId, ...match.awayTeam };
}

/** The match's other side: the team whose captain agrees to a request. */
function otherSide(match: CoverMatch, coverTeamId: string) {
  return side(
    match,
    coverTeamId === match.homeTeamId ? match.awayTeamId : match.homeTeamId,
  );
}

function fixtureFacts(match: CoverMatch) {
  return {
    homeName: match.homeTeam.name,
    awayName: match.awayTeam.name,
    week: match.week,
    isPlayoff: isPlayoffPhase(match.phase),
    isTiebreaker: match.phase === MATCH_PHASE.TIEBREAKER,
  };
}

function coverLogLabel(match: CoverMatch) {
  return fixtureLogLabel({
    ...match,
    homeName: match.homeTeam.name,
    awayName: match.awayTeam.name,
  });
}

export async function assignStandinGuarded(opts: {
  matchId: string;
  standinUserId: string;
  /**
   * The rostered player being covered, or NULL to fill an EMPTY SEAT on a short
   * roster — in which case `teamId` says which side.
   *
   * The empty-seat case is why a 4-of-5 team could not be covered at all.
   * `matchNightRoster` has always kept a null-replacement assignment (it adds a
   * player without removing one) and CLAUDE.md documented it as working, but
   * nothing could ever CREATE one: this parameter was typed `string` and the
   * guard below refused empty. So the one roster state that most needs cover —
   * a team that lost a player mid-season — was the one state with no way to
   * arrange it.
   */
  replacingUserId: string | null;
  /** Required when `replacingUserId` is null: which team's seat is being filled. */
  teamId?: string;
  /** null = admin (either team); a userId must captain the covered team. */
  actingCaptainId: string | null;
  /**
   * Who pressed the button (defaults to actingCaptainId). The covered team's
   * captain is mentioned unless they are the one acting.
   */
  actingUserId?: string;
  /**
   * A standin the MMR rule doesn't let a captain lock in alone
   * (`standinNeedsApproval`): "ask" files a StandinRequest for the other
   * captain instead of booking; "book" books anyway, which is the admin
   * panel's ruling. Defaults to "ask" for a captain and "book" for an admin;
   * the captain's card always asks, even when its captain is an admin.
   */
  overLimit?: "ask" | "book";
}): Promise<StandinServiceResult> {
  const { matchId, standinUserId, replacingUserId, actingCaptainId } = opts;
  const target: CoverTarget = {
    matchId,
    standinUserId,
    replacingUserId,
    teamId: opts.teamId,
  };
  const judged = await judgeCover(target, { actingCaptainId });
  if (!judged.ok) return judged;
  const cover = judged.cover;
  const { match, standinUser } = cover;

  // The MMR rule is judged here, at read time, on purpose: a later MMR edit
  // never re-judges a booking, so an edit that lands mid-booking is the same
  // history as one landing just after it. The transaction re-reads only what
  // a rival can make wrong (the seat, the signup, the night).
  const { baselineMmr, lowerOut } = await coverBaseline(target, cover);
  const overRule = standinNeedsApproval(cover.standinMmr, baselineMmr);
  const overLimit = opts.overLimit ?? (actingCaptainId ? "ask" : "book");
  if (overRule && overLimit === "ask") {
    const requestedById = opts.actingUserId ?? actingCaptainId;
    if (!requestedById) return { ok: false, error: "Sign in required" };
    return requestStandinApproval(target, cover, {
      baselineMmr,
      lowerOut,
      requestedById,
    });
  }

  // SERIALIZABLE, not a plain create: this and a WITHDRAWAL of the same standin
  // are a write-skew pair. Assign reads the standin's Registration and writes a
  // StandinAssignment; withdraw reads the assignments and writes the
  // Registration. Under read-committed both read stale state and both commit, so
  // the season ends up with a WITHDRAWN standin holding live cover — the team
  // looks staffed on match night by somebody who has left. Serializable makes
  // one of the pair fail with P2034; the withdraw paths use the same isolation,
  // which they must, since SSI only detects the cycle when every participant is
  // serializable. Re-reading the registration INSIDE the transaction is what
  // puts it in this transaction's read set.
  try {
    await prisma.$transaction(
      async (tx) => {
        await recheckCover(tx, target, cover);
        await tx.standinAssignment.create({
          data: {
            matchId,
            teamId: cover.coverTeamId,
            standinUserId,
            replacingUserId,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof StandinRaceError) return { ok: false, error: e.message };
    if (isSerializationConflict(e))
      return {
        ok: false,
        error: "That standin's signup just changed — check it and try again",
      };
    throw e;
  }

  // Only an admin's booking gets here over the rule. Say so in the toast and
  // the log, so the ruling is on the record.
  const overNote = overRule
    ? `booked over the standin MMR rule (${standinApprovalReason({
        standinMmr: cover.standinMmr,
        baselineMmr,
        emptySeat: replacingUserId === null,
        lowerOutName: lowerOut?.name,
      })}) without the other captain's OK`
    : null;
  return {
    ok: true,
    message:
      "Standin assigned" +
      (match.games.length > 0
        ? " — heads up: already-imported games keep their original attribution"
        : "") +
      (overNote ? ` — ${overNote}` : ""),
    summary: `Assigned ${standinUser?.name ?? "a standin"} to cover ${
      cover.replacedName ?? "an open seat"
    } for ${cover.coverTeamName} in ${coverLogLabel(match)}${
      overNote ? ` — ${overNote}` : ""
    }`,
    seasonId: match.seasonId,
    reachUserId: standinUserId,
    // Being assigned is the single most action-demanding event a standin can
    // get — the action layer posts this so they hear about it without
    // happening to visit the site. Which is why it MENTIONS them: a plain
    // channel line about a game they're now expected at is exactly the
    // message that must not depend on them scrolling back.
    // When someone else booked it (an admin), the captain who was told to
    // line up cover is mentioned too, so they know it's handled. A captain
    // booking their own cover isn't pinged about their own click.
    mentions: mentionsOf([
      standinUser?.discordId,
      await captainToNotify(
        cover.coverTeamCaptainId,
        opts.actingUserId ?? actingCaptainId,
      ),
    ]),
    announcement: standinAssignedMessage({
      standinName: standinUser?.name ?? "A standin",
      replacedName: cover.replacedName,
      teamName: cover.coverTeamName,
      ...fixtureFacts(match),
      // Named by its round, like the OUT ping the booking answers.
      roundLabel: (await roundLabelsForPost([match])).get(match.id),
      whenMs: match.scheduledAt?.getTime() ?? null,
      matchId: match.id,
    }),
  };
}

/**
 * File a StandinRequest instead of a booking: the standin is more than
 * STANDIN_MMR_ALLOWANCE above the seat (or an MMR is unknown), so the other
 * captain has to agree first. It re-checks everything a booking would, in
 * the same Serializable shape, so a request is only ever filed for a seat
 * that could be booked, and two clicks can't file two.
 *
 * A standin the other captain already declined for this team in this match
 * can't be asked for again (an admin's booking from the panel still can):
 * otherwise a no is only a pause before the same ping. Checked in the
 * transaction, the one place it is enforced; a decline racing the ask is
 * either seen here or is still PENDING, which `recheckCover` refuses.
 */
async function requestStandinApproval(
  target: CoverTarget,
  cover: JudgedCover,
  ask: {
    baselineMmr: number | null;
    lowerOut: LowerOutPlayer | null;
    requestedById: string;
  },
): Promise<StandinServiceResult> {
  const { match, standinUser } = cover;
  const other = otherSide(match, cover.coverTeamId);
  const standinName = standinUser?.name ?? "The standin";
  try {
    await prisma.$transaction(
      async (tx) => {
        await recheckCover(tx, target, cover);
        const declined = await tx.standinRequest.findFirst({
          where: {
            matchId: target.matchId,
            teamId: cover.coverTeamId,
            standinUserId: target.standinUserId,
            status: STANDIN_REQUEST_STATUS.DECLINED,
          },
          select: { id: true },
        });
        if (declined) {
          throw new StandinRaceError(
            standinDeclinedError(other.name, standinUser?.name ?? "that standin"),
          );
        }
        await tx.standinRequest.create({
          data: {
            matchId: target.matchId,
            teamId: cover.coverTeamId,
            standinUserId: target.standinUserId,
            replacingUserId: target.replacingUserId,
            requestedById: ask.requestedById,
            standinMmr: cover.standinMmr,
            baselineMmr: ask.baselineMmr,
            baselineUserId: ask.lowerOut?.userId ?? null,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof StandinRaceError) return { ok: false, error: e.message };
    if (isSerializationConflict(e))
      return {
        ok: false,
        error: "That standin's signup just changed — check it and try again",
      };
    throw e;
  }

  const [requester, otherCaptain] = await Promise.all([
    prisma.user.findUnique({
      where: { id: ask.requestedById },
      select: { name: true },
    }),
    prisma.user.findUnique({
      where: { id: other.captainId },
      select: { name: true, discordId: true },
    }),
  ]);
  const reason = standinApprovalReason({
    standinMmr: cover.standinMmr,
    baselineMmr: ask.baselineMmr,
    emptySeat: target.replacingUserId === null,
    lowerOutName: ask.lowerOut?.name,
  });
  const otherName = otherCaptain?.name ?? `the ${other.name} captain`;
  return {
    ok: true,
    pending: true,
    message: `Asked ${otherName} (the ${other.name} captain) to agree, since ${reason}. ${standinName} is booked once they say yes`,
    summary: `Asked the ${other.name} captain to agree to ${standinName} covering ${
      cover.replacedName ?? "an open seat"
    } for ${cover.coverTeamName} in ${coverLogLabel(match)} (${reason})`,
    seasonId: match.seasonId,
    // The other captain is the one who must act, and the only one pinged:
    // the standin isn't booked yet and hears once it's agreed.
    reachUserId: other.captainId,
    mentions: mentionsOf([otherCaptain?.discordId]),
    announcement: standinApprovalRequestedMessage({
      requesterName: requester?.name ?? `The ${cover.coverTeamName} captain`,
      standinName,
      replacedName: cover.replacedName,
      teamName: cover.coverTeamName,
      otherTeamName: other.name,
      ...fixtureFacts(match),
      roundLabel: (await roundLabelsForPost([match])).get(match.id),
      whenMs: match.scheduledAt?.getTime() ?? null,
      standinMmr: cover.standinMmr,
      baselineMmr: ask.baselineMmr,
      lowerOut: ask.lowerOut
        ? { name: ask.lowerOut.name, replacedMmr: cover.replacedMmr }
        : null,
      matchId: match.id,
    }),
  };
}

/** A request as the answer paths read it. */
async function loadStandinRequest(requestId: string) {
  if (!requestId) return null;
  return prisma.standinRequest.findUnique({
    where: { id: requestId },
    include: {
      match: { include: COVER_MATCH_INCLUDE },
      standin: { select: { name: true, discordId: true } },
      replaced: { select: { name: true } },
      baselinePlayer: { select: { name: true } },
    },
  });
}

function requestClosedError(status: string): string {
  return status === STANDIN_REQUEST_STATUS.APPROVED
    ? "That request was already agreed to — the standin is booked"
    : status === STANDIN_REQUEST_STATUS.DECLINED
      ? "That request was already declined"
      : "That request was withdrawn";
}

const REQUEST_JUST_ANSWERED =
  "That request was just answered or withdrawn — reload to see where it stands";

/**
 * The other captain agrees to a standin request: the standin is booked, in
 * the same Serializable transaction that marks the request APPROVED, after
 * every booking check runs again (the seat, the standin's signup and their
 * night may all have moved since it was asked). Only the OTHER team's captain
 * may agree (never the asking side), or an admin (`actingCaptainId: null`)
 * who neither captains the asking team nor filed the request: an admin's
 * override is for someone else's request, never their own.
 */
export async function approveStandinRequest(
  opts: { requestId: string } & (
    | {
        /** A userId that must captain the match's OTHER team. */
        actingCaptainId: string;
        /** Who pressed the button (defaults to actingCaptainId). */
        actingUserId?: string;
      }
    | {
        /** An admin, in a captain's place. */
        actingCaptainId: null;
        /** The admin: required, so their own team's request is refused. */
        actingUserId: string;
      }
  ),
): Promise<StandinServiceResult> {
  const request = await loadStandinRequest(opts.requestId);
  if (!request) return { ok: false, error: "That request is gone" };
  if (request.status !== STANDIN_REQUEST_STATUS.PENDING)
    return { ok: false, error: requestClosedError(request.status) };
  const other = otherSide(request.match, request.teamId);
  const askingTeam = side(request.match, request.teamId);
  if (opts.actingCaptainId && other.captainId !== opts.actingCaptainId) {
    return {
      ok: false,
      error: `Only the ${other.name} captain (or an admin) can agree to this standin`,
    };
  }
  const target: CoverTarget = {
    matchId: request.matchId,
    standinUserId: request.standinUserId,
    replacingUserId: request.replacingUserId,
    teamId: request.teamId,
  };
  const judged = await judgeCover(target, {
    actingCaptainId: null,
    excludeRequestId: request.id,
  });
  // The booking checks speak to whoever books; the approver can only decline.
  if (!judged.ok) {
    return { ok: false, error: agreeTooLateError(judged.error, askingTeam.name) };
  }
  const cover = judged.cover;
  // judgeCover resolves the team from the covered player's roster today; a
  // player moved to the other side since the ask is not what was agreed to.
  if (cover.coverTeamId !== request.teamId) {
    return {
      ok: false,
      error: `${cover.replacedName} has changed teams since this was asked — decline it and ask again`,
    };
  }
  const actorId = opts.actingUserId ?? opts.actingCaptainId;
  // Test seam: the read-time status check above and the claim below.
  await raceHook("standin.approveRequest.beforeTx");
  try {
    await prisma.$transaction(
      async (tx) => {
        if (opts.actingCaptainId) {
          const current = await tx.team.findUnique({
            where: { id: other.id },
            select: { captainId: true },
          });
          if (current?.captainId !== opts.actingCaptainId) {
            throw new StandinRaceError(
              `The ${other.name} captain just changed — reload before answering`,
            );
          }
        }
        // Nobody agrees to their own side's request, the admin override
        // included. The asking team's captain is read here, not from the
        // request's match, so a captaincy handed over since is the one judged.
        const asking = await tx.team.findUnique({
          where: { id: request.teamId },
          select: { captainId: true },
        });
        if (asking?.captainId === actorId) {
          throw new StandinRaceError(
            `You captain ${askingTeam.name}, the team asking — the ${other.name} captain or another admin has to agree to this`,
          );
        }
        if (request.requestedById === actorId) {
          throw new StandinRaceError(
            `You asked for ${request.standin.name} yourself — the ${other.name} captain or another admin has to agree to this`,
          );
        }
        // The claim: only a request still PENDING turns into a booking, so an
        // answer racing a cancel (or a second answer) books nobody twice.
        const claimed = await tx.standinRequest.updateMany({
          where: { id: request.id, status: STANDIN_REQUEST_STATUS.PENDING },
          data: {
            status: STANDIN_REQUEST_STATUS.APPROVED,
            decidedAt: new Date(),
            decidedById: actorId,
          },
        });
        if (claimed.count === 0) throw new StandinRaceError(REQUEST_JUST_ANSWERED);
        await recheckCover(tx, target, cover, request.id);
        await tx.standinAssignment.create({
          data: {
            matchId: request.matchId,
            teamId: request.teamId,
            standinUserId: request.standinUserId,
            replacingUserId: request.replacingUserId,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof CoverRecheckError)
      return { ok: false, error: agreeTooLateError(e.message, askingTeam.name) };
    if (e instanceof StandinRaceError) return { ok: false, error: e.message };
    if (isSerializationConflict(e))
      return {
        ok: false,
        error: "That standin or seat just changed — reload and check it again",
      };
    throw e;
  }

  const match = request.match;
  const byCaptain = opts.actingCaptainId !== null;
  const reason = standinApprovalReason({
    standinMmr: request.standinMmr,
    baselineMmr: request.baselineMmr,
    emptySeat: request.replacingUserId === null,
    lowerOutName: request.baselinePlayer?.name,
  });
  const agreedName = byCaptain
    ? ((
        await prisma.user.findUnique({
          where: { id: other.captainId },
          select: { name: true },
        })
      )?.name ?? `the ${other.name} captain`)
    : null;
  return {
    ok: true,
    message: `Agreed — ${request.standin.name} is booked`,
    summary: `${byCaptain ? `The ${other.name} captain` : "An admin"} agreed to ${
      request.standin.name
    } covering ${cover.replacedName ?? "an open seat"} for ${
      cover.coverTeamName
    } in ${coverLogLabel(match)} (${reason})`,
    seasonId: match.seasonId,
    reachUserId: request.standinUserId,
    // The standin hears it's their game night; the asking captain hears
    // their request went through (they didn't press this button).
    mentions: mentionsOf([
      request.standin.discordId,
      await captainToNotify(cover.coverTeamCaptainId, actorId),
    ]),
    announcement: standinAssignedMessage({
      standinName: request.standin.name,
      replacedName: cover.replacedName,
      teamName: cover.coverTeamName,
      ...fixtureFacts(match),
      roundLabel: (await roundLabelsForPost([match])).get(match.id),
      whenMs: match.scheduledAt?.getTime() ?? null,
      matchId: match.id,
      agreedBy: { name: agreedName },
    }),
  };
}

/**
 * The other captain (or an admin) says no. Nothing is booked; the asking
 * captain is told to line up someone else. No read-time status check: the
 * claim's WHERE is the one place a closed request is refused.
 */
export async function declineStandinRequest(opts: {
  requestId: string;
  /** null = admin; a userId must captain the match's OTHER team. */
  actingCaptainId: string | null;
  /** Who pressed the button (defaults to actingCaptainId). */
  actingUserId?: string;
}): Promise<StandinServiceResult> {
  const request = await loadStandinRequest(opts.requestId);
  if (!request) return { ok: false, error: "That request is gone" };
  const other = otherSide(request.match, request.teamId);
  if (opts.actingCaptainId && other.captainId !== opts.actingCaptainId) {
    return {
      ok: false,
      error: `Only the ${other.name} captain (or an admin) can answer this request`,
    };
  }
  const actorId = opts.actingUserId ?? opts.actingCaptainId;
  let declined;
  try {
    declined = await prisma.$transaction(
      async (tx) => {
        if (opts.actingCaptainId) {
          const current = await tx.team.findUnique({
            where: { id: other.id },
            select: { captainId: true },
          });
          if (current?.captainId !== opts.actingCaptainId) {
            throw new StandinRaceError(
              `The ${other.name} captain just changed — reload before answering`,
            );
          }
        }
        return tx.standinRequest.updateMany({
          where: { id: request.id, status: STANDIN_REQUEST_STATUS.PENDING },
          data: {
            status: STANDIN_REQUEST_STATUS.DECLINED,
            decidedAt: new Date(),
            decidedById: actorId,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof StandinRaceError) return { ok: false, error: e.message };
    if (isSerializationConflict(e))
      return { ok: false, error: REQUEST_JUST_ANSWERED };
    throw e;
  }
  if (declined.count === 0) {
    return { ok: false, error: requestClosedError(await currentStatus(request.id)) };
  }

  const match = request.match;
  const coverTeam = side(match, request.teamId);
  const byCaptain = opts.actingCaptainId !== null;
  const declinedByName = byCaptain
    ? ((
        await prisma.user.findUnique({
          where: { id: other.captainId },
          select: { name: true },
        })
      )?.name ?? `the ${other.name} captain`)
    : null;
  return {
    ok: true,
    message: `Declined — ${request.standin.name} isn't booked, and the ${coverTeam.name} captain is told to find someone else`,
    summary: `${byCaptain ? `The ${other.name} captain` : "An admin"} declined ${
      request.standin.name
    } covering ${request.replaced?.name ?? "an open seat"} for ${
      coverTeam.name
    } in ${coverLogLabel(match)}`,
    seasonId: match.seasonId,
    reachUserId: coverTeam.captainId,
    mentions: mentionsOf([
      await captainToNotify(coverTeam.captainId, actorId),
    ]),
    announcement: standinRequestDeclinedMessage({
      declinedByName,
      standinName: request.standin.name,
      replacedName: request.replaced?.name ?? null,
      teamName: coverTeam.name,
      ...fixtureFacts(match),
      roundLabel: (await roundLabelsForPost([match])).get(match.id),
      matchId: match.id,
    }),
  };
}

/**
 * The asking captain withdraws their request, freeing the seat to book
 * someone else. No Discord post: nobody has to do anything about it. As with
 * decline, the claim's WHERE alone refuses a request already answered.
 */
export async function cancelStandinRequest(opts: {
  requestId: string;
  /** null = admin; a userId must captain the covered team. */
  actingCaptainId: string | null;
  /** Who pressed the button (defaults to actingCaptainId). */
  actingUserId?: string;
}): Promise<StandinServiceResult> {
  const request = await loadStandinRequest(opts.requestId);
  if (!request) return { ok: false, error: "That request is gone" };
  const coverTeam = side(request.match, request.teamId);
  if (opts.actingCaptainId && coverTeam.captainId !== opts.actingCaptainId) {
    return {
      ok: false,
      error: `Only the ${coverTeam.name} captain (or an admin) can withdraw this request`,
    };
  }
  let cancelled;
  try {
    cancelled = await prisma.$transaction(
      async (tx) => {
        if (opts.actingCaptainId) {
          const current = await tx.team.findUnique({
            where: { id: coverTeam.id },
            select: { captainId: true },
          });
          if (current?.captainId !== opts.actingCaptainId) {
            throw new StandinRaceError(
              "The team captain changed — reload before withdrawing this request",
            );
          }
        }
        return tx.standinRequest.updateMany({
          where: { id: request.id, status: STANDIN_REQUEST_STATUS.PENDING },
          data: {
            status: STANDIN_REQUEST_STATUS.CANCELLED,
            decidedAt: new Date(),
            decidedById: opts.actingUserId ?? opts.actingCaptainId,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof StandinRaceError) return { ok: false, error: e.message };
    if (isSerializationConflict(e))
      return { ok: false, error: REQUEST_JUST_ANSWERED };
    throw e;
  }
  if (cancelled.count === 0) {
    return { ok: false, error: requestClosedError(await currentStatus(request.id)) };
  }
  return {
    ok: true,
    message: `Request withdrawn — the seat is free to book someone else`,
    summary: `Withdrew the request for ${request.standin.name} to cover ${
      request.replaced?.name ?? "an open seat"
    } for ${coverTeam.name} in ${coverLogLabel(request.match)}`,
    seasonId: request.match.seasonId,
    announcement: "",
  };
}

/** A PENDING request the league closed, with what its post names. */
export type CancelledStandinRequest = {
  id: string;
  matchId: string;
  teamId: string;
  standinName: string;
  /** null = an empty-seat request. */
  replacedName: string | null;
  match: {
    id: string;
    seasonId: string;
    week: number;
    phase: string;
    bracketSlot: string | null;
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
};

/**
 * Close the PENDING standin requests a roster or schedule change has made
 * impossible to agree to, inside the caller's Serializable transaction, after
 * the change itself. A request is not cover, so nothing else needs undoing.
 * It reads the rows, then claims exactly those, still PENDING; the read and
 * the claim share the transaction's snapshot, so a short count means a rival
 * answered in between, and it throws (past the caller's first write).
 * `standinRequestCancellations` builds the posts for after the commit.
 */
export async function cancelPendingStandinRequests(
  tx: Prisma.TransactionClient,
  where: Prisma.StandinRequestWhereInput,
  actorId: string | null,
): Promise<CancelledStandinRequest[]> {
  const rows = await tx.standinRequest.findMany({
    where: { ...where, status: STANDIN_REQUEST_STATUS.PENDING },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      matchId: true,
      teamId: true,
      standin: { select: { name: true } },
      replaced: { select: { name: true } },
      match: {
        select: {
          id: true,
          seasonId: true,
          week: true,
          phase: true,
          bracketSlot: true,
          homeTeamId: true,
          awayTeamId: true,
          homeTeam: { select: { name: true, captainId: true } },
          awayTeam: { select: { name: true, captainId: true } },
        },
      },
    },
  });
  if (rows.length === 0) return [];
  const claimed = await tx.standinRequest.updateMany({
    where: {
      id: { in: rows.map((row) => row.id) },
      status: STANDIN_REQUEST_STATUS.PENDING,
    },
    data: {
      status: STANDIN_REQUEST_STATUS.CANCELLED,
      decidedAt: new Date(),
      decidedById: actorId,
    },
  });
  if (claimed.count !== rows.length) {
    throw new StandinRequestsChangedError();
  }
  return rows.map((row) => ({
    id: row.id,
    matchId: row.matchId,
    teamId: row.teamId,
    standinName: row.standin.name,
    replacedName: row.replaced?.name ?? null,
    match: row.match,
  }));
}

/** A standin request was answered while a change was closing it. */
export class StandinRequestsChangedError extends Error {
  constructor() {
    super("A standin request was just answered — reload and try again");
  }
}

/**
 * The posts that tell each asking captain their request is off and why, for
 * the action to send after the commit (the house shape for standin posts).
 * Each mentions only that request's team captain, the one who has to line up
 * someone else.
 */
export async function standinRequestCancellations(
  cancelled: CancelledStandinRequest[],
  reason: StandinRequestCancelReason,
): Promise<{ announcement: string; mentions?: MentionAllowlist }[]> {
  if (cancelled.length === 0) return [];
  const captainIds = cancelled.map((request) =>
    request.teamId === request.match.homeTeamId
      ? request.match.homeTeam.captainId
      : request.match.awayTeam.captainId,
  );
  const [captains, roundLabels] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: [...new Set(captainIds)] } },
      select: { id: true, discordId: true },
    }),
    roundLabelsForPost(cancelled.map((request) => request.match)),
  ]);
  const discordIdOf = new Map(captains.map((c) => [c.id, c.discordId]));
  return cancelled.map((request, index) => {
    const { match } = request;
    const teamName =
      request.teamId === match.homeTeamId
        ? match.homeTeam.name
        : match.awayTeam.name;
    return {
      announcement: standinRequestCancelledMessage({
        reason,
        standinName: request.standinName,
        replacedName: request.replacedName,
        teamName,
        homeName: match.homeTeam.name,
        awayName: match.awayTeam.name,
        week: match.week,
        isPlayoff: isPlayoffPhase(match.phase),
        isTiebreaker: match.phase === MATCH_PHASE.TIEBREAKER,
        roundLabel: roundLabels.get(match.id),
        matchId: match.id,
      }),
      mentions: mentionsOf([discordIdOf.get(captainIds[index])]),
    };
  });
}

/** A request's status now, for wording a claim that lost. */
async function currentStatus(requestId: string): Promise<string> {
  const row = await prisma.standinRequest.findUnique({
    where: { id: requestId },
    select: { status: true },
  });
  return row?.status ?? STANDIN_REQUEST_STATUS.CANCELLED;
}

/**
 * NO archived-season refusal here, unlike assign — DELIBERATE. Removal is
 * cleanup (the reschedule decline/withdraw precedent): a stale booking on an
 * archived season's unplayed match blocks that standin's own withdrawal
 * (pendingCoverWhere is per-season, but the human is still listed) and there
 * is no other control that can clear it. Same reason removal stays legal in
 * every season PHASE while assign is gated.
 */
export async function removeStandinGuarded(opts: {
  assignmentId: string;
  /** null = admin; a userId must captain the assignment's team. */
  actingCaptainId: string | null;
  /**
   * Who pressed the button (defaults to actingCaptainId). The covered team's
   * captain is mentioned unless they are the one acting.
   */
  actingUserId?: string;
}): Promise<StandinServiceResult> {
  const assignment = await prisma.standinAssignment.findUnique({
    where: { id: opts.assignmentId },
    include: {
      match: {
        include: {
          games: { select: { id: true } },
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      },
      standin: { select: { name: true, discordId: true } },
    },
  });
  if (!assignment) return { ok: false, error: "That assignment is already gone" };
  // StandinAssignment carries teamId but no relation — resolve the covered
  // team for the captain check and the announcement.
  const team = await prisma.team.findUnique({
    where: { id: assignment.teamId },
    select: { captainId: true, name: true },
  });
  if (!team) return { ok: false, error: "That assignment's team is gone" };
  if (opts.actingCaptainId && team.captainId !== opts.actingCaptainId) {
    return {
      ok: false,
      error: "Only that team's captain (or an admin) can remove this standin",
    };
  }
  // Once games are in the books the assignment is part of the record: later
  // imports would silently drop the standin's stats (or fail classification),
  // and removing it from a played match erases the "in for" history.
  if (assignment.match.status === MATCH_STATUS.COMPLETED)
    return {
      ok: false,
      error: "This match is already played — the assignment is history",
    };
  if (assignment.match.games.length > 0)
    return {
      ok: false,
      error:
        "Games are already imported — removing the standin now would strip them from the rest of the series",
    };
  // Both preconditions ride in the WHERE, not just in the snapshot read three
  // queries ago: auto-sync imports games from any visitor's page view, so a
  // series can acquire its first game (or complete outright) in the gap, and
  // this delete is exactly the mid-series removal the checks above refuse.
  //
  // The import is the other half of a write-skew pair, and both halves are
  // Serializable: importGameForMatch re-reads the assignment set
  // (gatherTeamAccounts(fresh, tx)) inside the transaction that writes the
  // Game, and this delete reads the match's games through the relation filter
  // below. Each side reads the table the other writes, so Postgres SSI aborts
  // one of them: the removal then reports "The match just changed"
  // (isSerializationConflict) or a zero count. No raced test pins this pair
  // yet (standins-raced.itest.ts covers the assign pairs only); if one is
  // added it needs `npm run test:pg`, since SQLite runs the two in sequence.
  let gone;
  try {
    gone = await prisma.$transaction(async (tx) => {
      const currentTeam = await tx.team.findUnique({ where: { id: assignment.teamId }, select: { captainId: true } });
      if (!currentTeam || (opts.actingCaptainId && currentTeam.captainId !== opts.actingCaptainId)) {
        throw new StandinRaceError("The team captain changed — reload before removing this cover.");
      }
      const deleted = await tx.standinAssignment.deleteMany({
        where: {
          id: opts.assignmentId,
          match: { status: { not: MATCH_STATUS.COMPLETED }, games: { none: {} } },
        },
      });
      return deleted;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof StandinRaceError) return { ok: false, error: error.message };
    if (isSerializationConflict(error)) return { ok: false, error: "The match just changed — reload before removing this cover." };
    throw error;
  }
  if (gone.count === 0) {
    return {
      ok: false,
      error:
        "A game was just imported for this match — the assignment has to stay, or the standin drops out of the rest of the series",
    };
  }
  const byCaptain =
    team.captainId === (opts.actingUserId ?? opts.actingCaptainId);
  return {
    ok: true,
    message: "Standin assignment removed",
    summary: `Removed ${assignment.standin.name}'s cover for ${team.name} in ${fixtureLogLabel(
      {
        ...assignment.match,
        homeName: assignment.match.homeTeam.name,
        awayName: assignment.match.awayTeam.name,
      },
    )}`,
    seasonId: assignment.match.seasonId,
    // They were told to show up; they need to hear that they no longer are.
    // An admin's removal also reaches the captain, whose seat is open again.
    mentions: mentionsOf([
      assignment.standin.discordId,
      byCaptain ? null : await captainToNotify(team.captainId, null),
    ]),
    announcement: standinRemovedMessage({
      standinName: assignment.standin.name,
      teamName: team.name,
      homeName: assignment.match.homeTeam.name,
      awayName: assignment.match.awayTeam.name,
      week: assignment.match.week,
      isPlayoff: isPlayoffPhase(assignment.match.phase),
      isTiebreaker: assignment.match.phase === MATCH_PHASE.TIEBREAKER,
      roundLabel: (await roundLabelsForPost([assignment.match])).get(
        assignment.match.id,
      ),
      reason: byCaptain ? "CAPTAIN_CANCELLED" : "ADMIN_CANCELLED",
    }),
  };
}

/**
 * The covered team's captain's Discord id when someone other than the captain
 * changed their cover, else null. Only a linked account is mentionable.
 */
async function captainToNotify(
  captainId: string,
  actorId: string | null,
): Promise<string | null> {
  if (captainId === actorId) return null;
  const captain = await prisma.user.findUnique({
    where: { id: captainId },
    select: { discordId: true },
  });
  return captain?.discordId ?? null;
}
