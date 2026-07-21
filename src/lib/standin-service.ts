import { prisma } from "./prisma";
import { MATCH_STATUS, REGISTRATION_STATUS } from "./constants";
import { getActiveSeason } from "./season";
import { standinAssignedMessage, standinRemovedMessage } from "./discord";

// Standin assignment, captain-self-serve edition (reschedule-service pattern:
// the integration-tested guards live here; the thin actions add auth, toasts,
// and the best-effort Discord send). Previously admin-only — which made
// standin coverage the biggest weekly admin relay: OUT ping → captain DMs the
// admin → admin fills the form. Captains can now line up their own cover;
// `actingCaptainId: null` is the admin override (any team, same guards).

export type StandinServiceResult =
  | { ok: true; message: string; announcement: string }
  | { ok: false; error: string };

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
      select: { name: true },
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
  const [already, seatTaken] = await Promise.all([
    prisma.standinAssignment.findFirst({ where: { matchId, standinUserId } }),
    prisma.standinAssignment.findFirst({
      where: { matchId, replacingUserId },
      include: { standin: { select: { name: true } } },
    }),
  ]);
  if (already)
    return { ok: false, error: "That standin is already assigned to this match" };
  if (seatTaken)
    return {
      ok: false,
      error: `${membership.user.name} is already covered by ${seatTaken.standin.name} — remove that assignment first to swap`,
    };

  await prisma.standinAssignment.create({
    data: { matchId, teamId: membership.teamId, standinUserId, replacingUserId },
  });

  return {
    ok: true,
    message:
      "Standin assigned" +
      (match.games.length > 0
        ? " — heads up: already-imported games keep their original attribution"
        : ""),
    // Being assigned is the single most action-demanding event a standin can
    // get — the action layer posts this so they hear about it without
    // happening to visit the site.
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
      standin: { select: { name: true } },
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
  await prisma.standinAssignment.delete({ where: { id: opts.assignmentId } });
  return {
    ok: true,
    message: "Standin assignment removed",
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
