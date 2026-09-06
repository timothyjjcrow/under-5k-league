import { describe, expect, it } from "vitest";
import { projectPlayoffField } from "./playoff-field";
import { computeStandings, type MatchLike } from "./standings";
import { tiebreakerSlot, type TiebreakerGroup } from "./tiebreakers";

const teams = (ids: string[]) => ids.map((id) => ({ id }));
function result(home: string, away: string, hs: number, as: number): MatchLike {
  return { homeTeamId: home, awayTeamId: away, homeScore: hs, awayScore: as,
    winnerTeamId: hs > as ? home : as > hs ? away : null, phase: "REGULAR", status: "COMPLETED" };
}
function round(group: TiebreakerGroup, scores?: number[][]): MatchLike[] {
  return group.pairings.map((p, i) => ({ ...result(p.home, p.away, scores?.[i]?.[0] ?? 2, scores?.[i]?.[1] ?? 0),
    phase: "TIEBREAKER", bestOf: 3, bracketSlot: tiebreakerSlot(group, i) }));
}
function cutoffTie() {
  const ids = ["a", "b", "c", "d", "e"];
  const matches: MatchLike[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    matches.push(result(ids[i], ids[j], i === 3 ? 1 : 2, i === 3 ? 1 : 0));
  }
  return { ids, matches };
}
function drawnRegularSeason(ids: string[]): MatchLike[] {
  return ids.flatMap((home, index) =>
    ids.slice(index + 1).map((away) => result(home, away, 1, 1)),
  );
}

function playBo1Bracket(ids: string[], matches: MatchLike[], outcomes = [true, true, true, true, true]) {
  const played = [...matches];
  for (let i = 0; i < 5; i++) {
    const field = projectPlayoffField(teams(ids), played);
    const group = field.tiebreakers.groups.find((g) => g.status === "needed");
    if (!group) return { field, played };
    expect(group.format).toBe("BO1_DOUBLE_ELIMINATION");
    const pairing = group.drawRequired
      ? { home: group.teamIds[0], away: group.teamIds[1] } : group.pairings[0];
    played.push({ ...result(pairing.home, pairing.away, outcomes[i] ? 1 : 0, outcomes[i] ? 0 : 1),
      phase: "TIEBREAKER", bestOf: 1, bracketSlot: tiebreakerSlot(group, 0) });
  }
  return { field: projectPlayoffField(teams(ids), played), played };
}

function legacyThreeGroup(ids: string[], regular: MatchLike[]): TiebreakerGroup {
  const next = projectPlayoffField(teams(ids), regular).tiebreakers.groups[0];
  return { ...next, key: next.key.replace(/^TBD:/, "TB:").replace(/:1$/, ""),
    drawRequired: false, stage: undefined, format: "BO3_ROUND_ROBIN", bestOf: 3,
    pairings: ids.flatMap((home, i) => ids.slice(i + 1).map((away) => ({ home, away }))) };
}

describe("playoff tiebreaker weeks", () => {
  it("resolves the last playoff place against ID order, without changing any regular points", () => {
    const { ids, matches } = cutoffTie();
    const before = projectPlayoffField(teams(ids), matches);
    expect(before.tiebreakers.groups[0].teamIds).toEqual(["d", "e"]);
    const extra = round(before.tiebreakers.groups[0], [[1, 2]]);
    const after = projectPlayoffField(teams(ids), [...matches, ...extra]);
    expect(after.seededTeamIds).toEqual(["a", "b", "c", "e"]);
    expect(after.tiebreakers).toMatchObject({ resolved: true, pending: false, needsMatches: false, error: null });
    expect(after.seedingDeadHeatTeamIds).toEqual([]);
    expect(after.standings.find((r) => r.teamId === "e")).toMatchObject({ points: 1, played: 4, tiebreakerResolved: true });
    expect(computeStandings(ids, [...matches, ...extra])).toEqual(computeStandings(ids, matches));
  });

  it("requires tiebreakers for seed order even when both teams qualify", () => {
    const matches = [result("a", "b", 1, 1)];
    expect(projectPlayoffField(teams(["a", "b"]), matches).tiebreakers.groups).toHaveLength(1);
  });

  it("never treats incomplete rounds as a resolved seed", () => {
    const matches = [result("a", "b", 1, 1)];
    const group = projectPlayoffField(teams(["a", "b"]), matches).tiebreakers.groups[0];
    const extra = round(group).map((m) => ({ ...m, status: "LIVE", homeScore: 1 }));
    expect(projectPlayoffField(teams(["a", "b"]), [...matches, ...extra]).tiebreakers)
      .toMatchObject({ resolved: false, pending: true, needsMatches: false });
  });

  it("preserves published BO3 round robins, then settles a remaining three-way tie with BO1", () => {
    const ids = ["a", "b", "c"];
    const matches = [result("a", "b", 1, 1), result("a", "c", 1, 1), result("b", "c", 1, 1)];
    const group = legacyThreeGroup(ids, matches);
    const first = round(group, [[2, 0], [0, 2], [2, 0]]);
    const tied = projectPlayoffField(teams(ids), [...matches, ...first]);
    expect(tied.tiebreakers).toMatchObject({ resolved: false, needsMatches: true, error: null });
    const next = tied.tiebreakers.groups.find((g) => g.status === "needed")!;
    expect(next.round).toBe(2);
    expect(next.format).toBe("BO1_DOUBLE_ELIMINATION");
    const { field: final } = playBo1Bracket(ids, [...matches, ...first]);
    expect(final.seededTeamIds).toEqual(["a", "b"]);
    expect(final.tiebreakers.resolved).toBe(true);
  });

  it("replays only the remaining subgroup while preserving the settled seeds", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const regular = drawnRegularSeason(ids);
    const group = projectPlayoffField(teams(ids), regular).tiebreakers.groups[0];
    // A is unbeaten and E is winless. B beats C, C beats D, and D beats B,
    // leaving only seeds 2–4 tied after the five-team round robin.
    const first = round(group, group.pairings.map((pair) =>
      pair.home === "b" && pair.away === "d" ? [0, 2] : [2, 0],
    ));
    const partial = projectPlayoffField(teams(ids), [...regular, ...first]);
    const needed = partial.tiebreakers.groups.filter((g) => g.status === "needed");
    expect(needed).toHaveLength(1);
    expect(needed[0]).toMatchObject({ teamIds: ["b", "c", "d"], round: 2 });
    expect(needed[0]).toMatchObject({ format: "BO1_DOUBLE_ELIMINATION", drawRequired: true });
    expect(partial.tiebreakers).toMatchObject({ resolved: false, needsMatches: true, error: null });
    expect(partial.seedingDeadHeatTeamIds).toEqual(["b", "c", "d"]);
    for (const teamId of ["a", "e"]) {
      expect(partial.standings.find((row) => row.teamId === teamId))
        .toMatchObject({ tiebreakerResolved: true });
    }

    const { field: final } = playBo1Bracket(ids, [...regular, ...first]);
    expect(final.seededTeamIds).toEqual(["a", "b", "c", "d"]);
    expect(final.eligibleTeamIds).toEqual(["a", "b", "c", "d", "e"]);
    expect(final.seedingDeadHeatTeamIds).toEqual([]);
    expect(final.tiebreakers).toMatchObject({ resolved: true, needsMatches: false, error: null });
  });

  it("finishes the playoff order when the remaining subgroup is entirely below the cut", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const regular = drawnRegularSeason(ids);
    const group = projectPlayoffField(teams(ids), regular).tiebreakers.groups[0];
    // A–D finish with six, five, four and three wins. E, F and G each lose
    // to all four qualifiers and split their own cycle with identical scores.
    const first = round(group, group.pairings.map((pair) =>
      pair.home === "e" && pair.away === "g" ? [0, 2] : [2, 0],
    ));
    const field = projectPlayoffField(teams(ids), [...regular, ...first]);
    expect(field.bracketSize).toBe(4);
    expect(field.seededTeamIds).toEqual(["a", "b", "c", "d"]);
    expect(field.tiebreakers.groups).toHaveLength(1);
    expect(field.tiebreakers).toMatchObject({ resolved: true, needsMatches: false, error: null });
    expect(field.seedingDeadHeatTeamIds).toEqual([]);
    const eliminated = field.eligibleStandings.slice(4);
    expect(eliminated.map((row) => row.teamId)).toEqual(["e", "f", "g"]);
    expect(eliminated.every((row) => row.idDecided)).toBe(true);
    expect(new Set(eliminated.map((row) => row.idTieGroup)).size).toBe(1);
  });

  it("uses BO3 game differential to separate equal round-robin series wins", () => {
    const ids = ["a", "b", "c"];
    const regular = [result("a", "b", 1, 1), result("a", "c", 1, 1), result("b", "c", 1, 1)];
    const g = legacyThreeGroup(ids, regular);
    const field = projectPlayoffField(teams(ids), [...regular, ...round(g, [[2, 0], [1, 2], [2, 0]])]);
    expect(field.eligibleTeamIds).toEqual(["a", "b", "c"]);
    expect(field.tiebreakers.resolved).toBe(true);
  });

  it("fails closed on duplicate, missing, stale or invalid fixtures", () => {
    const { ids, matches } = cutoffTie();
    const group = projectPlayoffField(teams(ids), matches).tiebreakers.groups[0];
    const extra = round(group);
    for (const bad of [
      [...extra, ...extra],
      extra.map((m) => ({ ...m, bestOf: 1 })),
      extra.map((m) => ({ ...m, bracketSlot: null })),
      extra.map((m) => ({ ...m, homeScore: 1, awayScore: 1, winnerTeamId: null, forfeit: true })),
    ]) {
      expect(projectPlayoffField(teams(ids), [...matches, ...bad]).tiebreakers.error).toBeTruthy();
    }
    const changed = matches.map((m, i) => i === 0 ? { ...m, forfeit: true } : m);
    expect(projectPlayoffField(teams(ids), [...changed, ...extra]).tiebreakers.error).toMatch(/earlier/);
  });

  it("keeps the same identity regardless of query return order", () => {
    const { ids, matches } = cutoffTie();
    expect(projectPlayoffField(teams(ids), matches).tiebreakers.groups)
      .toEqual(projectPlayoffField(teams(ids.reverse()), matches.reverse()).tiebreakers.groups);
  });

  it("excludes withdrawn opponents from tiebreaker scheduling", () => {
    const { ids, matches } = cutoffTie();
    const field = projectPlayoffField(teams(ids).map((t) => ({ ...t, withdrawn: t.id === "e" })), matches);
    expect(field.tiebreakers.groups).toEqual([]);
    expect(field.tiebreakers.resolved).toBe(true);
  });

  it("finishes every possible three-team outcome in four or five BO1 games", () => {
    const ids = ["a", "b", "c"];
    const regular = drawnRegularSeason(ids);
    for (let bits = 0; bits < 32; bits++) {
      const outcomes = Array.from({ length: 5 }, (_, i) => !!(bits & (1 << i)));
      const { field, played } = playBo1Bracket(ids, regular, outcomes);
      expect(field.tiebreakers).toMatchObject({ resolved: true, error: null, needsMatches: false, pending: false });
      const games = played.filter((m) => m.phase === "TIEBREAKER");
      expect(games).toHaveLength(outcomes[3] ? 4 : 5);
      expect(games.every((m) => m.bestOf === 1)).toBe(true);
      const losses = new Map(ids.map((id) => [id, 0]));
      for (const game of games) {
        const loser = game.homeTeamId === game.winnerTeamId ? game.awayTeamId : game.homeTeamId;
        losses.set(loser, losses.get(loser)! + 1);
      }
      expect(field.eligibleTeamIds.map((id) => losses.get(id))).toEqual([outcomes[3] ? 0 : 1, 2, 2]);
      expect(computeStandings(ids, played)).toEqual(computeStandings(ids, regular));
    }
  });

  it("rejects an incorrect BO1 winner, duplicate stage, or invented future opponent", () => {
    const ids = ["a", "b", "c"];
    const regular = drawnRegularSeason(ids);
    const group = projectPlayoffField(teams(ids), regular).tiebreakers.groups[0];
    const first: MatchLike = { ...result("a", "b", 1, 0), phase: "TIEBREAKER", bestOf: 1, bracketSlot: tiebreakerSlot(group, 0) };
    for (const extra of [
      [first, first],
      [{ ...first, winnerTeamId: "b" }],
      [{ ...first, homeScore: 2 }],
      [first, { ...first, bracketSlot: first.bracketSlot!.replace(/:1:0$/, ":2:0"), homeTeamId: "b", awayTeamId: "c" }],
    ]) {
      expect(projectPlayoffField(teams(ids), [...regular, ...extra]).tiebreakers.error).toBeTruthy();
    }
  });
});
