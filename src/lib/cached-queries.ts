import { prisma } from "./prisma";
import { createPublicSnapshot } from "./public-cache";
import { getSeasonHonorReadiness } from "./honors-readiness-service";
import { compareRecordChronology } from "./records";
import type { HeroPageGame } from "./hero-games";
import {
  fetchPublicGameSnapshot,
  getPublicGameSnapshot,
  fetchPublicMatchContext,
  fetchPublicTeamNames,
  getPublicMatchContext,
  getPublicTeamNames,
  type PublicGameSnapshot,
  type PublicMatchContext,
  type PublicTeamNames,
} from "./public-game-snapshot";

// Viewer-independent projections share one games-tagged, 60-second snapshot
// instead of independently scanning all history for metadata, careers and
// records. Season readers keep their SQL predicate. Session/permission reads
// remain outside this cache. The fetch* seams bypass it for equivalence tests.

const gameLines = (games: PublicGameSnapshot) =>
  games.map(({ id, players }) => ({ id, players }));
const gameScores = (games: PublicGameSnapshot) =>
  games.map(({ players, radiantWin }) => ({ players, radiantWin }));

function recordGames(games: PublicGameSnapshot, contexts: PublicMatchContext, teams: PublicTeamNames) {
  const byMatch = new Map(contexts.map((match) => [match.id, match]));
  const byTeam = new Map(teams.map((team) => [team.id, team.name]));
  return games.flatMap(({ id, startTime, matchId, radiantWin, durationSecs,
    radiantScore, direScore, players }) => {
    const match = byMatch.get(matchId);
    if (!match) return []; // A concurrent deletion can finish an older render.
    const home = byTeam.get(match.homeTeamId), away = byTeam.get(match.awayTeamId);
    if (home === undefined || away === undefined) return [];
    return [{
    id, startTime, matchId, radiantWin, durationSecs, radiantScore, direScore, players,
    match: {
      seasonId: match.seasonId,
      homeTeam: { name: home },
      awayTeam: { name: away },
    },
  }]; }).sort(compareRecordChronology);
}

function recapGames(games: PublicGameSnapshot) {
  return [...games]
    .sort((a, b) => a.fetchedAtMs - b.fetchedAtMs || a.id.localeCompare(b.id))
    .map(({ matchId, radiantWin, radiantScore, direScore, durationSecs, players }) => ({
      matchId, radiantWin, radiantScore, direScore, durationSecs, players,
    }));
}

/** A season's games with their fixture's week and teams, for the hero pages. */
function heroGames(
  games: PublicGameSnapshot,
  contexts: PublicMatchContext,
  teams: PublicTeamNames,
): HeroPageGame[] {
  const byMatch = new Map(contexts.map((match) => [match.id, match]));
  const byTeam = new Map(teams.map((team) => [team.id, team.name]));
  return games.flatMap(({ id, matchId, startTime, durationSecs, radiantWin, players }) => {
    const match = byMatch.get(matchId);
    if (!match) return []; // A concurrent deletion can finish an older render.
    const home = byTeam.get(match.homeTeamId), away = byTeam.get(match.awayTeamId);
    if (home === undefined || away === undefined) return [];
    return [{
      id, matchId, startTime, durationSecs, radiantWin, players, week: match.week,
      homeTeam: { id: match.homeTeamId, name: home },
      awayTeam: { id: match.awayTeamId, name: away },
    }];
  });
}

function leaderGames(games: PublicGameSnapshot, contexts: PublicMatchContext) {
  const byMatch = new Map(contexts.map((match) => [match.id, match]));
  return games.flatMap(({ players, radiantWin, matchId }) => {
    const match = byMatch.get(matchId);
    return match ? [{ players, radiantWin, match: { week: match.week, phase: match.phase } }] : [];
  });
}

export async function fetchAllGameLines() {
  return gameLines(await fetchPublicGameSnapshot(null));
}
export async function getAllGameLines() {
  return gameLines(await getPublicGameSnapshot(null));
}
export async function fetchAllGameScores() {
  return gameScores(await fetchPublicGameSnapshot(null));
}
export async function getAllGameScores() {
  return gameScores(await getPublicGameSnapshot(null));
}
export async function fetchAllGamesForRecords() {
  return recordGames(...await Promise.all([
    fetchPublicGameSnapshot(null), fetchPublicMatchContext(null), fetchPublicTeamNames(null),
  ]));
}
export async function getAllGamesForRecords() {
  return recordGames(...await Promise.all([
    getPublicGameSnapshot(null), getPublicMatchContext(null), getPublicTeamNames(null),
  ]));
}

/** Keep this direct query: the match preview awaits it in nested Suspense.
 * An unstable_cache wrapper previously hung that stream (e2e-mid/match.spec.ts).
 * Indexed participant reads can later narrow its scope without moving this
 * rendering boundary. */
export function fetchAllGamesForScouting() {
  return prisma.game.findMany({
    select: {
      players: true, radiantWin: true, durationSecs: true, startTime: true,
    },
  });
}

export async function fetchSeasonGameScores(seasonId: string) {
  return gameScores(await fetchPublicGameSnapshot(seasonId));
}
export async function getSeasonGameScores(seasonId: string) {
  return gameScores(await getPublicGameSnapshot(seasonId));
}
export async function fetchSeasonGamesForRecap(seasonId: string) {
  return recapGames(await fetchPublicGameSnapshot(seasonId));
}
export async function getSeasonGamesForRecap(seasonId: string) {
  return recapGames(await getPublicGameSnapshot(seasonId));
}
export async function fetchSeasonGameLeaders(seasonId: string) {
  return leaderGames(...await Promise.all([
    fetchPublicGameSnapshot(seasonId), fetchPublicMatchContext(seasonId),
  ]));
}
export async function getSeasonGameLeaders(seasonId: string) {
  return leaderGames(...await Promise.all([
    getPublicGameSnapshot(seasonId), getPublicMatchContext(seasonId),
  ]));
}
export async function fetchSeasonHeroGames(seasonId: string) {
  return heroGames(...await Promise.all([
    fetchPublicGameSnapshot(seasonId), fetchPublicMatchContext(seasonId), fetchPublicTeamNames(seasonId),
  ]));
}
export async function getSeasonHeroGames(seasonId: string) {
  return heroGames(...await Promise.all([
    getPublicGameSnapshot(seasonId), getPublicMatchContext(seasonId), getPublicTeamNames(seasonId),
  ]));
}

/**
 * Weekly honors readiness for a page body (/leaders): the same rows the
 * worker announces from, cached like every all-games roll-up (the result
 * revision and the "games" tag), so a view doesn't re-read the season's box
 * scores beside the cached leaderboards. The announcement paths keep reading
 * getSeasonHonorReadiness directly, and so does Home's honors line, which
 * sits in a nested Suspense where a cached wrapper has hung before.
 */
export const getPublicSeasonHonorReadiness = createPublicSnapshot(
  "honor-readiness-v1",
  async (seasonId) => (seasonId ? getSeasonHonorReadiness(seasonId) : []),
);
