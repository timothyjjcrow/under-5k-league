import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { MATCH_STATUS, REGISTRATION_STATUS } from "./constants";
import { getActiveSeason } from "./season";
import {
  standinAssignedMessage,
  standinRemovedMessage,
  type MentionAllowlist,
} from "./discord";
import { mentionsOf } from "./discord-mentions";
import { standinConflict } from "./standin";

/**
 * A precondition re-checked INSIDE the assign transaction stopped holding.
 * Thrown, never returned — the callback resolving would commit the assignment
 * it exists to prevent.
 */
class StandinRaceError extends Error {}

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
      announcement: string;
      /** Who the announcement is FOR — the action passes it to the send. */
      mentions?: MentionAllowlist;
    }
  | { ok: false; error: string };

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

export async function assignStandinGuarded(opts: {
  matchId: string;
  standinUserId: string;
  replacingUserId: string;
  /** null = admin (either team); a userId must captain the covered team. */
  actingCaptainId: string | null;
}): Promise<StandinServiceResult> {
  const { matchId, standinUserId, replacingUserId, actingCaptainId } = opts;
  if (!matchId || !standinUserId || !replacingUserId)
    return { ok: false, error: "Pick a standin and the player they cover" };
  if (standinUserId === replacingUserId)
    return { ok: false, error: "A player can't stand in for themselves" };

  const season = await getActiveSeason();
  if (!season) return { ok: false, error: "No active season" };
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      games: { select: { id: true } },
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
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

  // The replaced player's roster tells us which team the standin fills for.
  const membership = await prisma.teamMember.findUnique({
    where: { seasonId_userId: { seasonId: season.id, userId: replacingUserId } },
    include: {
      team: { select: { captainId: true, name: true } },
      user: { select: { name: true } },
    },
  });
  if (!membership) return { ok: false, error: "Replaced player is not on a team" };
  if (
    membership.teamId !== match.homeTeamId &&
    membership.teamId !== match.awayTeamId
  ) {
    return { ok: false, error: "That player's team isn't in this match" };
  }
  // Captains manage their OWN roster's cover; the other side is not theirs.
  if (actingCaptainId && membership.team.captainId !== actingCaptainId) {
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
  const [already, seatTaken, otherNights] = await Promise.all([
    prisma.standinAssignment.findFirst({ where: { matchId, standinUserId } }),
    prisma.standinAssignment.findFirst({
      where: { matchId, replacingUserId },
      include: { standin: { select: { name: true } } },
    }),
    findClashingCover(prisma, { matchId, standinUserId, seasonId: season.id }),
  ]);
  if (already)
    return { ok: false, error: "That standin is already assigned to this match" };
  if (seatTaken)
    return {
      ok: false,
      error: `${membership.user.name} is already covered by ${seatTaken.standin.name} — remove that assignment first to swap`,
    };
  const clash = otherNights.find((o) => standinConflict(match, o.match));
  if (clash)
    return { ok: false, error: clashError(standinUser?.name, clash) };

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
        const [fresh, rostered, already, seatTaken, otherNights] = await Promise.all([
          tx.registration.findUnique({
            where: { seasonId_userId: { seasonId: season.id, userId: standinUserId } },
            select: { status: true },
          }),
          tx.teamMember.findUnique({
            where: { seasonId_userId: { seasonId: season.id, userId: standinUserId } },
            select: { id: true },
          }),
          tx.standinAssignment.findFirst({ where: { matchId, standinUserId } }),
          tx.standinAssignment.findFirst({
            where: { matchId, replacingUserId },
            include: { standin: { select: { name: true } } },
          }),
          // Same reasoning as the other re-reads: two concurrent assigns for
          // the same standin on two fixtures the same night would each see a
          // clear field outside the transaction.
          findClashingCover(tx, { matchId, standinUserId, seasonId: season.id }),
        ]);
        if (!fresh || fresh.status !== REGISTRATION_STATUS.ACTIVE)
          throw new StandinRaceError("That standin has no active signup this season");
        if (rostered)
          throw new StandinRaceError(
            "That player is on a roster — they can't stand in",
          );
        if (already)
          throw new StandinRaceError(
            "That standin is already assigned to this match",
          );
        if (seatTaken)
          throw new StandinRaceError(
            `${membership.user.name} is already covered by ${seatTaken.standin.name} — remove that assignment first to swap`,
          );
        const clash = otherNights.find((o) => standinConflict(match, o.match));
        if (clash)
          throw new StandinRaceError(clashError(standinUser?.name, clash));
        await tx.standinAssignment.create({
          data: { matchId, teamId: membership.teamId, standinUserId, replacingUserId },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof StandinRaceError) return { ok: false, error: e.message };
    if ((e as { code?: string }).code === "P2034")
      return {
        ok: false,
        error: "That standin's signup just changed — check it and try again",
      };
    throw e;
  }

  return {
    ok: true,
    message:
      "Standin assigned" +
      (match.games.length > 0
        ? " — heads up: already-imported games keep their original attribution"
        : ""),
    // Being assigned is the single most action-demanding event a standin can
    // get — the action layer posts this so they hear about it without
    // happening to visit the site. Which is why it MENTIONS them: a plain
    // channel line about a game they're now expected at is exactly the
    // message that must not depend on them scrolling back.
    mentions: mentionsOf([standinUser?.discordId]),
    announcement: standinAssignedMessage({
      standinName: standinUser?.name ?? "A standin",
      replacedName: membership.user.name,
      teamName: membership.team.name,
      homeName: match.homeTeam.name,
      awayName: match.awayTeam.name,
      week: match.week,
      isPlayoff: match.phase !== "REGULAR",
      whenMs: match.scheduledAt?.getTime() ?? null,
    }),
  };
}

export async function removeStandinGuarded(opts: {
  assignmentId: string;
  /** null = admin; a userId must captain the assignment's team. */
  actingCaptainId: string | null;
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
  const gone = await prisma.standinAssignment.deleteMany({
    where: {
      id: opts.assignmentId,
      match: { status: { not: MATCH_STATUS.COMPLETED }, games: { none: {} } },
    },
  });
  if (gone.count === 0) {
    return {
      ok: false,
      error:
        "A game was just imported for this match — the assignment has to stay, or the standin drops out of the rest of the series",
    };
  }
  return {
    ok: true,
    message: "Standin assignment removed",
    // They were told to show up; they need to hear that they no longer are.
    mentions: mentionsOf([assignment.standin.discordId]),
    announcement: standinRemovedMessage({
      standinName: assignment.standin.name,
      teamName: team.name,
      homeName: assignment.match.homeTeam.name,
      awayName: assignment.match.awayTeam.name,
      week: assignment.match.week,
      isPlayoff: assignment.match.phase !== "REGULAR",
    }),
  };
}
