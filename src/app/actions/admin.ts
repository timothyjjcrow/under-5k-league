"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import {
  SEASON_STATUS,
  SEASON_PHASE_ORDER,
  DRAFT_STATUS,
  MATCH_STATUS,
  MATCH_PHASE,
  DEFAULTS,
  type SeasonStatus,
} from "@/lib/constants";
import { roundRobin } from "@/lib/schedule";
import {
  createPlayoffBracket,
  advancePlayoffBracket,
} from "@/lib/playoff-service";
import {
  regularSeasonStatus,
  pendingResultsMessage,
} from "@/lib/schedule-status";
import {
  importGameForMatch,
  autoDetectGamesForMatch,
  recomputeSeries,
  syncLeagueGames,
} from "@/lib/match-import";
import {
  parseMatchId,
  steamIdToAccountId,
  fetchPlayerRankTier,
} from "@/lib/dota";
import { fetchSteamProfiles } from "@/lib/steam";
import { clampInt, str } from "@/lib/form";
import type { ActionResult } from "@/lib/action-result";

function refresh() {
  revalidatePath("/", "layout");
}

/** Create a fresh season and make it the active one (archives the previous). */
export async function createSeason(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const name = str(formData, "name").trim().slice(0, 60) || "New Season";
  const teamSize = clampInt(formData, "teamSize", 5, 2, 10);
  const minTeams = clampInt(formData, "minTeams", 4, 2, 32);
  const draftBudget = clampInt(formData, "draftBudget", 100, 10, 100000);
  const maxMmr = clampInt(formData, "maxMmr", 0, 0, 20000);

  await prisma.$transaction([
    prisma.season.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    }),
    prisma.season.create({
      data: {
        name,
        teamSize,
        minTeams,
        draftBudget,
        maxMmr,
        status: SEASON_STATUS.SIGNUPS,
        isActive: true,
      },
    }),
  ]);
  refresh();
  return { message: `Created ${name}` };
}

/** Directly set the active season's phase (admin override). */
export async function setSeasonPhase(formData: FormData) {
  await requireAdmin();
  const target = str(formData, "phase") as SeasonStatus;
  if (!SEASON_PHASE_ORDER.includes(target)) throw new Error("Invalid phase");
  const season = await getActiveSeason();
  if (!season) throw new Error("No active season");
  await prisma.season.update({
    where: { id: season.id },
    data: { status: target },
  });
  refresh();
}

/** Designate a registered player as a team captain (creates their team). */
export async function addCaptain(formData: FormData) {
  await requireAdmin();
  const userId = str(formData, "userId");
  const season = await getActiveSeason();
  if (!season) throw new Error("No active season");

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("Unknown user");

  const existing = await prisma.team.findUnique({
    where: { seasonId_captainId: { seasonId: season.id, captainId: userId } },
  });
  if (existing) return;

  const order = await prisma.team.count({ where: { seasonId: season.id } });
  await prisma.$transaction(async (tx) => {
    const team = await tx.team.create({
      data: {
        seasonId: season.id,
        name: `${user.name}'s Team`,
        captainId: user.id,
        budget: season.draftBudget,
        draftOrder: order,
      },
    });
    await tx.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: team.id,
        userId: user.id,
        isCaptain: true,
        price: 0,
      },
    });
  });
  refresh();
}

/** Undo captain designation (only allowed before the draft starts). */
export async function removeCaptain(formData: FormData) {
  await requireAdmin();
  const teamId = str(formData, "teamId");
  const season = await getActiveSeason();
  if (!season) throw new Error("No active season");
  const draft = await prisma.draft.findUnique({
    where: { seasonId: season.id },
  });
  if (draft && draft.status === DRAFT_STATUS.IN_PROGRESS) {
    throw new Error("Cannot remove a captain during the draft");
  }
  await prisma.team.delete({ where: { id: teamId } });
  refresh();
}

/** Rename a team. */
export async function renameTeam(formData: FormData) {
  await requireAdmin();
  const teamId = str(formData, "teamId");
  const name = str(formData, "name").trim();
  if (!name) return;
  await prisma.team.update({ where: { id: teamId }, data: { name } });
  refresh();
}

/** Randomize the nomination/draft order of teams. */
export async function randomizeDraftOrder() {
  await requireAdmin();
  const season = await getActiveSeason();
  if (!season) throw new Error("No active season");
  const teams = await prisma.team.findMany({ where: { seasonId: season.id } });
  const shuffled = [...teams].sort(() => Math.random() - 0.5);
  await prisma.$transaction(
    shuffled.map((t, i) =>
      prisma.team.update({ where: { id: t.id }, data: { draftOrder: i } }),
    ),
  );
  refresh();
}

/** Begin the live auction draft. Sets the season to DRAFT and seeds Draft state. */
export async function startDraft(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const teams = await prisma.team.findMany({
    where: { seasonId: season.id },
    orderBy: { draftOrder: "asc" },
  });
  if (teams.length < 2) return { error: "Need at least 2 captains to draft" };

  await prisma.$transaction(async (tx) => {
    await Promise.all(
      teams.map((t) =>
        tx.team.update({
          where: { id: t.id },
          data: { budget: season.draftBudget },
        }),
      ),
    );
    await tx.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    const nominationEndsAt = new Date(
      Date.now() + DEFAULTS.NOMINATION_TIMER_SECONDS * 1000,
    );
    await tx.draft.upsert({
      where: { seasonId: season.id },
      create: {
        seasonId: season.id,
        status: DRAFT_STATUS.IN_PROGRESS,
        nominatorTeamId: teams[0].id,
        nominationIndex: 0,
        nominationEndsAt,
      },
      update: {
        status: DRAFT_STATUS.IN_PROGRESS,
        nominatorTeamId: teams[0].id,
        nominationIndex: 0,
        nominatedUserId: null,
        currentBid: 0,
        currentBidTeamId: null,
        bidEndsAt: null,
        nominationEndsAt,
      },
    });
  });
  refresh();
  return { message: "Draft started — the auction is live" };
}

/** Generate a round-robin regular-season schedule from the drafted teams. */
export async function generateSchedule(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const teams = await prisma.team.findMany({
    where: { seasonId: season.id },
    orderBy: { draftOrder: "asc" },
  });
  if (teams.length < 2) return { error: "Need at least 2 teams" };

  const rounds = roundRobin(teams.map((t) => t.id));
  const rows = rounds.flatMap((round, i) =>
    round.map((p) => ({
      seasonId: season.id,
      week: i + 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: p.home,
      awayTeamId: p.away,
      bestOf: season.regularBestOf,
    })),
  );

  await prisma.$transaction([
    prisma.match.deleteMany({
      where: { seasonId: season.id, phase: MATCH_PHASE.REGULAR },
    }),
    prisma.match.createMany({ data: rows }),
  ]);
  refresh();
  return { message: `Schedule generated · ${rows.length} matches` };
}

/** Seed and start the single-elimination playoff bracket from the standings. */
export async function startPlayoffs(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };

  // Don't seed the bracket on an incomplete regular season — missing results
  // would give the wrong standings and the wrong seeding.
  const matches = await prisma.match.findMany({
    where: { seasonId: season.id },
    select: { week: true, phase: true, status: true },
  });
  const pending = pendingResultsMessage(regularSeasonStatus(matches));
  if (pending) {
    return { error: `${pending} Enter them before starting the playoffs.` };
  }

  try {
    await createPlayoffBracket(season.id);
  } catch (e) {
    return { error: (e as Error).message };
  }
  refresh();
  return { message: "Playoff bracket created" };
}

/** Record a match result (series score). Sets winner + completed status. */
export async function recordResult(formData: FormData) {
  await requireAdmin();
  const matchId = str(formData, "matchId");
  const homeScore = clampInt(formData, "homeScore", 0, 0, 99);
  const awayScore = clampInt(formData, "awayScore", 0, 0, 99);

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) throw new Error("Unknown match");

  const winnerTeamId =
    homeScore > awayScore
      ? match.homeTeamId
      : awayScore > homeScore
        ? match.awayTeamId
        : null;

  await prisma.match.update({
    where: { id: matchId },
    data: {
      homeScore,
      awayScore,
      winnerTeamId,
      status: MATCH_STATUS.COMPLETED,
    },
  });

  // Playoff results auto-advance the bracket (and crown the champion at the end).
  if (match.phase !== MATCH_PHASE.REGULAR) {
    await advancePlayoffBracket(match.seasonId);
  }
  refresh();
}

/** Assign a standin to fill in for a rostered player in a specific match. */
export async function assignStandin(formData: FormData) {
  await requireAdmin();
  const matchId = str(formData, "matchId");
  const standinUserId = str(formData, "standinUserId");
  const replacingUserId = str(formData, "replacingUserId");
  if (!matchId || !standinUserId || !replacingUserId)
    throw new Error("Missing fields");

  const season = await getActiveSeason();
  if (!season) throw new Error("No active season");
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) throw new Error("Unknown match");

  // The replaced player's roster tells us which team the standin fills for.
  const membership = await prisma.teamMember.findUnique({
    where: { seasonId_userId: { seasonId: season.id, userId: replacingUserId } },
  });
  if (!membership) throw new Error("Replaced player is not on a team");
  if (
    membership.teamId !== match.homeTeamId &&
    membership.teamId !== match.awayTeamId
  ) {
    throw new Error("That player's team isn't in this match");
  }

  await prisma.standinAssignment.create({
    data: { matchId, teamId: membership.teamId, standinUserId, replacingUserId },
  });
  refresh();
}

/** Remove a standin assignment. */
export async function removeStandin(formData: FormData) {
  await requireAdmin();
  const id = str(formData, "assignmentId");
  await prisma.standinAssignment.delete({ where: { id } });
  refresh();
}

/** Import a specific Dota game (by id or URL) into a scheduled match. */
export async function importGameAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const matchId = str(formData, "matchId");
  const dotaMatchId = parseMatchId(str(formData, "dotaMatchRef"));
  if (!dotaMatchId) return { error: "Enter a valid match id or URL" };
  const res = await importGameForMatch(matchId, dotaMatchId);
  if (!res.ok) return { error: res.error };
  revalidatePath("/", "layout");
  return { ok: true, message: "Game imported" };
}

/** Auto-detect a scheduled match's games from the rosters' recent games. */
export async function autoDetectAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const matchId = str(formData, "matchId");
  const res = await autoDetectGamesForMatch(matchId);
  if (res.error) return { error: res.error };
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `Scanned ${res.scanned} players · imported ${res.imported} game(s)`,
  };
}

/** Remove an imported game and recompute the series. */
export async function removeGame(formData: FormData) {
  await requireAdmin();
  const gameId = str(formData, "gameId");
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  await prisma.game.delete({ where: { id: gameId } });
  if (game) await recomputeSeries(game.matchId);
  refresh();
}

/** Set or clear a match's scheduled date/time (from a datetime-local input). */
export async function setMatchTime(formData: FormData) {
  await requireAdmin();
  const matchId = str(formData, "matchId");
  const raw = str(formData, "scheduledAt");
  const scheduledAt = raw ? new Date(raw) : null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) return;
  await prisma.match.update({ where: { id: matchId }, data: { scheduledAt } });
  refresh();
}

/** Fetch every active player's ranked medal from OpenDota (a draft resource). */
export async function syncPlayerRanks(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };

  const regs = await prisma.registration.findMany({
    where: { seasonId: season.id, status: "ACTIVE" },
    include: { user: true },
  });
  let ranked = 0;
  for (const r of regs) {
    const acc = r.user.dotaAccountId ?? steamIdToAccountId(r.user.steamId);
    if (!acc) continue;
    const rankTier = await fetchPlayerRankTier(acc);
    await prisma.user.update({ where: { id: r.userId }, data: { rankTier } });
    if (rankTier) ranked++;
  }
  refresh();
  return { message: `Synced ${regs.length} players · ${ranked} ranked` };
}

/** Set the active season's signup MMR cap (0 = no cap). */
export async function setMaxMmr(formData: FormData) {
  await requireAdmin();
  const season = await getActiveSeason();
  if (!season) return;
  const maxMmr = clampInt(formData, "maxMmr", 0, 0, 20000);
  await prisma.season.update({
    where: { id: season.id },
    data: { maxMmr },
  });
  refresh();
}

/**
 * Set the best-of series lengths for regular / playoff / final matches. Regular
 * may be even (a Bo2 can draw 1-1); playoff & final are forced odd so they can't
 * tie. Applied to schedules/brackets created after this — set before generating.
 */
export async function setSeriesLengths(formData: FormData) {
  await requireAdmin();
  const season = await getActiveSeason();
  if (!season) return;
  const regularBestOf = clampInt(formData, "regularBestOf", 2, 1, 15);
  let playoffBestOf = clampInt(formData, "playoffBestOf", 3, 1, 15);
  let finalBestOf = clampInt(formData, "finalBestOf", 5, 1, 15);
  if (playoffBestOf % 2 === 0) playoffBestOf += 1;
  if (finalBestOf % 2 === 0) finalBestOf += 1;
  await prisma.season.update({
    where: { id: season.id },
    data: { regularBestOf, playoffBestOf, finalBestOf },
  });
  refresh();
}

/** Set (or clear) the season's Valve league id for in-client league games. */
export async function setLeagueId(formData: FormData) {
  await requireAdmin();
  const season = await getActiveSeason();
  if (!season) return;
  const value = str(formData, "dotaLeagueId").trim();
  const leagueId = value.match(/(\d+)/)?.[1] ?? null;
  await prisma.season.update({
    where: { id: season.id },
    data: { dotaLeagueId: leagueId },
  });
  refresh();
}

/** Import all games from the season's Dota league id (OpenDota). */
export async function syncLeagueAction(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const res = await syncLeagueGames(season.id);
  if (res.error) return { error: res.error };
  refresh();
  return {
    message: `League sync · imported ${res.imported} of ${res.scanned} league games`,
  };
}

/** Refresh every user's Steam persona name + avatar (batched). */
export async function syncSteamProfiles(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const users = await prisma.user.findMany();
  const profiles = await fetchSteamProfiles(users.map((u) => u.steamId));
  let updated = 0;
  for (const u of users) {
    const p = profiles.get(u.steamId);
    if (!p) continue;
    await prisma.user.update({
      where: { id: u.id },
      data: { name: p.name, avatar: p.avatar, profileUrl: p.profileUrl },
    });
    updated++;
  }
  refresh();
  return { message: `Updated ${updated} of ${users.length} Steam profiles` };
}
