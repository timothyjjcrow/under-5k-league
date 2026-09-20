import { describe, expect, it } from "vitest";
import { projectPlayoffField as projectCurrentPlayoffField } from "@/lib/playoff-field";
// Historical fixture generation; production continues to recognize these stored formats.
const projectPlayoffField: typeof projectCurrentPlayoffField = (teams, matches) => projectCurrentPlayoffField(teams, matches, "legacy");
import { tiebreakerSlot, type TiebreakerGroup } from "@/lib/tiebreakers";
import {
  buildTiebreakerBrackets,
  type TiebreakerBracketFixture,
  type TiebreakerBracketTeam,
} from "./tiebreaker-bracket-view";

const teams: TiebreakerBracketTeam[] = [
  { id: "a", name: "Alpha", logoUrl: "/alpha.png" },
  { id: "b", name: "Bravo" },
  { id: "c", name: "Charlie" },
];
const kickoff = new Date("2026-09-19T20:00:00Z");

function regular(home: string, away: string, hs = 1, as = 1): TiebreakerBracketFixture {
  return {
    id: `${home}-${away}`, homeTeamId: home, awayTeamId: away,
    status: "COMPLETED", homeScore: hs, awayScore: as,
    winnerTeamId: hs > as ? home : as > hs ? away : null,
    phase: "REGULAR", bestOf: 2, week: 5, scheduledAt: null,
  };
}

function drawnSeason(ids = teams.map((team) => team.id)) {
  return ids.flatMap((id, index) => ids.slice(index + 1).map((other) => regular(id, other)));
}

function fixture(group: TiebreakerGroup, index = 0, homeWins = true): TiebreakerBracketFixture {
  const pairing = group.drawRequired ? { home: "b", away: "a" } : group.pairings[index];
  return {
    id: `fixture-${group.key}-${index}`,
    bracketSlot: tiebreakerSlot(group, index),
    homeTeamId: pairing.home, awayTeamId: pairing.away,
    status: "COMPLETED", phase: "TIEBREAKER", bestOf: group.bestOf,
    homeScore: homeWins ? group.bestOf === 1 ? 1 : 2 : 0,
    awayScore: homeWins ? 0 : group.bestOf === 1 ? 1 : 2,
    winnerTeamId: homeWins ? pairing.home : pairing.away,
    week: 6, scheduledAt: new Date(kickoff.getTime() + ((group.stage ?? 1) - 1) * 90 * 60_000),
  };
}

function next(matches: TiebreakerBracketFixture[], homeWins = true, roster = teams) {
  const group = projectPlayoffField(roster, matches).tiebreakers.groups.find((entry) => entry.status === "needed");
  if (!group) throw new Error("The test needs an unresolved next stage");
  return [...matches, fixture(group, 0, homeWins)];
}

function view(matches: TiebreakerBracketFixture[], roster = teams) {
  return buildTiebreakerBrackets({ teams: roster, matches, projection: projectPlayoffField(roster, matches) });
}

describe("complete tiebreaker bracket presentation", () => {
  it("shows all five games before a draw without assigning an arbitrary opening bye", () => {
    const [group] = view(drawnSeason()).groups;
    expect(group.matches).toHaveLength(5);
    expect(group.byeTeamId).toBeNull();
    expect(group.week).toBeNull();
    expect(group.matches[0].home.teamId).toBeNull();
    expect(group.matches[0].home.name).toBe("Opening draw: team 1");
    expect(group.matches[0].away.name).toBe("Opening draw: team 2");
    expect(group.matches[1].away).toMatchObject({ teamId: null, name: "Opening bye" });
    expect(group.matches[4]).toMatchObject({ status: "conditional", matchId: null });
    expect(group.matches.every((match) => match.bestOf === 1 && match.scheduledAt === null)).toBe(true);
    expect(group.placements.map((place) => [place.seed, place.qualifies, place.teamId]))
      .toEqual([[1, true, null], [2, true, null], [3, false, null]]);
  });

  it("makes the third team and all feeder paths visible when only the opening match is scheduled", () => {
    const regular = drawnSeason();
    const initial = fixture(projectPlayoffField(teams, regular).tiebreakers.groups[0]);
    const scheduled = { ...initial, status: "SCHEDULED", homeScore: 0, awayScore: 0, winnerTeamId: null };
    const [group] = view([...regular, scheduled]).groups;
    expect(group).toMatchObject({ byeTeamId: "c", week: 6, openingAt: kickoff, status: "pending" });
    expect(group.matches[0]).toMatchObject({ matchId: initial.id, status: "scheduled", homeScore: null, awayScore: null });
    expect(group.matches[0].home).toMatchObject({ name: "Bravo", source: null });
    expect(group.matches[0].away).toMatchObject({ name: "Alpha", logoUrl: "/alpha.png", source: null });
    expect(group.matches[1].home.name).toBe("Winner of Game 1");
    expect(group.matches[1].away).toMatchObject({ name: "Charlie", source: "Opening bye" });
    expect(group.matches[2].home.name).toBe("Loser of Game 1");
    expect(group.matches[2].away.name).toBe("Loser of Game 2");
    expect(group.matches[3].home.name).toBe("Winner of Game 2");
    expect(group.matches[3].away.name).toBe("Winner of Game 3");
    expect(group.matches.slice(1).every((match) => match.matchId === null && match.scheduledAt === null)).toBe(true);
  });

  it("fills known participants between result submission and creation of the next real fixture", () => {
    const matches = next(drawnSeason());
    const result = view(matches);
    expect(result.groups).toHaveLength(1);
    const [group] = result.groups;
    expect(group.status).toBe("needed");
    expect(group.matches[0]).toMatchObject({ status: "complete", winnerTeamId: "b" });
    expect(group.matches[1]).toMatchObject({ status: "waiting", matchId: null, scheduledAt: null });
    expect(group.matches[1].home).toMatchObject({ teamId: "b", name: "Bravo", source: "Winner of Game 1" });
    expect(group.matches[2].home).toMatchObject({ teamId: "a", source: "Loser of Game 1" });
    expect(group.matches[2].away.teamId).toBeNull();
    expect(group.placements.every((place) => place.teamId === null)).toBe(true);
  });

  it("never advances a team using a live partial score", () => {
    const matches = next(drawnSeason());
    matches[matches.length - 1] = { ...matches.at(-1)!, status: "LIVE", winnerTeamId: null };
    const [group] = view(matches).groups;
    expect(group.matches[0]).toMatchObject({ status: "live", homeScore: 1, winnerTeamId: null });
    expect(group.matches[1].home.teamId).toBeNull();
    expect(group.matches[2].home.teamId).toBeNull();
  });

  it("shows a definite third place after the elimination game without prematurely assigning the finalists' seeds", () => {
    const matches = next(next(next(drawnSeason())));
    const [group] = view(matches).groups;
    expect(group.placements).toEqual([
      { place: 1, seed: 1, qualifies: true, teamId: null, name: null },
      { place: 2, seed: 2, qualifies: true, teamId: null, name: null },
      { place: 3, seed: 3, qualifies: false, teamId: "c", name: "Charlie" },
    ]);
    expect(group.matches[3].home.teamId).toBe("b");
    expect(group.matches[3].away.teamId).toBe("a");
  });

  it("marks Game 5 unnecessary when the undefeated finalist wins Game 4", () => {
    const matches = next(next(next(next(drawnSeason()))));
    const [group] = view(matches).groups;
    expect(group.status).toBe("resolved");
    expect(group.matches).toHaveLength(5);
    expect(group.matches[4]).toMatchObject({ status: "not-needed", matchId: null });
    expect(group.placements.map((place) => place.teamId)).toEqual(["b", "a", "c"]);
  });

  it("makes the reset required after a lower finalist win and uses its result for the final order", () => {
    const four = next(next(next(next(drawnSeason()))), false);
    const [pending] = view(four).groups;
    expect(pending.matches[4]).toMatchObject({ status: "waiting", matchId: null });
    expect(pending.matches[4].home.teamId).toBe("b");
    expect(pending.matches[4].away.teamId).toBe("a");
    expect(pending.placements.map((place) => place.teamId)).toEqual([null, null, "c"]);
    const five = next(four, false);
    const [complete] = view(five).groups;
    expect(complete.matches[4]).toMatchObject({ status: "complete", winnerTeamId: "a" });
    expect(complete.placements.map((place) => place.teamId)).toEqual(["a", "b", "c"]);
  });

  it("agrees with authoritative qualification and order for every three-team result path", () => {
    for (let path = 0; path < 32; path++) {
      let matches = drawnSeason();
      for (let stage = 0; stage < 5; stage++) {
        if (projectPlayoffField(teams, matches).tiebreakers.resolved) break;
        matches = next(matches, Boolean(path & (1 << stage)));
      }
      const projection = projectPlayoffField(teams, matches);
      const [group] = view(matches).groups;
      expect(group.placements.map((place) => place.teamId)).toEqual(projection.eligibleTeamIds);
      expect(group.placements.filter((place) => place.qualifies).map((place) => place.teamId))
        .toEqual(projection.seededTeamIds);
      expect(group.matches.filter((match) => match.matchId)).toHaveLength(path & 8 ? 4 : 5);
    }
  });

  it("maps a three-way qualification tie to its actual overall seeds, not always seeds one through three", () => {
    const roster = [{ id: "top1", name: "First" }, { id: "top2", name: "Second" }, ...teams];
    const regular = [regularResult("top1", "top2"), ...drawnSeason(),
      ...teams.flatMap((team) => [regularResult("top1", team.id), regularResult("top2", team.id)])];
    const [group] = view(regular, roster).groups;
    expect(group.placements.map((place) => [place.seed, place.qualifies]))
      .toEqual([[3, true], [4, true], [5, false]]);
  });

  it("distinguishes a seeding-only three-team tie from elimination from the playoffs", () => {
    const roster = [...teams, { id: "d", name: "Delta" }];
    const matches = [...drawnSeason(), ...teams.map((team) => regularResult(team.id, "d"))];
    const [group] = view(matches, roster).groups;
    expect(group.teamIds).toEqual(["a", "b", "c"]);
    expect(group.placements.map((place) => [place.seed, place.qualifies]))
      .toEqual([[1, true], [2, true], [3, true]]);
  });

  it("keeps independent tie groups and their qualification ranges separate", () => {
    const roster = [{ id: "top1", name: "First" }, { id: "top2", name: "Second" }, ...teams];
    const matches = [regular("top1", "top2"), ...drawnSeason(),
      ...teams.flatMap((team) => [regularResult("top1", team.id), regularResult("top2", team.id)])];
    const result = view(matches, roster);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].matches).toHaveLength(1);
    expect(result.groups[0].placements.map((place) => place.seed)).toEqual([1, 2]);
    expect(result.groups[1].matches).toHaveLength(5);
    expect(result.groups[1].placements.map((place) => place.seed)).toEqual([3, 4, 5]);
  });

  it("preserves a two-team BO3 series instead of presenting the three-team format", () => {
    const roster = teams.slice(0, 2);
    const regular = drawnSeason(["a", "b"]);
    const [before] = view(regular, roster).groups;
    expect(before.format).toBe("BO3_ROUND_ROBIN");
    expect(before.matches).toHaveLength(1);
    expect(before.matches[0]).toMatchObject({ bestOf: 3, title: "Tiebreaker series" });
    const played = next(regular, false, roster);
    const [after] = view(played, roster).groups;
    expect(after.matches[0]).toMatchObject({ bestOf: 3, awayScore: 2, winnerTeamId: "b" });
    expect(after.placements.map((place) => [place.teamId, place.qualifies])).toEqual([["b", true], ["a", true]]);
  });

  it("keeps a published legacy three-team BO3 round robin and its successor BO1 bracket separate", () => {
    const regular = drawnSeason();
    const opening = projectPlayoffField(teams, regular).tiebreakers.groups[0];
    const legacy: TiebreakerGroup = {
      ...opening, key: opening.key.replace(/^TBD:/, "TB:").replace(/:1$/, ""),
      stage: undefined, drawRequired: false, format: "BO3_ROUND_ROBIN", bestOf: 3,
      pairings: [{ home: "a", away: "b" }, { home: "a", away: "c" }, { home: "b", away: "c" }],
    };
    const matches = [...regular, fixture(legacy, 0), fixture(legacy, 1, false), fixture(legacy, 2)];
    const result = view(matches);
    expect(result.error).toBeNull();
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toMatchObject({ format: "BO3_ROUND_ROBIN", round: 1 });
    expect(result.groups[0].matches).toHaveLength(3);
    expect(result.groups[0].matches.every((match) => match.bestOf === 3)).toBe(true);
    expect(result.groups[1]).toMatchObject({ format: "BO1_DOUBLE_ELIMINATION", round: 2 });
    expect(result.groups[1].matches).toHaveLength(5);
    expect(result.groups[0].placements.every((place) => place.teamId === null)).toBe(true);
  });

  it("fails closed for stale fixtures instead of drawing a convincing but incorrect route", () => {
    const matches = next(drawnSeason());
    matches[0] = { ...matches[0], homeScore: 2, awayScore: 0, winnerTeamId: matches[0].homeTeamId };
    const result = view(matches);
    expect(result.error).toMatch(/earlier standings|no longer match/);
    expect(result.groups).toEqual([]);
  });
});

function regularResult(home: string, away: string) {
  return regular(home, away, 2, 0);
}
