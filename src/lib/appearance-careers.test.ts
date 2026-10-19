import { expect, it } from "vitest";
import { syntheticHistory } from "../../test/support/synthetic-history";
import {
  appearanceCareers,
  appearanceFacts,
  careersFromFacts,
  type AppearanceCareer,
  type AppearanceFacts,
} from "./appearance-careers";
import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";

const match = { id: "m1", seasonId: "s1", status: "COMPLETED", winnerTeamId: "home" as string | null,
  homeTeamId: "home", awayTeamId: "away" };
const players = () => Array.from({ length: 10 }, (_, i) => ({
  userId: `u${i}` as string | null, teamId: (i < 5 ? "home" : "away") as string | null, accountId: i + 1,
  heroId: i + 1, isRadiant: i < 5, kills: 1, deaths: 2, assists: 3,
}));
const game = (id: string, lines = players()) => ({ id, matchId: "m1", radiantWin: true, players: JSON.stringify(lines) });

it("credits actual substitutes and former players once per won series and championship season", () => {
  const second = players();
  second[0].userId = "substitute";
  const report = appearanceCareers([game("g1"), game("g2", second), game("g2", second)],
    [match], [{ seasonId: "s1", teamId: "home" }]);
  expect(report.seriesWins.get("u0")).toBe(1);
  expect(report.seriesWins.get("substitute")).toBe(1);
  expect(report.seriesWins.get("u1")).toBe(1);
  expect(report.championshipContributions.get("substitute")).toBe(1);
  expect(report.championshipContributions.has("later-signing")).toBe(false);
  expect(report.rows.find((row) => row.userId === "u1")?.games).toBe(2);
  expect(report.coverage.importedGames).toBe(2);
});

it("does not infer players for manual results, incomplete games or missing team attribution", () => {
  const lines = players();
  lines[0].teamId = "unrelated";
  const report = appearanceCareers([game("valid", lines), game("partial", players().slice(0, 5))],
    [match, { ...match, id: "manual" }], [{ seasonId: "s1", teamId: "home" }]);
  expect(report.championshipContributions.has("u0")).toBe(false);
  expect(report.seriesWins.get("u1")).toBe(1);
  expect(report.coverage).toEqual({ importedGames: 2, trustedGames: 1, attributedLines: 9, unattributedLines: 1 });
});

it("separates played map wins from series draws and ignores a series still in progress", () => {
  const drawn = { ...match, winnerTeamId: null };
  const report = appearanceCareers([game("g1"), { ...game("g2"), matchId: "live" }],
    [drawn, { ...match, id: "live", status: "LIVE" }], []);
  expect(report.rows.find((row) => row.userId === "u0")).toMatchObject({
    games: 2, wins: 2, seriesWins: 0, seriesLosses: 0, seriesDraws: 1,
  });
  expect(report.championshipContributions.size).toBe(0);
});

// The per-line walk appearanceCareers ran before its facts were cached
// (verbatim but for the name), kept as the reference the cached path must
// reproduce exactly: rows, their order, the maps and the coverage counts.
function perLineCareers(
  games: readonly { id: string; matchId: string; players: string; radiantWin: boolean }[],
  matches: readonly (typeof match)[],
  champions: readonly { seasonId: string; teamId: string }[],
) {
  const matchOf = new Map(matches.map((match) => [match.id, match]));
  const championOf = new Map(champions.map((row) => [row.seasonId, row.teamId]));
  const rows = new Map<string, AppearanceCareer>();
  const seenGames = new Set<string>();
  const seenSeries = new Set<string>();
  let trustedGames = 0;
  let attributedLines = 0;
  let unattributedLines = 0;
  for (const game of games) {
    if (seenGames.has(game.id)) continue;
    seenGames.add(game.id);
    const match = matchOf.get(game.matchId);
    if (!match) continue;
    const players = trustedGamePlayers(decodeGamePlayers(game.players));
    if (!players.length) continue;
    trustedGames++;
    for (const player of players) {
      if (!player.userId || !player.teamId ||
        (player.teamId !== match.homeTeamId && player.teamId !== match.awayTeamId)) {
        unattributedLines++;
        continue;
      }
      attributedLines++;
      const key = JSON.stringify([player.userId, player.teamId]);
      let row = rows.get(key);
      if (!row) {
        row = { userId: player.userId, teamId: player.teamId, seasonId: match.seasonId,
          games: 0, wins: 0, seriesWins: 0, seriesLosses: 0, seriesDraws: 0,
          championshipContribution: championOf.get(match.seasonId) === player.teamId };
        rows.set(key, row);
      }
      row.games++;
      if (player.isRadiant === game.radiantWin) row.wins++;
      const seriesKey = JSON.stringify([match.id, player.userId, player.teamId]);
      if (match.status !== "COMPLETED" || seenSeries.has(seriesKey)) continue;
      seenSeries.add(seriesKey);
      if (!match.winnerTeamId) row.seriesDraws++;
      else if (match.winnerTeamId === player.teamId) row.seriesWins++;
      else row.seriesLosses++;
    }
  }
  const seriesWins = new Map<string, number>();
  const championshipContributions = new Map<string, number>();
  for (const row of rows.values()) {
    seriesWins.set(row.userId, (seriesWins.get(row.userId) ?? 0) + row.seriesWins);
    if (row.championshipContribution) {
      championshipContributions.set(row.userId, (championshipContributions.get(row.userId) ?? 0) + 1);
    }
  }
  return { rows: [...rows.values()], seriesWins, championshipContributions,
    coverage: { importedGames: seenGames.size, trustedGames, attributedLines, unattributedLines } };
}

/** The facts as the public cache hands them back: through JSON. */
const cachedFacts = (games: Parameters<typeof appearanceFacts>[0]) =>
  JSON.parse(JSON.stringify(appearanceFacts(games))) as AppearanceFacts;

it("folds cached facts into exactly the per-line careers on a realistic history", () => {
  const history = syntheticHistory({ games: 500, seasons: 5 });
  // Fresh outcomes the facts don't hold: a live series, a drawn one, a match
  // deleted since, and two seasons' champions.
  const matches = history.matches.map((row, i) =>
    i % 17 === 3 ? { ...row, status: "LIVE" } : i % 13 === 5 ? { ...row, winnerTeamId: null } : row)
    .filter((_, i) => i % 29 !== 7);
  const fourth = history.matches.find((row) => row.seasonId === history.seasons[3].id)!;
  const champions = [
    { seasonId: history.seasons[0].id, teamId: history.matches[0].homeTeamId },
    { seasonId: history.seasons[3].id, teamId: fourth.awayTeamId },
  ];
  const reference = perLineCareers(history.games, matches, champions);
  expect(reference.rows.length).toBeGreaterThan(100);
  expect(reference.championshipContributions.size).toBeGreaterThan(0);
  expect(careersFromFacts(cachedFacts(history.games), matches, champions)).toEqual(reference);
  // The /players pool's read: only earlier seasons' matches.
  const earlier = matches.filter((row) => row.seasonId !== history.seasons[4].id);
  expect(careersFromFacts(cachedFacts(history.games), earlier, champions))
    .toEqual(perLineCareers(history.games, earlier, champions));
});

it("matches the per-line careers on duplicated, partial, unattributed and repeated lines", () => {
  const away = { ...match, id: "m2", winnerTeamId: "away" };
  const unmapped = players();
  unmapped[2].userId = null;
  unmapped[7].teamId = null;
  const stranger = players();
  stranger[1].teamId = "unrelated";
  stranger[6].teamId = "unrelated";
  const swapped = players().map((line) => ({ ...line, isRadiant: !line.isRadiant }));
  const games = [
    game("g1"), game("g1"), game("g2", unmapped), game("g3", stranger),
    { ...game("g4", swapped), matchId: "m2", radiantWin: false },
    { ...game("g5"), matchId: "m2" }, { ...game("g6"), matchId: "gone" },
    game("g7", players().slice(0, 9)), { ...game("g8"), players: "not json" },
    { ...game("g9"), matchId: "m2" },
  ];
  const matches = [match, away];
  for (const champions of [[], [{ seasonId: "s1", teamId: "away" }]]) {
    expect(careersFromFacts(cachedFacts(games), matches, champions))
      .toEqual(perLineCareers(games, matches, champions));
  }
  expect(perLineCareers(games, matches, []).coverage).toEqual({
    importedGames: 9, trustedGames: 6, attributedLines: 56, unattributedLines: 4,
  });
});
