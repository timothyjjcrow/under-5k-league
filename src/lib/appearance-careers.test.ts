import { expect, it } from "vitest";
import { appearanceCareers } from "./appearance-careers";

const match = { id: "m1", seasonId: "s1", status: "COMPLETED", winnerTeamId: "home",
  homeTeamId: "home", awayTeamId: "away" };
const players = () => Array.from({ length: 10 }, (_, i) => ({
  userId: `u${i}`, teamId: i < 5 ? "home" : "away", accountId: i + 1,
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
