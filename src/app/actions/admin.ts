"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import {
  SEASON_STATUS,
  SEASON_PHASE_ORDER,
  REGISTRATION_TYPE,
  REGISTRATION_STATUS,
  DRAFT_STATUS,
  MATCH_STATUS,
  MATCH_PHASE,
  DEFAULTS,
  type SeasonStatus,
} from "@/lib/constants";
import { roundRobin, matchNightForWeek, slotRound } from "@/lib/schedule";
import { seriesScoreError } from "@/lib/standings";
import { mmrWeightedBudgets } from "@/lib/draft";
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
  enrichStoredGames,
} from "@/lib/match-import";
import {
  parseMatchId,
  steamIdToAccountId,
  fetchRankTier,
} from "@/lib/dota";
import { fetchSteamProfiles } from "@/lib/steam";
import { clampInt, localDate, str } from "@/lib/form";
import {
  draftStartedMessage,
  freeAgentSignedMessage,
  matchResultMessage,
  playerReleasedMessage,
  playoffsStartedMessage,
  sendDiscordMessage,
  testMessage,
  draftScheduledMessage,
} from "@/lib/discord";
import {
  getSetting,
  setSetting,
  stampResultChange,
  SETTING_KEYS,
} from "@/lib/settings";
import { bumpSessionEpoch } from "@/lib/session-epoch";
import { maybeAnnounceWeekHonors } from "@/lib/honors-service";
import { promoteGateError, withdrawGateError } from "@/lib/registration";
import type { ActionResult } from "@/lib/action-result";

function refresh() {
  revalidatePath("/", "layout");
}

// Game imports/edits also invalidate the cached all-games stat scans
// (src/lib/cached-queries.ts, tagged "games") so leaders / meta / records /
// hall-of-fame / player profiles reflect the change immediately instead of
// after the 60s TTL. revalidatePath alone does NOT clear unstable_cache tags.
function refreshGames() {
  // Next 16 requires the cacheLife profile arg; "max" is the documented
  // equivalent of the old one-arg revalidateTag — invalidate the tag now.
  revalidateTag("games", "max");
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
  const budgetMmrWeight = clampInt(formData, "budgetMmrWeight", 20, 0, 50);
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
        budgetMmrWeight,
        maxMmr,
        status: SEASON_STATUS.SIGNUPS,
        isActive: true,
      },
    }),
  ]);
  refresh();
  return { message: `Created ${name}` };
}

/**
 * Permanently delete an archived season and everything under it (teams,
 * matches, registrations, draft history) — for test runs and misfires.
 * The active season can never be deleted.
 */
export async function deleteSeason(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const seasonId = str(formData, "seasonId");
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) return { error: "Unknown season" };
  if (season.isActive) {
    return {
      error:
        "That's the active season — create a new season first (which archives it), then delete it.",
    };
  }

  // Matches must go before teams (Match→Team is RESTRICT); the season delete
  // cascades to everything else. The weekly-honors idempotency markers live
  // in the relationless Setting table, so they need explicit cleanup.
  await prisma.$transaction([
    prisma.match.deleteMany({ where: { seasonId } }),
    prisma.season.delete({ where: { id: seasonId } }),
    prisma.setting.deleteMany({
      where: { key: { startsWith: `honorsAnnounced:${seasonId}:` } },
    }),
  ]);
  refresh();
  return { message: `Deleted ${season.name} and all of its history` };
}

/** Directly set the active season's phase (admin override). */
export async function setSeasonPhase(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const target = str(formData, "phase") as SeasonStatus;
  if (!SEASON_PHASE_ORDER.includes(target)) return { error: "Invalid phase" };
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === target) {
    return { error: `The season is already in ${PHASE_LABELS[target]}` };
  }
  await prisma.season.update({
    where: { id: season.id },
    data: { status: target },
  });
  refresh();
  return { message: `Season moved to ${PHASE_LABELS[target]}` };
}

const PHASE_LABELS: Record<SeasonStatus, string> = {
  SIGNUPS: "Signups",
  DRAFT: "Draft",
  REGULAR_SEASON: "Regular season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Complete",
};

/** Rename the active season — its name is the hero title on the home page. */
export async function renameSeason(formData: FormData) {
  await requireAdmin();
  const season = await getActiveSeason();
  if (!season) return;
  const name = str(formData, "name").trim().slice(0, 60);
  if (!name) return;
  await prisma.season.update({
    where: { id: season.id },
    data: { name },
  });
  refresh();
}

/** Designate a registered player as a team captain (creates their team). */
export async function addCaptain(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const userId = str(formData, "userId");
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { error: "Unknown user" };

  // Only signed-up full players can captain — the UI only offers those, but
  // the form value is client-controlled.
  const reg = await prisma.registration.findUnique({
    where: { seasonId_userId: { seasonId: season.id, userId } },
  });
  if (
    !reg ||
    reg.status !== "ACTIVE" ||
    reg.type !== REGISTRATION_TYPE.PLAYER
  ) {
    return { error: `${user.name} isn't an active player signup this season` };
  }

  // Teams lock once the auction begins.
  const draftRow = await prisma.draft.findUnique({
    where: { seasonId: season.id },
  });
  if (draftRow && draftRow.status !== DRAFT_STATUS.NOT_STARTED) {
    return { error: "The draft has started — captains are locked" };
  }

  const existing = await prisma.team.findUnique({
    where: { seasonId_captainId: { seasonId: season.id, captainId: userId } },
  });
  if (existing) return { error: `${user.name} already captains a team` };

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
  return { message: `${user.name} is now a captain` };
}

/** Undo captain designation (only allowed before the draft starts). */
export async function removeCaptain(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const teamId = str(formData, "teamId");
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const draft = await prisma.draft.findUnique({
    where: { seasonId: season.id },
  });
  // Once the auction has run (or is running), teams have rosters, spend
  // history, and possibly matches — deleting one would tear the season apart.
  if (draft && draft.status !== DRAFT_STATUS.NOT_STARTED) {
    return { error: "The draft has started — captains are locked" };
  }
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { members: true, captain: true },
  });
  if (!team || team.seasonId !== season.id) return { error: "Unknown team" };
  if (team.members.some((m) => !m.isCaptain)) {
    return { error: `${team.name} already has players on its roster` };
  }
  await prisma.team.delete({ where: { id: teamId } });
  refresh();
  return { message: `${team.captain.name} is no longer a captain` };
}

/** Rename a team in the active season (captains can't set their own name). */
export async function renameTeam(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const teamId = str(formData, "teamId");
  const name = str(formData, "name").trim().slice(0, 60);
  if (!name) return { error: "Enter a team name" };
  // Only rename teams in the active season — teamId is client-controlled and
  // archived teams belong to a finished season's record.
  const team = await prisma.team.findFirst({
    where: { id: teamId, seasonId: season.id },
  });
  if (!team) return { error: "Unknown team" };
  await prisma.team.update({ where: { id: team.id }, data: { name } });
  refresh();
  return { message: `Renamed to ${name}` };
}

/**
 * Admin signup moderation — withdraw a bogus/duplicate/ghost signup so it stops
 * counting toward the draft threshold and skewing MMR-weighted budgets. A
 * captain or rostered player must be released/replaced first (withdrawGateError).
 */
export async function withdrawSignup(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const registrationId = str(formData, "registrationId");
  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!reg || reg.seasonId !== season.id) return { error: "Unknown signup" };

  const [captainTeam, membership] = await Promise.all([
    prisma.team.findUnique({
      where: {
        seasonId_captainId: { seasonId: season.id, captainId: reg.userId },
      },
    }),
    prisma.teamMember.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: reg.userId } },
    }),
  ]);
  const gate = withdrawGateError({
    status: reg.status,
    isCaptain: !!captainTeam,
    isRostered: !!membership,
  });
  if (gate) return { error: gate };

  await prisma.registration.update({
    where: { id: reg.id },
    data: { status: REGISTRATION_STATUS.WITHDRAWN },
  });
  refresh();
  return { message: `Withdrew ${reg.user.name}'s signup` };
}

/**
 * Admin correction for a fat-fingered self-reported MMR — clamped 0..12000
 * (players set it on /me; admin can fix it without asking them to re-file).
 */
export async function setRegistrationMmr(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const registrationId = str(formData, "registrationId");
  const mmr = clampInt(formData, "mmr", 0, 0, 12000);
  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!reg || reg.seasonId !== season.id) return { error: "Unknown signup" };
  await prisma.registration.update({
    where: { id: reg.id },
    data: { mmr },
  });
  refresh();
  return { message: `${reg.user.name}'s MMR set to ${mmr}` };
}

/** Randomize the nomination/draft order of teams. */
export async function randomizeDraftOrder(
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
  // The nomination rotation is derived from draftOrder — reshuffling after
  // the auction begins would corrupt whose turn it is.
  const draft = await prisma.draft.findUnique({
    where: { seasonId: season.id },
  });
  if (draft && draft.status !== DRAFT_STATUS.NOT_STARTED) {
    return { error: "The draft has started — order is locked" };
  }
  const teams = await prisma.team.findMany({ where: { seasonId: season.id } });
  const shuffled = [...teams].sort(() => Math.random() - 0.5);
  await prisma.$transaction(
    shuffled.map((t, i) =>
      prisma.team.update({ where: { id: t.id }, data: { draftOrder: i } }),
    ),
  );
  refresh();
  return { message: "Draft order shuffled" };
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

  // One-shot: the auction must never rerun over drafted rosters — re-running
  // resets every budget to its full starting value while purchased TeamMember
  // rows stay, and yanks the whole season back to DRAFT. Same guard family as
  // addCaptain/removeCaptain/randomizeDraftOrder.
  const existingDraft = await prisma.draft.findUnique({
    where: { seasonId: season.id },
    select: { status: true },
  });
  if (existingDraft && existingDraft.status !== DRAFT_STATUS.NOT_STARTED) {
    return {
      error: "The draft has already run — create a new season to redraft",
    };
  }

  const teams = await prisma.team.findMany({
    where: { seasonId: season.id },
    orderBy: { draftOrder: "asc" },
  });
  if (teams.length < 2) return { error: "Need at least 2 captains to draft" };

  // Capacity check: captains are already on their teams, so the pool has to
  // cover the remaining seats. Short is allowed (standins fill in), empty isn't.
  const [regs, existingMembers] = await Promise.all([
    prisma.registration.findMany({
      where: { seasonId: season.id, status: "ACTIVE", type: "PLAYER" },
      select: { userId: true, mmr: true },
    }),
    prisma.teamMember.findMany({
      where: { seasonId: season.id },
      select: { userId: true },
    }),
  ]);
  const draftedIds = new Set(existingMembers.map((m) => m.userId));
  const poolCount = regs.filter((r) => !draftedIds.has(r.userId)).length;
  const openSeats = teams.length * (season.teamSize - 1);
  if (poolCount === 0) {
    return { error: "No signed-up players left to draft" };
  }
  const shortfall = openSeats - poolCount;

  // MMR-weighted budgets: low-MMR captains get more to spend than high-MMR
  // ones (a strong captain is already a strong pick). Weight 0 = flat budgets.
  const mmrByUser = new Map(regs.map((r) => [r.userId, r.mmr]));
  const budgets = mmrWeightedBudgets(
    season.draftBudget,
    season.budgetMmrWeight,
    // `|| null`, not `?? null`: a stored 0 means "MMR unknown" — passing it
    // through as a known MMR would make that captain the pool minimum and
    // hand them the maximum low-MMR budget boost while skewing everyone else.
    teams.map((t) => ({ teamId: t.id, mmr: mmrByUser.get(t.captainId) || null })),
    (season.teamSize - 1) * DEFAULTS.MIN_BID,
  );

  await prisma.$transaction(async (tx) => {
    await Promise.all(
      teams.map((t) =>
        tx.team.update({
          where: { id: t.id },
          data: { budget: budgets.get(t.id) ?? season.draftBudget },
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
  await sendDiscordMessage(draftStartedMessage(season.name));
  refresh();
  const budgetVals = [...budgets.values()];
  const budgetNote =
    Math.max(...budgetVals) !== Math.min(...budgetVals)
      ? ` · MMR-weighted budgets $${Math.min(...budgetVals)}–$${Math.max(...budgetVals)}`
      : "";
  return {
    message:
      shortfall > 0
        ? `Draft started — heads up: ${poolCount} players for ${openSeats} seats, so ${shortfall} seat(s) will go unfilled${budgetNote}`
        : `Draft started — the auction is live${budgetNote}`,
  };
}

/** Generate a round-robin regular-season schedule from the drafted teams. */
export async function generateSchedule(
  _prev: ActionResult,
  formData: FormData,
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

  // Regenerating drops and recreates every regular-season match — fine while
  // the slate is untouched, catastrophic once results are in (games,
  // check-ins, and predictions all cascade away with the matches).
  const [playedCount, gameCount] = await Promise.all([
    prisma.match.count({
      where: {
        seasonId: season.id,
        phase: MATCH_PHASE.REGULAR,
        status: MATCH_STATUS.COMPLETED,
      },
    }),
    prisma.game.count({ where: { match: { seasonId: season.id } } }),
  ]);
  if (playedCount > 0 || gameCount > 0) {
    return {
      error:
        "Results are already recorded — regenerating would erase them. Use the week mover or per-match times to reschedule.",
    };
  }

  // Optional first-match-night: week 1 plays then, each later week +7 days.
  const firstNightRaw = str(formData, "firstNight").trim();
  const firstNight = localDate(formData, "firstNight", "firstNightTs");
  if (firstNightRaw && !firstNight) {
    return { error: "Invalid first match night" };
  }

  const rounds = roundRobin(teams.map((t) => t.id));
  const rows = rounds.flatMap((round, i) =>
    round.map((p) => ({
      seasonId: season.id,
      week: i + 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: p.home,
      awayTeamId: p.away,
      bestOf: season.regularBestOf,
      scheduledAt: firstNight ? matchNightForWeek(firstNight, i + 1) : null,
    })),
  );

  await prisma.$transaction([
    prisma.match.deleteMany({
      where: { seasonId: season.id, phase: MATCH_PHASE.REGULAR },
    }),
    prisma.match.createMany({ data: rows }),
    prisma.season.update({
      where: { id: season.id },
      data: { firstMatchNight: firstNight },
    }),
  ]);
  refresh();
  return {
    message: `Schedule generated · ${rows.length} matches${
      firstNight ? " · match nights set weekly" : ""
    }`,
  };
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
  const status = regularSeasonStatus(matches);
  const pending = pendingResultsMessage(status);
  if (pending) {
    return { error: `${pending} Enter them before starting the playoffs.` };
  }
  // pending === 0 is also true for an EMPTY slate — seeding a bracket off a
  // season that never generated a schedule would be an arbitrary coin flip.
  if (!status.allComplete) {
    return { error: "Generate and play the regular season first" };
  }

  try {
    await createPlayoffBracket(season.id);
  } catch (e) {
    return { error: (e as Error).message };
  }

  // Announce the fresh first-round pairings.
  const [bracket, teams] = await Promise.all([
    prisma.match.findMany({
      where: { seasonId: season.id, phase: { not: MATCH_PHASE.REGULAR } },
      orderBy: { bracketSlot: "asc" },
    }),
    prisma.team.findMany({ where: { seasonId: season.id } }),
  ]);
  const name = new Map(teams.map((t) => [t.id, t.name]));
  await sendDiscordMessage(
    playoffsStartedMessage(
      season.name,
      bracket.map((m) => ({
        home: name.get(m.homeTeamId) ?? "?",
        away: name.get(m.awayTeamId) ?? "?",
      })),
    ),
  );

  refresh();
  return { message: "Playoff bracket created" };
}

/** Record a match result (series score). Sets winner + completed status. */
export async function recordResult(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const matchId = str(formData, "matchId");
  const homeScore = clampInt(formData, "homeScore", 0, 0, 99);
  const awayScore = clampInt(formData, "awayScore", 0, 0, 99);

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) return { error: "Unknown match" };

  const scoreError = seriesScoreError(match.bestOf, homeScore, awayScore);
  if (scoreError) return { error: scoreError };

  if (match.phase !== MATCH_PHASE.REGULAR) {
    // A drawn playoff series would stall the bracket forever: advancement
    // requires a winner, and nothing would ever tell the admin why.
    if (homeScore === awayScore) {
      return {
        error:
          "A playoff series can't end in a draw — record the forfeit/decider winner",
      };
    }
    // Mirror removeGame's locks: once the bracket advanced past this series
    // (or the champion is crowned) a changed winner can't reconcile — the
    // wrong team would stay downstream with no repair path.
    if (match.status === MATCH_STATUS.COMPLETED) {
      const [playoffs, seasonRow] = await Promise.all([
        prisma.match.findMany({
          where: {
            seasonId: match.seasonId,
            phase: { not: MATCH_PHASE.REGULAR },
          },
          select: { bracketSlot: true },
        }),
        prisma.season.findUnique({
          where: { id: match.seasonId },
          select: { status: true },
        }),
      ]);
      const myRound = slotRound(match.bracketSlot);
      if (playoffs.some((p) => slotRound(p.bracketSlot) > myRound)) {
        return {
          error:
            "This series already advanced the bracket — recreate the bracket to correct it",
        };
      }
      if (seasonRow?.status === SEASON_STATUS.COMPLETE) {
        return {
          error:
            "The champion is already crowned — recreate the bracket to correct playoff results",
        };
      }
    }
  }

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

  // Manual results move standings too — bump the sync cursor so parked
  // dashboards repaint on their next /api/sync poll.
  await stampResultChange();
  // An explicit admin save always announces (corrections included), but it
  // stamps the once-per-match marker so recomputeSeries (a later game import
  // for this match) can't post the same result a second time.
  await prisma.setting.upsert({
    where: { key: `resultAnnounced:${matchId}` },
    create: {
      key: `resultAnnounced:${matchId}`,
      value: new Date().toISOString(),
    },
    update: { value: new Date().toISOString() },
  });
  const [home, away] = await Promise.all([
    prisma.team.findUnique({ where: { id: match.homeTeamId } }),
    prisma.team.findUnique({ where: { id: match.awayTeamId } }),
  ]);
  if (home && away) {
    await sendDiscordMessage(
      matchResultMessage({
        homeName: home.name,
        awayName: away.name,
        homeScore,
        awayScore,
        week: match.week,
        isPlayoff: match.phase !== MATCH_PHASE.REGULAR,
      }),
    );
  }

  // Playoff results auto-advance the bracket (and crown the champion at the end).
  if (match.phase !== MATCH_PHASE.REGULAR) {
    await advancePlayoffBracket(match.seasonId);
  } else {
    // Manual results can also close out a week — send its honors (idempotent).
    await maybeAnnounceWeekHonors(match.seasonId, match.week);
  }
  refresh();
  return { message: `Result saved · ${homeScore}–${awayScore}` };
}

/**
 * Permanently add an undrafted (or late-registered) player to a team with an
 * open roster seat — how short teams get topped up after the draft.
 */
export async function signFreeAgent(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.SIGNUPS) {
    return { error: "Run the draft first — signings are for after it" };
  }
  if (season.status === SEASON_STATUS.COMPLETE) {
    return { error: "The season is over" };
  }
  // While the auction is LIVE, roster writes belong to the draft engine
  // alone — signing the nominated player wedges every draft poll on a
  // unique-constraint throw. The pool-dry top-up window is Draft COMPLETE.
  if (season.status === SEASON_STATUS.DRAFT) {
    const draftRow = await prisma.draft.findUnique({
      where: { seasonId: season.id },
    });
    if (draftRow && draftRow.status !== DRAFT_STATUS.COMPLETE) {
      return { error: "The draft is still running — top up rosters after it" };
    }
  }

  const teamId = str(formData, "teamId");
  const userId = str(formData, "userId");

  const [team, registration, existingSeat, memberCount] = await Promise.all([
    prisma.team.findFirst({
      where: { id: teamId, seasonId: season.id },
      include: { captain: true },
    }),
    prisma.registration.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId } },
      include: { user: true },
    }),
    prisma.teamMember.findFirst({
      where: { seasonId: season.id, userId },
    }),
    prisma.teamMember.count({ where: { teamId } }),
  ]);
  if (!team) return { error: "Unknown team" };
  if (!registration || registration.status !== "ACTIVE") {
    return { error: "That player isn't registered for this season" };
  }
  // Standins fill single matches, not roster seats — signing one would leave
  // them straddling both worlds (in the standin pool AND on a roster).
  if (registration.type !== REGISTRATION_TYPE.PLAYER) {
    return { error: "That signup is a standin — only full players can be signed" };
  }
  if (existingSeat) return { error: "That player is already on a team" };
  if (memberCount >= season.teamSize) {
    return { error: `${team.name} has no open roster seats` };
  }

  // Transaction with a re-check: two concurrent signs into a team's last
  // seat would both pass the count read above and overfill the roster.
  try {
    await prisma.$transaction(async (tx) => {
      const seats = await tx.teamMember.count({ where: { teamId } });
      if (seats >= season.teamSize) throw new Error("SEAT_TAKEN");
      await tx.teamMember.create({
        data: {
          seasonId: season.id,
          teamId,
          userId,
          price: 0,
          isCaptain: false,
        },
      });
    });
  } catch (e) {
    if ((e as Error).message === "SEAT_TAKEN") {
      return { error: `${team.name} has no open roster seats` };
    }
    if ((e as { code?: string }).code === "P2002") {
      return { error: "That player was just signed elsewhere" };
    }
    throw e;
  }
  await sendDiscordMessage(
    freeAgentSignedMessage(registration.user.name, team.name),
  );
  refresh();
  return { message: `${registration.user.name} signed to ${team.name}` };
}

/**
 * Release a non-captain from their roster — they go back to the free-agent
 * pool (their registration stays ACTIVE) and can be signed elsewhere.
 */
export async function releasePlayer(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.SIGNUPS) {
    return { error: "There are no rosters before the draft" };
  }
  if (season.status === SEASON_STATUS.COMPLETE) {
    return { error: "The season is over" };
  }
  // A LIVE auction owns the rosters: releasing a just-sold player deletes
  // the seat without refunding the budget and re-lists them for a second
  // auction. Releases wait for the draft to finish.
  if (season.status === SEASON_STATUS.DRAFT) {
    const draftRow = await prisma.draft.findUnique({
      where: { seasonId: season.id },
    });
    if (draftRow && draftRow.status !== DRAFT_STATUS.COMPLETE) {
      return { error: "The draft is still running — release players after it" };
    }
  }

  const memberId = str(formData, "memberId");
  const member = await prisma.teamMember.findFirst({
    where: { id: memberId, seasonId: season.id },
    include: { user: true, team: true },
  });
  if (!member) return { error: "Unknown roster spot" };
  if (member.isCaptain) {
    return { error: "Captains can't be released — the team is theirs" };
  }

  await prisma.teamMember.delete({ where: { id: member.id } });
  await sendDiscordMessage(
    playerReleasedMessage(member.user.name, member.team.name),
  );
  refresh();
  return { message: `${member.user.name} released from ${member.team.name}` };
}

/** Assign a standin to fill in for a rostered player in a specific match. */
export async function assignStandin(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const matchId = str(formData, "matchId");
  const standinUserId = str(formData, "standinUserId");
  const replacingUserId = str(formData, "replacingUserId");
  if (!matchId || !standinUserId || !replacingUserId)
    return { error: "Pick a standin and the player they cover" };
  if (standinUserId === replacingUserId)
    return { error: "A player can't stand in for themselves" };

  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { games: { select: { id: true } } },
  });
  if (!match) return { error: "Unknown match" };
  if (match.status === MATCH_STATUS.COMPLETED)
    return { error: "This match is already played" };

  // The standin must be a real signup who ISN'T on a roster this season — a
  // rostered player covering another team would land in BOTH account sets on
  // import, mis-crediting their box-score lines (a "double agent").
  const [standinReg, standinRoster] = await Promise.all([
    prisma.registration.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: standinUserId } },
    }),
    prisma.teamMember.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: standinUserId } },
    }),
  ]);
  if (!standinReg || standinReg.status !== "ACTIVE")
    return { error: "That standin has no active signup this season" };
  if (standinRoster)
    return { error: "That player is on a roster — they can't stand in" };

  // The replaced player's roster tells us which team the standin fills for.
  const membership = await prisma.teamMember.findUnique({
    where: { seasonId_userId: { seasonId: season.id, userId: replacingUserId } },
  });
  if (!membership) return { error: "Replaced player is not on a team" };
  if (
    membership.teamId !== match.homeTeamId &&
    membership.teamId !== match.awayTeamId
  ) {
    return { error: "That player's team isn't in this match" };
  }

  // One standin covers one seat in one match — assigning the same person to
  // both sides (or twice) would double-count their stats on import.
  const already = await prisma.standinAssignment.findFirst({
    where: { matchId, standinUserId },
  });
  if (already)
    return { error: "That standin is already assigned to this match" };

  await prisma.standinAssignment.create({
    data: { matchId, teamId: membership.teamId, standinUserId, replacingUserId },
  });
  refresh();
  return {
    message:
      "Standin assigned" +
      (match.games.length > 0
        ? " — heads up: already-imported games keep their original attribution"
        : ""),
  };
}

/** Remove a standin assignment. */
export async function removeStandin(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const id = str(formData, "assignmentId");
  const assignment = await prisma.standinAssignment.findUnique({
    where: { id },
    include: { match: { include: { games: { select: { id: true } } } } },
  });
  if (!assignment) return { error: "That assignment is already gone" };
  // Once games are in the books the assignment is part of the record: later
  // imports would silently drop the standin's stats (or fail classification),
  // and removing it from a played match erases the "in for" history.
  if (assignment.match.status === MATCH_STATUS.COMPLETED)
    return { error: "This match is already played — the assignment is history" };
  if (assignment.match.games.length > 0)
    return {
      error:
        "Games are already imported — removing the standin now would strip them from the rest of the series",
    };
  await prisma.standinAssignment.delete({ where: { id } });
  refresh();
  return { message: "Standin assignment removed" };
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
  refreshGames();
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
  refreshGames();
  return {
    ok: true,
    message: `Scanned ${res.scanned} players · imported ${res.imported} game(s)`,
  };
}

/** Remove an imported game and recompute the series. */
export async function removeGame(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const gameId = str(formData, "gameId");
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { match: true },
  });
  if (!game) return { error: "That game is already gone" };

  // Once a decided playoff series has advanced (a later round exists), the
  // bracket can't reconcile a changed winner — removing the game would strand
  // the wrong team downstream with no way to re-advance.
  if (
    game.match.phase !== MATCH_PHASE.REGULAR &&
    game.match.status === MATCH_STATUS.COMPLETED
  ) {
    const playoffs = await prisma.match.findMany({
      where: {
        seasonId: game.match.seasonId,
        phase: { not: MATCH_PHASE.REGULAR },
      },
      select: { bracketSlot: true },
    });
    const myRound = slotRound(game.match.bracketSlot);
    if (playoffs.some((p) => slotRound(p.bracketSlot) > myRound)) {
      return {
        error:
          "This playoff series already advanced the bracket — recreate the bracket to correct it",
      };
    }
    // Same trap one round later: once the final crowned a champion the season
    // is COMPLETE and advancePlayoffBracket will never re-crown.
    const season = await prisma.season.findUnique({
      where: { id: game.match.seasonId },
      select: { status: true },
    });
    if (season?.status === SEASON_STATUS.COMPLETE) {
      return {
        error:
          "The champion is already crowned — recreate the bracket to correct playoff results",
      };
    }
  }

  await prisma.game.deleteMany({ where: { id: gameId } });
  await recomputeSeries(game.matchId);
  refreshGames();
  return { message: "Game removed — series recomputed" };
}

/**
 * Move a whole week's match night (holiday, venue clash…): every unplayed
 * match in the week gets the new time; optionally later weeks' scheduled,
 * unplayed matches shift by the same delta so the weekly rhythm survives.
 */
export async function setWeekNight(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const week = Number(str(formData, "week"));
  const cascade = str(formData, "cascade") === "on";
  const night = localDate(formData, "night", "nightTs");
  if (!Number.isInteger(week) || week < 1) return { error: "Pick a week" };
  if (!night) return { error: "Pick a valid date & time" };

  const open = await prisma.match.findMany({
    where: { seasonId: season.id, week, status: { not: "COMPLETED" } },
  });
  if (open.length === 0)
    return { error: `Week ${week} has no unplayed matches to move` };

  // The delta later weeks shift by, measured from the week's CANONICAL night —
  // the most common scheduledAt (earliest on a tie). A single captain-
  // rescheduled outlier must not become the baseline, or the cascade shifts
  // every later week by days in the wrong direction.
  const timeCounts = new Map<number, number>();
  for (const m of open) {
    if (!m.scheduledAt) continue;
    const t = m.scheduledAt.getTime();
    timeCounts.set(t, (timeCounts.get(t) ?? 0) + 1);
  }
  const current = [...timeCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0] - b[0],
  )[0]?.[0];

  const later =
    cascade && current != null
      ? await prisma.match.findMany({
          where: {
            seasonId: season.id,
            week: { gt: week },
            status: { not: "COMPLETED" },
            scheduledAt: { not: null },
          },
        })
      : [];
  const delta = current != null ? night.getTime() - current : 0;

  // One transaction: the move + cascade land together or not at all (a
  // half-shifted schedule can't be re-run — the delta would compute as 0),
  // and every retimed match sheds its now-stale RSVPs and open proposals
  // (an old PENDING proposal accepted later would silently revert this move).
  const retimedIds = [
    ...open.map((m) => m.id),
    ...(delta !== 0 ? later.map((m) => m.id) : []),
  ];
  await prisma.$transaction([
    prisma.match.updateMany({
      where: { seasonId: season.id, week, status: { not: "COMPLETED" } },
      data: { scheduledAt: night },
    }),
    ...(delta !== 0
      ? later.map((m) =>
          prisma.match.update({
            where: { id: m.id },
            data: { scheduledAt: new Date(m.scheduledAt!.getTime() + delta) },
          }),
        )
      : []),
    // Keep future playoff rounds on the shifted rhythm too — they're timed
    // from firstMatchNight when created.
    ...(delta !== 0 && season.firstMatchNight
      ? [
          prisma.season.update({
            where: { id: season.id },
            data: {
              firstMatchNight: new Date(
                season.firstMatchNight.getTime() + delta,
              ),
            },
          }),
        ]
      : []),
    prisma.matchAvailability.deleteMany({
      where: { matchId: { in: retimedIds } },
    }),
    prisma.rescheduleRequest.updateMany({
      where: { matchId: { in: retimedIds }, status: "PENDING" },
      data: { status: "CANCELLED" },
    }),
  ]);
  const shifted = delta !== 0 ? later.length : 0;
  refresh();
  return {
    ok: true,
    message:
      `Week ${week} moved (${open.length} match${open.length === 1 ? "" : "es"})` +
      (cascade
        ? shifted > 0
          ? ` · ${shifted} later match${shifted === 1 ? "" : "es"} shifted with it`
          : current != null
            ? " · later weeks unchanged (no time change)"
            : " · couldn't cascade (week had no previous time)"
        : "") +
      " · RSVPs and open proposals on retimed matches were reset",
  };
}

/** Set or clear a match's scheduled date/time (from a datetime-local input). */
export async function setMatchTime(formData: FormData) {
  await requireAdmin();
  const matchId = str(formData, "matchId");
  const raw = str(formData, "scheduledAt").trim();
  const scheduledAt = localDate(formData, "scheduledAt", "scheduledAtTs");
  if (raw && !scheduledAt) return; // invalid input — leave the time alone
  const before = await prisma.match.findUnique({
    where: { id: matchId },
    select: { scheduledAt: true },
  });
  const changed = before?.scheduledAt?.getTime() !== scheduledAt?.getTime();
  await prisma.$transaction([
    prisma.match.update({ where: { id: matchId }, data: { scheduledAt } }),
    // A retime invalidates night-specific state: RSVPs answered the OLD
    // night, and an open proposal accepted later would revert this change.
    ...(changed
      ? [
          prisma.matchAvailability.deleteMany({ where: { matchId } }),
          prisma.rescheduleRequest.updateMany({
            where: { matchId, status: "PENDING" },
            data: { status: "CANCELLED" },
          }),
        ]
      : []),
  ]);
  refresh();
}

/** Fetch every active player's ranked medal from OpenDota (a draft resource). */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch + store ranked medals for a set of users. Non-destructive: retries once
 * on a failed/rate-limited call, and only ever writes a real medal — never
 * overwrites a stored one with a null (whether the null is "couldn't reach
 * OpenDota" or "OpenDota returned no rank"), so a rate-limited run can't wipe
 * everyone's rank. Shared by the registrant sync and the all-accounts backfill.
 */
async function syncRanksFor(
  users: { id: string; dotaAccountId: number | null; steamId: string }[],
): Promise<{ ranked: number; unreachable: number }> {
  let ranked = 0;
  let unreachable = 0;
  for (const u of users) {
    const acc = u.dotaAccountId ?? steamIdToAccountId(u.steamId);
    if (!acc) continue;
    // A bulk sync easily trips OpenDota's free rate limit (HTTP 429) or an 8s
    // timeout — a brief back-off + one retry usually clears it.
    let result = await fetchRankTier(acc);
    if (!result.ok) {
      await sleep(700);
      result = await fetchRankTier(acc);
    }
    if (!result.ok) {
      unreachable++;
      continue;
    }
    if (result.rankTier == null) continue;
    await prisma.user.update({
      where: { id: u.id },
      data: { rankTier: result.rankTier },
    });
    ranked++;
  }
  return { ranked, unreachable };
}

/** "N couldn't be reached" suffix with a re-run / API-key hint, or "". */
function unreachableTail(unreachable: number): string {
  return unreachable
    ? ` · ${unreachable} couldn't be reached (rate limit? run it again${process.env.OPENDOTA_API_KEY ? "" : " — an OPENDOTA_API_KEY raises the limit"})`
    : "";
}

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
  const { ranked, unreachable } = await syncRanksFor(regs.map((r) => r.user));
  refresh();
  return {
    message: `Synced ${regs.length} players · ${ranked} ranked${unreachableTail(unreachable)}`,
  };
}

/**
 * Backfill medals for EVERY account that doesn't have one yet — including people
 * who logged in but never signed up (the registrant sync above skips them).
 * Only targets null-medal accounts, so it makes no wasted API calls and never
 * touches a medal that's already set; login fills in new accounts going forward.
 */
export async function syncAllRanks(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const users = await prisma.user.findMany({ where: { rankTier: null } });
  if (users.length === 0) {
    return { message: "Every account already has a medal" };
  }
  const { ranked, unreachable } = await syncRanksFor(users);
  refresh();
  return {
    message: `Checked ${users.length} account(s) without a medal · ${ranked} now ranked${unreachableTail(unreachable)}`,
  };
}

/**
 * Break-glass: invalidate EVERY signed-in session (advances the session epoch).
 * Use if a token may have leaked / an account is compromised — everyone,
 * including the admin who ran it, must log in again. Normal logout is unchanged.
 */
export async function revokeAllSessions(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  await bumpSessionEpoch();
  refresh();
  return {
    message: "Signed out all users — everyone must log in again.",
  };
}

/** Set the active season's soft MMR limit / review threshold (0 = none). */
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

/**
 * Set (or clear) the per-season weekly match slot shown before signup.
 * Empty clears it back to the app-wide default (MATCH_SCHEDULE.label).
 */
export async function setMatchSchedule(formData: FormData) {
  await requireAdmin();
  const season = await getActiveSeason();
  if (!season) return;
  const value = str(formData, "matchSchedule").trim().slice(0, 80);
  await prisma.season.update({
    where: { id: season.id },
    data: { matchSchedule: value || null },
  });
  refresh();
}

/** Save the Discord webhook used for league announcements. */
export async function setDiscordWebhook(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const value = str(formData, "discordWebhookUrl").trim();
  // The field renders EMPTY on purpose — the saved URL is a secret we never
  // send back to the browser. So a blank submit must be a no-op, not a wipe;
  // turning announcements off is the explicit clearDiscordWebhook action.
  if (!value) {
    return {
      message: "No change — paste a new URL to replace it, or use Remove.",
    };
  }
  if (!/^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(value)) {
    return {
      error:
        "That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/…)",
    };
  }
  await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, value);
  refresh();
  return { message: "Webhook saved — announcements are on" };
}

/** Turn off Discord announcements by removing the stored webhook. */
export async function clearDiscordWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, "");
  refresh();
  return { message: "Webhook removed — announcements are off" };
}

/** Post a test message so the admin can confirm the webhook works. */
export async function testDiscordWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const configured =
    (await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL)) ||
    process.env.DISCORD_WEBHOOK_URL;
  if (!configured) return { error: "Set a webhook URL first" };
  const ok = await sendDiscordMessage(testMessage());
  return ok
    ? { message: "Test message sent — check your Discord" }
    : { error: "Discord rejected the message — double-check the URL" };
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
  refreshGames();
  return {
    message: `League sync · imported ${res.imported} of ${res.scanned} league games`,
  };
}

/** Backfill report-card stats (benchmarks, XPM…) onto older imported games. */
export async function enrichGamesAction(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await enrichStoredGames();
  if (res.enriched === 0 && res.remaining === 0) {
    return { message: "Every stored game already has report-card data" };
  }
  refreshGames();
  return {
    message: `Enriched ${res.enriched} game(s)${
      res.failed ? ` · ${res.failed} not on OpenDota right now` : ""
    }${res.remaining ? ` · ${res.remaining} to go — run again` : ""}`,
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

/** Set (or clear) the draft night — announced with countdowns during signups. */
export async function setDraftNight(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };

  const raw = str(formData, "draftAt").trim();
  const when = localDate(formData, "draftAt", "draftAtTs");
  if (raw && !when) return { error: "Invalid draft night" };

  await prisma.season.update({
    where: { id: season.id },
    data: { draftAt: when },
  });
  // Best-effort announcement — the countdown surfaces update either way.
  if (when) {
    await sendDiscordMessage(draftScheduledMessage(season.name, when.getTime()));
  }
  refresh();
  return { message: when ? "Draft night set 🗓️" : "Draft night cleared" };
}

/**
 * Promote an ACTIVE standin registration to a full PLAYER — the mid-season
 * roster refill. Self-serve PLAYER signups close after SIGNUPS
 * (registrationGate) and signFreeAgent refuses standins, so without this the
 * only path to fill an abandoned seat was flipping the whole season back to
 * SIGNUPS. Flow: late joiner registers as standin on /me → admin promotes →
 * signs them via the free-agent form (which does the Discord announcement).
 */
export async function promoteStandinToPlayer(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const userId = str(formData, "userId");

  const [registration, draftRow, pendingAssignments] = await Promise.all([
    prisma.registration.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId } },
      include: { user: true },
    }),
    prisma.draft.findUnique({ where: { seasonId: season.id } }),
    prisma.standinAssignment.count({
      where: {
        standinUserId: userId,
        match: { seasonId: season.id, status: { not: MATCH_STATUS.COMPLETED } },
      },
    }),
  ]);
  if (!registration) {
    return { error: "That person isn't registered for this season" };
  }
  const gateError = promoteGateError({
    seasonStatus: season.status,
    draftStatus: draftRow?.status ?? null,
    registrationStatus: registration.status,
    registrationType: registration.type,
    pendingAssignments,
  });
  if (gateError) return { error: gateError };

  await prisma.registration.update({
    where: { id: registration.id },
    data: { type: REGISTRATION_TYPE.PLAYER },
  });
  refresh();
  return {
    message: `${registration.user.name} is now a full player — sign them onto a team in Roster moves`,
  };
}
