import { Prisma } from "@prisma/client";
import { randomInt } from "node:crypto";
import { prisma } from "./prisma";
import { DOTA_MATCH_KIND, MATCH_PHASE, SEASON_STATUS } from "./constants";
import { projectPlayoffField } from "./playoff-field";
import { playoffSetupRevision } from "./playoff-command";
import { regularSeasonStatus } from "./schedule-status";
import { upcomingMatchNight } from "./schedule";
import { parseTiebreakerStage, tiebreakerSlot, type TiebreakerGroup } from "./tiebreakers";
import { parseSingleTiebreakerSlot } from "./tiebreaker-format";
import { singleEliminationPlan } from "./single-elimination";
import { UserFacingError } from "./user-facing-error";
import { hasConfirmedScrimConflict } from "./scrim-schedule-conflict";
import { raceHook } from "./race-hook";
import { resultAnnouncedKey, stampResultChange, tiebreakerGamesArchiveKey, weekReminderKey } from "./settings";

// Same snapshot as the admin's playoff/tiebreaker confirmation. Child rows
// matter during Reset because deleting a match cascades their commitments.
const matchInclude = {
  games: { select: { id: true, dotaMatchId: true } },
  availability: { select: { id: true, userId: true, status: true } },
  standins: { select: {
    id: true, teamId: true, standinUserId: true, replacingUserId: true,
    standin: { select: { name: true, discordId: true } },
  } },
  predictions: { select: { id: true, userId: true, pickedTeamId: true } },
  reschedules: { select: { id: true, proposedById: true, proposedTime: true, status: true } },
} satisfies Prisma.MatchInclude;

async function snapshot(tx: Prisma.TransactionClient, seasonId: string, expectedRevision?: string) {
  const season = await tx.season.findUnique({ where: { id: seasonId } });
  if (!season?.isActive || season.status !== SEASON_STATUS.REGULAR_SEASON) {
    throw new UserFacingError("Tiebreakers can only be managed during the active regular season. Return from playoffs first if the bracket needs correcting.");
  }
  const [teams, matches] = await Promise.all([
    tx.team.findMany({ where: { seasonId } }),
    tx.match.findMany({ where: { seasonId }, include: matchInclude }),
  ]);
  if (matches.some((m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL)) {
    throw new UserFacingError("The playoff bracket already exists. Return to the regular season before changing tiebreakers.");
  }
  if (expectedRevision && playoffSetupRevision({ season, teams, matches }) !== expectedRevision) {
    throw new UserFacingError("The standings, tiebreaker fixtures, or match activity changed. Reload before trying again.");
  }
  return { season, teams, matches };
}

async function serializable<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if ((error as { code?: string }).code === "P2034") {
      throw new UserFacingError("The season or tiebreaker results changed while this action was running. Reload and try again.");
    }
    throw error;
  }
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** A reset keeps the original draw for the same standings; it cannot reroll a bye. */
async function openingDraw(tx: Prisma.TransactionClient, seasonId: string, group: TiebreakerGroup) {
  const key = `tiebreakerDraw:${seasonId}:${group.key}`;
  const existing = await tx.setting.findUnique({ where: { key } });
  if (existing) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing.value); } catch { /* Refuse corrupt draw below. */ }
    if (!Array.isArray(parsed) || parsed.length !== group.teamIds.length || new Set(parsed).size !== group.teamIds.length ||
        parsed.some((id) => typeof id !== "string" || !group.teamIds.includes(id))) {
      throw new UserFacingError("The saved opening draw needs an administrator's review. No new tiebreaker fixture was created.");
    }
    return parsed as string[];
  }
  const draw = [...group.teamIds];
  for (let i = draw.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [draw[i], draw[j]] = [draw[j], draw[i]];
  }
  await tx.setting.create({ data: { key, value: JSON.stringify(draw) } });
  return draw;
}

async function scheduleMissingGroups(tx: Prisma.TransactionClient, source: Snapshot, automatic: boolean) {
    const { season, teams, matches } = source;
    const seasonId = season.id;
    if (!regularSeasonStatus(matches).allComplete) {
      if (automatic) return null;
      throw new UserFacingError("Complete every regular-season result before scheduling a tiebreaker week.");
    }
    const field = projectPlayoffField(teams, matches);
    if (field.tiebreakers.error) throw new UserFacingError(field.tiebreakers.error);
    const continuation = (g: TiebreakerGroup) =>
      g.format === "BO1_SINGLE_ELIMINATION" ? !g.drawRequired :
        g.format === "BO1_DOUBLE_ELIMINATION" && (g.stage ?? 0) > 1;
    const groups = field.tiebreakers.groups.filter((g) => g.status === "needed" && !g.blocked &&
      (automatic ? continuation(g) : !field.tiebreakers.pending || continuation(g)));
    if (!groups.length) {
      if (automatic) return null;
      if (field.tiebreakers.pending) throw new UserFacingError("Finish the scheduled tiebreaker matches before creating another round.");
      throw new UserFacingError("There are no unresolved ties affecting playoff qualification or seeding.");
    }
    const nextWeek = Math.max(0, ...matches.map((m) => m.week)) + 1;
    const latestKickoff = Math.max(0, ...matches.map((m) => m.scheduledAt?.getTime() ?? 0));
    const night = season.firstMatchNight
      ? upcomingMatchNight(season.firstMatchNight, nextWeek, Math.max(Date.now(), latestKickoff + 1))
      : null;
    const data: Prisma.MatchCreateManyInput[] = [];
    for (const group of groups) {
      if (group.format === "BO1_SINGLE_ELIMINATION") {
        const parsed = parseSingleTiebreakerSlot(group.key);
        const opening = parsed ? matches.filter((m) =>
          parseSingleTiebreakerSlot(m.bracketSlot)?.tournamentKey === parsed.tournamentKey,
        ).sort((a, b) => a.week - b.week)[0] : null;
        if (!group.drawRequired && !opening) throw new UserFacingError("The tiebreaker opening fixture is missing. Reload before continuing.");
        const draw = group.drawRequired ? await openingDraw(tx, seasonId, group) : null;
        const drawKey = draw ? `${group.key}:${draw.map((id) => group.teamIds.indexOf(id)).join(".")}` : null;
        const ready = draw && drawKey
          ? singleEliminationPlan(draw, group.qualifyingPlaces!, drawKey).games.filter((game) => game.home.teamId && game.away.teamId)
            .map((game) => ({ home: game.home.teamId!, away: game.away.teamId!, slot: game.key }))
          : group.pairings.map((pair) => ({ ...pair, slot: group.key }));
        // Independent openings share one kickoff. Descendants start as soon
        // as their own feeders finish, even while other trees are still playing.
        const scheduledAt = opening ? new Date() : night;
        for (const pair of ready) {
          if (scheduledAt && await hasConfirmedScrimConflict(tx, { seasonId, teamIds: [pair.home, pair.away], scheduledAt })) {
            throw new UserFacingError("A tied team has a booked scrim near kickoff. Move or cancel the scrim before continuing.");
          }
          data.push({ seasonId, week: opening?.week ?? nextWeek, phase: MATCH_PHASE.TIEBREAKER,
            homeTeamId: pair.home, awayTeamId: pair.away, bestOf: 1, bracketSlot: pair.slot, scheduledAt });
        }
        continue;
      }
      const stage = parseTiebreakerStage(tiebreakerSlot(group, 0));
      const opening = continuation(group) ? matches.find((m) => {
        const stored = parseTiebreakerStage(m.bracketSlot);
        return stored?.bracketKey === stage?.bracketKey && stored?.stage === 1;
      }) : null;
      if (continuation(group) && !opening) throw new UserFacingError("The tiebreaker opening fixture is missing. Reset the tiebreaker week before continuing.");
      const week = opening?.week ?? nextWeek;
      // All BO1 stages belong to the opening week. Reserve 90 minutes per
      // game, allowing a short break if a result arrives after its planned slot.
      const scheduledAt = opening
        ? opening.scheduledAt ? new Date(Math.max(
          opening.scheduledAt.getTime() + ((group.stage ?? 1) - 1) * 90 * 60_000,
          Date.now() + 10 * 60_000,
        )) : null
        : group.teamIds.length <= 3 ? night : null;
      const pairings = group.drawRequired
        ? await openingDraw(tx, seasonId, group).then(([home, away]) => [{ home, away }])
        : group.pairings;
      if (scheduledAt && await hasConfirmedScrimConflict(tx, { seasonId, teamIds: group.teamIds, scheduledAt })) {
        throw new UserFacingError("A tied team has a booked scrim near the tiebreaker kickoff. Move or cancel the scrim before scheduling the week.");
      }
      data.push(...pairings.map((pair, i) => ({
        seasonId, week, phase: MATCH_PHASE.TIEBREAKER,
        homeTeamId: pair.home, awayTeamId: pair.away,
        bestOf: group.bestOf, bracketSlot: tiebreakerSlot(group, i), scheduledAt,
      })));
    }
    await raceHook("tiebreakers.create.afterSnapshot");
    await tx.match.createMany({ data });
    // A common row write also serializes independent group creation, phase
    // transitions and result imports against this authoritative snapshot.
    const week = Math.max(...data.map((m) => m.week));
    await tx.season.update({ where: { id: seasonId }, data: { currentWeek: Math.max(season.currentWeek, week) } });
    await stampResultChange(tx);
    return { week, matchCount: data.length, untimedCount: data.filter((m) => !m.scheduledAt).length };
}

/** Create the first slate or an explicitly reviewed recovery stage. */
export async function createTiebreakerWeek(seasonId: string, expectedRevision?: string) {
  return serializable(async (tx) => {
    const source = await snapshot(tx, seasonId, expectedRevision);
    return (await scheduleMissingGroups(tx, source, false))!;
  });
}

/** Idempotent post-result recovery; never starts an unrequested tiebreaker week. */
export async function advanceTiebreakerWeek(seasonId: string): Promise<void> {
  await serializable(async (tx) => {
    const season = await tx.season.findUnique({ where: { id: seasonId } });
    if (!season?.isActive || season.status !== SEASON_STATUS.REGULAR_SEASON) return;
    const existing = await tx.match.findFirst({ where: { seasonId, phase: MATCH_PHASE.TIEBREAKER } });
    if (!existing) return;
    const source = await snapshot(tx, seasonId);
    await scheduleMissingGroups(tx, source, true);
  });
}

type ArchivedGame = { dotaMatchId: string; slot: string | null; week: number };

/** Remove a stale/reviewed slate, preserving all imported game IDs for recovery. */
export async function clearTiebreakerWeek(seasonId: string, expectedRevision?: string) {
  return serializable(async (tx) => {
    const { teams, matches } = await snapshot(tx, seasonId, expectedRevision);
    const extra = matches.filter((m) => m.phase === MATCH_PHASE.TIEBREAKER);
    if (!extra.length) throw new UserFacingError("There is no tiebreaker week to reset.");
    const ids = extra.map((m) => m.id);
    const teamName = new Map(teams.map((team) => [team.id, team.name]));
    // Snapshot the people whose bookings will cascade away, before the reset
    // writes. The action can stand them down after commit without another read.
    const standDowns = extra.flatMap((match) => match.standins.map((assignment) => ({
      standinName: assignment.standin.name,
      discordId: assignment.standin.discordId,
      teamName: teamName.get(assignment.teamId) ?? "their team",
      homeName: teamName.get(match.homeTeamId) ?? "home team",
      awayName: teamName.get(match.awayTeamId) ?? "away team",
      week: match.week,
    })));
    const games: ArchivedGame[] = extra.flatMap((m) => m.games.map((game) => ({
      dotaMatchId: game.dotaMatchId, slot: m.bracketSlot, week: m.week,
    })));
    const key = tiebreakerGamesArchiveKey(seasonId);
    const prior = await tx.setting.findUnique({ where: { key } });
    let archive: ArchivedGame[] = [];
    if (prior) {
      try {
        const parsed: unknown = JSON.parse(prior.value);
        if (!Array.isArray(parsed) || parsed.some((g) => !g || typeof g.dotaMatchId !== "string")) throw new Error();
        archive = parsed as ArchivedGame[];
      } catch {
        throw new UserFacingError("The saved tiebreaker game recovery list needs repair before resetting. No fixtures were removed.");
      }
    }
    await raceHook("tiebreakers.reset.afterSnapshot");
    if (games.length) {
      const value = JSON.stringify([...new Map([...archive, ...games].map((g) => [g.dotaMatchId, g])).values()]);
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
      await tx.dotaMatchClaim.deleteMany({ where: { kind: DOTA_MATCH_KIND.LEAGUE, dotaMatchId: { in: games.map((g) => g.dotaMatchId) } } });
    }
    await tx.setting.deleteMany({ where: { OR: [
      { key: { in: ids.map(resultAnnouncedKey) } },
      ...[...new Set(extra.map((m) => m.week))].map((week) => ({ key: { startsWith: `${weekReminderKey(seasonId, week)}:` } })),
    ] } });
    await tx.match.deleteMany({ where: { seasonId, phase: MATCH_PHASE.TIEBREAKER } });
    await tx.season.update({ where: { id: seasonId }, data: {
      currentWeek: Math.max(0, ...matches.filter((m) => m.phase === MATCH_PHASE.REGULAR).map((m) => m.week)),
    } });
    await stampResultChange(tx);
    return { matchCount: extra.length, removedGameCount: games.length, standDowns,
      checkins: extra.reduce((n, m) => n + m.availability.length, 0),
      standins: extra.reduce((n, m) => n + m.standins.length, 0),
      predictions: extra.reduce((n, m) => n + m.predictions.length, 0),
      reschedules: extra.reduce((n, m) => n + m.reschedules.length, 0) };
  });
}
