import { prisma } from "./prisma";
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
  }]; }).sort((a, b) => {
    // Unknown OpenDota time belongs after dated games, never before them.
    const aTime = a.startTime > 0 ? a.startTime : Number.MAX_SAFE_INTEGER;
    const bTime = b.startTime > 0 ? b.startTime : Number.MAX_SAFE_INTEGER;
    return aTime - bTime || a.id.localeCompare(b.id);
  });
}

function recapGames(games: PublicGameSnapshot) {
  return [...games]
    .sort((a, b) => a.fetchedAtMs - b.fetchedAtMs || a.id.localeCompare(b.id))
    .map(({ matchId, radiantWin, radiantScore, direScore, durationSecs, players }) => ({
      matchId, radiantWin, radiantScore, direScore, durationSecs, players,
    }));
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
