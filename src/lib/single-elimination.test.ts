import { describe, expect, it } from "vitest";
import { singleEliminationPlan } from "./single-elimination";
import { resolveTiebreakers, tiebreakerSlot } from "./tiebreakers";
import { hasLaterTiebreakerStage, parseSingleTiebreakerSlot } from "./tiebreaker-format";
import type { MatchLike, TeamStanding } from "./standings";
import { standingOutlooks } from "./scenario-outlook";

const basis = "a".repeat(64);
function tied(count: number): TeamStanding[] {
  return Array.from({ length: count }, (_, i) => ({ teamId: `team-${String(i).padStart(2, "0")}`,
    played: 2, wins: 0, draws: 2, losses: 0, points: 2, gameWins: 2, gameLosses: 2,
    gameDiff: 0, idDecided: true, idTieGroup: "tied" }));
}
function fixture(key: string, home: string, away: string, completed = false, homeWins = true): MatchLike {
  return { bracketSlot: key, homeTeamId: home, awayTeamId: away,
    phase: "TIEBREAKER", bestOf: 1, status: completed ? "COMPLETED" : "SCHEDULED",
    homeScore: completed && homeWins ? 1 : 0, awayScore: completed && !homeWins ? 1 : 0,
    winnerTeamId: completed ? homeWins ? home : away : null };
}
function start(rows: TeamStanding[], places: number) {
  const group = resolveTiebreakers(rows, [], places, basis).state.groups[0];
  const draw = [...group.teamIds].reverse();
  const key = `${group.key}:${draw.map((id) => group.teamIds.indexOf(id)).join(".")}`;
  return { draw, key, matches: singleEliminationPlan(draw, places, key).games
    .filter((g) => g.home.teamId && g.away.teamId)
    .map((g) => fixture(g.key, g.home.teamId!, g.away.teamId!)) };
}

describe("capped BO1 single elimination", () => {
  it("finishes every small-bracket result path with no fourth game, duplicates, or regular points", () => {
    for (let count = 2; count <= 8; count++) for (let places = 1; places <= count; places++) {
      for (let outcomes = 0; outcomes < 2 ** (count - 1); outcomes++) {
        const rows = tied(count);
        const { matches } = start(rows, places);
        let game = 0;
        for (;;) {
          const pending = matches.find((m) => m.status === "SCHEDULED");
          if (pending) Object.assign(pending, fixture(pending.bracketSlot!, pending.homeTeamId, pending.awayTeamId, true, !!(outcomes & 2 ** game++)));
          const result = resolveTiebreakers(rows, matches, places, basis);
          expect(result.state.error).toBeNull();
          if (result.state.resolved) {
            expect(result.standings.every((r) => r.points === 2 && r.tiebreakerResolved && !r.idDecided)).toBe(true);
            expect(new Set(result.standings.map((r) => r.teamId)).size).toBe(count);
            break;
          }
          for (const group of result.state.groups.filter((g) => g.status === "needed" && !g.blocked)) {
            matches.push(fixture(tiebreakerSlot(group, 0), group.pairings[0].home, group.pairings[0].away));
          }
          expect(game).toBeLessThan(count);
        }
        for (const row of rows) {
          const played = matches.filter((m) => [m.homeTeamId, m.awayTeamId].includes(row.teamId));
          expect(played.length).toBeLessThanOrEqual(3);
          expect(played.filter((m) => m.winnerTeamId !== row.teamId).length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it.each([[9, 1], [16, 2], [24, 1], [32, 16], [65, 65]])("caps large fields (%i teams, %i places) and uses the published draw", (count, places) => {
    const rows = tied(count), { key, draw, matches } = start(rows, places);
    for (let pass = 0; pass < 3; pass++) {
      for (const match of matches) Object.assign(match, fixture(match.bracketSlot!, match.homeTeamId, match.awayTeamId, true));
      const result = resolveTiebreakers(rows, matches, places, basis);
      expect(result.state.error).toBeNull();
      for (const group of result.state.groups.filter((g) => g.status === "needed" && !g.blocked)) {
        matches.push(fixture(group.key, group.pairings[0].home, group.pairings[0].away));
      }
    }
    const result = resolveTiebreakers(rows, matches, places, basis);
    expect(result.state.resolved).toBe(true);
    const plan = singleEliminationPlan(draw, places, key, matches);
    expect(plan.brackets.every((b) => b.teamIds.length <= 8)).toBe(true);
    expect(result.standings.map((r) => r.teamId)).toEqual(plan.order);
    for (const id of draw) expect(matches.filter((m) => m.homeTeamId === id || m.awayTeamId === id).length).toBeLessThanOrEqual(3);
  });

  it("publishes a qualifying bye for three teams/two places and needs just one BO1", () => {
    const rows = tied(3), { draw, matches } = start(rows, 2);
    expect(matches).toHaveLength(1);
    const pending = resolveTiebreakers(rows, matches, 2, basis);
    expect(pending.standings.find((r) => r.teamId === draw[0])?.tiebreakerRankRange).toEqual({ best: 1, worst: 1 });
    expect(standingOutlooks(pending.standings, 2).get(draw[0])).toMatchObject({ qualified: 1, qualificationTiebreaker: 0, seedingTiebreaker: 0 });
    Object.assign(matches[0], fixture(matches[0].bracketSlot!, matches[0].homeTeamId, matches[0].awayTeamId, true));
    expect(resolveTiebreakers(rows, matches, 2, basis).state.resolved).toBe(true);
  });

  it("releases only ready successors and locks only their actual feeders", () => {
    const rows = tied(8), { matches } = start(rows, 1);
    for (const match of matches.slice(0, 2)) Object.assign(match, fixture(match.bracketSlot!, match.homeTeamId, match.awayTeamId, true));
    const result = resolveTiebreakers(rows, matches, 1, basis);
    expect(standingOutlooks(result.standings, 1).get(matches[0].awayTeamId)).toMatchObject({ eliminated: 1, qualificationTiebreaker: 0 });
    const ready = result.state.groups.filter((g) => g.status === "needed" && !g.blocked);
    expect(ready).toHaveLength(1);
    const next = fixture(ready[0].key, ready[0].pairings[0].home, ready[0].pairings[0].away);
    const slate = [...matches, next].map((m) => ({ ...m, week: 6 }));
    expect(hasLaterTiebreakerStage(slate[0], slate)).toBe(true);
    expect(hasLaterTiebreakerStage(slate[2], slate)).toBe(false);
  });

  it("rejects stale draws, duplicate fixtures, non-BO1 scores and premature successors", () => {
    const rows = tied(4), { matches, key, draw } = start(rows, 1);
    expect(resolveTiebreakers(rows, [...matches, matches[0]], 1, basis).state.error).toBeTruthy();
    expect(resolveTiebreakers(rows, [{ ...matches[0], status: "COMPLETED", homeScore: 2, winnerTeamId: matches[0].homeTeamId }, ...matches.slice(1)], 1, basis).state.error).toBeTruthy();
    const final = singleEliminationPlan(draw, 1, key).games.at(-1)!;
    expect(resolveTiebreakers(rows, [...matches, fixture(final.key, draw[0], draw[1])], 1, basis).state.error).toBeTruthy();
    expect(resolveTiebreakers(rows, matches, 1, "b".repeat(64)).state.error).toBeTruthy();
    expect(parseSingleTiebreakerSlot(`${key.replace(/:[\d.]+$/, ":0.0.1.2")}:0:1:0`)).toBeNull();
  });

  it("keeps a published legacy BO3 result authoritative under the new default", () => {
    const rows = tied(2);
    const group = resolveTiebreakers(rows, [], 1, basis, "legacy").state.groups[0];
    const result = { ...fixture(tiebreakerSlot(group, 0), group.pairings[0].home, group.pairings[0].away, true), bestOf: 3, homeScore: 2 };
    expect(resolveTiebreakers(rows, [result], 1, basis).state).toMatchObject({ resolved: true, error: null });
    expect(resolveTiebreakers(rows, [result], 1, basis).state.groups[0].format).toBe("BO3_ROUND_ROBIN");
  });
});
