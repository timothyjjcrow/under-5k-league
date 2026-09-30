import { describe, expect, it } from "vitest";
import {
  orderByPlayoffRun,
  playoffStatusChip,
  playoffStatusText,
  playoffStatuses,
  type PlayoffStatusMatch,
  type TeamPlayoffStatus,
} from "./playoff-status";

const NOW = Date.UTC(2026, 8, 27, 12);
const HOUR = 3_600_000;

const names: Record<string, string> = {
  s1: "Radiant Raccoons",
  s2: "Dire Straits",
  s3: "Roshan's Revenge",
  s4: "Pudge Patrol",
  s5: "Tinker Tailors",
  s6: "Mid or Feed",
  s7: "Ward Wardens",
  s8: "Creep Skippers",
  x: "Bench Warmers",
};
const name = (id: string) => names[id] ?? "?";
const teams = [
  ...["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((id) => ({ id })),
  { id: "x" },
];

let n = 0;
function match(over: Partial<PlayoffStatusMatch>): PlayoffStatusMatch {
  n += 1;
  return {
    id: `m${n}`,
    week: 8,
    phase: "PLAYOFF",
    bracketSlot: "R0M0",
    status: "COMPLETED",
    homeTeamId: "s1",
    awayTeamId: "s8",
    homeScore: 2,
    awayScore: 1,
    winnerTeamId: "s1",
    scheduledAt: new Date(NOW - 7 * 24 * HOUR),
    ...over,
  };
}

// An 8-team bracket mid-semifinals, like the postseason fixture: all four
// quarterfinals played, one semifinal played, the other still to come.
const quarterfinals = [
  match({ bracketSlot: "R0M0", homeTeamId: "s1", awayTeamId: "s8", winnerTeamId: "s1" }),
  match({ bracketSlot: "R0M1", homeTeamId: "s4", awayTeamId: "s5", winnerTeamId: "s4" }),
  match({ bracketSlot: "R0M2", homeTeamId: "s2", awayTeamId: "s7", winnerTeamId: "s2" }),
  match({
    bracketSlot: "R0M3",
    homeTeamId: "s3",
    awayTeamId: "s6",
    homeScore: 0,
    awayScore: 2,
    winnerTeamId: "s6",
  }),
];
const semiDone = match({
  week: 9,
  bracketSlot: "R1M0",
  homeTeamId: "s1",
  awayTeamId: "s4",
  homeScore: 2,
  awayScore: 0,
  winnerTeamId: "s1",
});
const semiNext = match({
  week: 9,
  bracketSlot: "R1M1",
  homeTeamId: "s2",
  awayTeamId: "s6",
  status: "SCHEDULED",
  homeScore: 0,
  awayScore: 0,
  winnerTeamId: null,
  scheduledAt: new Date(NOW + 6 * HOUR),
});
const midPlayoffs = [...quarterfinals, semiDone, semiNext];

function texts(statuses: Map<string, TeamPlayoffStatus>) {
  return Object.fromEntries(
    [...statuses].map(([id, status]) => [id, playoffStatusText(status, name)]),
  );
}

describe("playoffStatuses", () => {
  it("says who is alive, who is out and who they meet", () => {
    expect(texts(playoffStatuses(teams, midPlayoffs, null, NOW))).toEqual({
      s1: "Through to the grand final",
      s2: "Semifinal vs Mid or Feed",
      s6: "Semifinal vs Dire Straits",
      s4: "Out in the semifinal (lost 0–2 to Radiant Raccoons)",
      s8: "Out in the quarterfinal (lost 1–2 to Radiant Raccoons)",
      s5: "Out in the quarterfinal (lost 1–2 to Pudge Patrol)",
      s7: "Out in the quarterfinal (lost 1–2 to Dire Straits)",
      s3: "Out in the quarterfinal (lost 0–2 to Mid or Feed)",
      x: "Missed the playoffs",
    });
  });

  it("carries the kickoff of the next series for the caller to show", () => {
    const status = playoffStatuses(teams, midPlayoffs, null, NOW).get("s2");
    expect(status).toMatchObject({
      kind: "playing",
      matchId: semiNext.id,
      when: "upcoming",
      scheduledAt: semiNext.scheduledAt,
    });
  });

  it("shows a live series' score from the team's side", () => {
    const live = { ...semiNext, status: "LIVE", homeScore: 0, awayScore: 1 };
    const statuses = playoffStatuses(teams, [...quarterfinals, semiDone, live], null, NOW);
    expect(playoffStatusText(statuses.get("s6")!, name)).toBe(
      "Semifinal vs Dire Straits · live, 1–0",
    );
    expect(playoffStatusText(statuses.get("s2")!, name)).toBe(
      "Semifinal vs Mid or Feed · live, 0–1",
    );
  });

  it("flags a series whose kickoff passed without a result, and one with no time", () => {
    const late = { ...semiNext, scheduledAt: new Date(NOW - HOUR) };
    expect(
      playoffStatusText(
        playoffStatuses(teams, [...quarterfinals, semiDone, late], null, NOW).get("s2")!,
        name,
      ),
    ).toBe("Semifinal vs Mid or Feed · awaiting result");
    const untimed = { ...semiNext, scheduledAt: null };
    expect(
      playoffStatusText(
        playoffStatuses(teams, [...quarterfinals, semiDone, untimed], null, NOW).get("s2")!,
        name,
      ),
    ).toBe("Semifinal vs Mid or Feed · time TBD");
  });

  it("crowns the champion and names the runner-up once the title is confirmed", () => {
    const semi2 = { ...semiNext, status: "COMPLETED", homeScore: 2, awayScore: 1, winnerTeamId: "s2" };
    const final = match({
      week: 10,
      phase: "FINAL",
      bracketSlot: "R2M0",
      homeTeamId: "s1",
      awayTeamId: "s2",
      homeScore: 1,
      awayScore: 2,
      winnerTeamId: "s2",
    });
    const all = [...quarterfinals, semiDone, semi2, final];
    const crowned = texts(playoffStatuses(teams, all, "s2", NOW));
    expect(crowned.s2).toBe("Champion");
    expect(crowned.s1).toBe(
      "Runner-up (lost the grand final 1–2 to Dire Straits)",
    );
    expect(crowned.s6).toBe("Out in the semifinal (lost 1–2 to Dire Straits)");

    // Title under review (or not crowned yet): neither finalist gets a line.
    const unconfirmed = playoffStatuses(teams, all, null, NOW);
    expect(unconfirmed.has("s1")).toBe(false);
    expect(unconfirmed.has("s2")).toBe(false);
    expect(unconfirmed.get("s6")?.kind).toBe("out");
    // A stored champion that isn't the final's winner is not believed.
    expect(playoffStatuses(teams, all, "s1", NOW).has("s1")).toBe(false);
  });

  it("marks a forfeit and a withdrawn team", () => {
    const ruled = quarterfinals.map((m) =>
      m.bracketSlot === "R0M3" ? { ...m, forfeit: true } : m,
    );
    const statuses = playoffStatuses(
      [...teams, { id: "w", withdrawn: true }],
      [...ruled, semiDone, semiNext],
      null,
      NOW,
    );
    expect(playoffStatusText(statuses.get("s3")!, name)).toBe(
      "Out in the quarterfinal (lost 0–2 to Mid or Feed by forfeit)",
    );
    expect(playoffStatusText(statuses.get("w")!, name)).toBe(
      "Not in the playoffs (withdrew)",
    );
  });

  it("says nothing before a bracket exists, except a recorded champion", () => {
    const regular = [match({ phase: "REGULAR", bracketSlot: null, week: 1 })];
    expect(playoffStatuses(teams, regular, null, NOW).size).toBe(0);
    expect(texts(playoffStatuses(teams, regular, "s3", NOW))).toEqual({
      s3: "Champion",
    });
  });

  it("names a first round it can't place by bracket depth plainly", () => {
    const legacy = [
      match({ bracketSlot: null, homeTeamId: "s1", awayTeamId: "s2", status: "SCHEDULED", winnerTeamId: null, scheduledAt: new Date(NOW + HOUR) }),
    ];
    expect(
      playoffStatusText(playoffStatuses(teams, legacy, null, NOW).get("s1")!, name),
    ).toBe("Playoffs vs Dire Straits");
  });
});

describe("playoffStatusChip", () => {
  it("says where each team stands in a few words, no opponent or score", () => {
    const chips = Object.fromEntries(
      [...playoffStatuses(teams, midPlayoffs, null, NOW)].map(([id, status]) => [
        id,
        playoffStatusChip(status),
      ]),
    );
    expect(chips).toMatchObject({
      s1: "Through to the grand final",
      s2: "In the semifinal",
      s4: "Out in the semifinal",
      s8: "Out in the quarterfinal",
      x: "Missed the playoffs",
    });
  });

  it("names the finalists once the title is confirmed, and a withdrawn team", () => {
    expect(playoffStatusChip({ kind: "champion" })).toBe("Champion");
    expect(
      playoffStatusChip({
        kind: "runner-up",
        opponentId: "s2",
        teamScore: 1,
        opponentScore: 2,
        forfeit: false,
      }),
    ).toBe("Runner-up");
    expect(playoffStatusChip({ kind: "missed", withdrawn: true })).toBe("Withdrew");
  });

  it("keeps a numbered round's name without \"the\"", () => {
    const playing: TeamPlayoffStatus = {
      kind: "playing",
      round: "Round 1",
      roundIndex: 0,
      matchId: "m",
      opponentId: "s2",
      teamScore: 0,
      opponentScore: 0,
      scheduledAt: null,
      when: "tbd",
    };
    expect(playoffStatusChip(playing)).toBe("In round 1");
    expect(
      playoffStatusChip({
        kind: "out",
        round: "Round 1",
        roundIndex: 0,
        opponentId: "s2",
        teamScore: 0,
        opponentScore: 2,
        forfeit: false,
      }),
    ).toBe("Out in round 1");
  });
});

describe("orderByPlayoffRun", () => {
  const seeds = new Map(
    ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((id, i) => [id, i + 1]),
  );
  const rank = new Map([...seeds, ["x", 9]]);
  const ids = ["x", "s8", "s7", "s6", "s5", "s4", "s3", "s2", "s1"];

  it("lists teams still alive by seed, then the deepest runs, then the rest", () => {
    const statuses = playoffStatuses(teams, midPlayoffs, null, NOW);
    expect(orderByPlayoffRun(ids, statuses, seeds, rank)).toEqual([
      "s1",
      "s2",
      "s6",
      "s4",
      "s3",
      "s5",
      "s7",
      "s8",
      "x",
    ]);
  });

  it("puts the champion, then the runner-up, first once the season is decided", () => {
    const semi2 = { ...semiNext, status: "COMPLETED", homeScore: 0, awayScore: 2, winnerTeamId: "s6" };
    const final = match({
      phase: "FINAL",
      bracketSlot: "R2M0",
      homeTeamId: "s1",
      awayTeamId: "s6",
      winnerTeamId: "s6",
      homeScore: 0,
      awayScore: 2,
    });
    const statuses = playoffStatuses(
      teams,
      [...quarterfinals, semiDone, semi2, final],
      "s6",
      NOW,
    );
    expect(orderByPlayoffRun(ids, statuses, seeds, rank).slice(0, 4)).toEqual([
      "s6",
      "s1",
      "s2",
      "s4",
    ]);
  });

  it("keeps standings order when there is no bracket", () => {
    expect(orderByPlayoffRun(ids, new Map(), new Map(), rank)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "s7",
      "s8",
      "x",
    ]);
  });
});
