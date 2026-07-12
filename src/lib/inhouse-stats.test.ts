import { describe, expect, it } from "vitest";
import {
  INHOUSE_ELO,
  summarizeInhouse,
  type FinishedLobby,
} from "./inhouse-stats";

function lobby(
  id: string,
  createdAt: number,
  winnerTeam: number | null,
  players: [string, number | null][], // [userId, team]
): FinishedLobby {
  return {
    id,
    createdAt,
    winnerTeam,
    players: players.map(([userId, team]) => ({
      userId,
      name: userId.toUpperCase(),
      avatar: null,
      team,
    })),
  };
}

describe("summarizeInhouse", () => {
  it("tallies wins/losses and win rate per player", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
      lobby("g2", 2, 2, [["a", 1], ["b", 2]]),
      lobby("g3", 3, 1, [["a", 1], ["b", 2]]),
    ]);
    const a = recs.find((r) => r.userId === "a")!;
    const b = recs.find((r) => r.userId === "b")!;
    expect(a).toMatchObject({ games: 3, wins: 2, losses: 1 });
    expect(a.winRate).toBeCloseTo(2 / 3);
    expect(b).toMatchObject({ games: 3, wins: 1, losses: 2 });
  });

  it("ignores lobbies with no reported winner and unassigned players", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, null, [["a", 1], ["b", 2]]), // no winner
      lobby("g2", 2, 1, [["a", 1], ["c", null]]), // c never got a team
    ]);
    expect(recs.find((r) => r.userId === "a")?.games).toBe(1);
    expect(recs.find((r) => r.userId === "b")).toBeUndefined();
    expect(recs.find((r) => r.userId === "c")).toBeUndefined();
  });

  it("tracks streaks chronologically regardless of input order", () => {
    // Fed newest-first; streak must still reflect chronological W,W,L for 'a'.
    const recs = summarizeInhouse([
      lobby("g3", 3, 2, [["a", 1]]), // loss (most recent)
      lobby("g1", 1, 1, [["a", 1]]), // win
      lobby("g2", 2, 1, [["a", 1]]), // win
    ]);
    expect(recs[0].streak).toBe(-1); // last game was a loss
  });

  it("ranks by rating", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
      lobby("g2", 2, 1, [["a", 1], ["b", 2]]),
      lobby("g3", 3, 1, [["c", 1], ["b", 2]]),
    ]);
    // a climbed twice, c once (vs an already-sunk b), b only lost.
    expect(recs.map((r) => r.userId)).toEqual(["a", "c", "b"]);
    expect(recs[0].rating).toBeGreaterThan(recs[1].rating);
    expect(recs[2].rating).toBeLessThan(INHOUSE_ELO.START);
  });

  it("moves evenly-rated sides by K/2 per game, same for every member", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [
        ["a", 1],
        ["b", 1],
        ["c", 2],
        ["d", 2],
      ]),
    ]);
    const rating = (id: string) => recs.find((r) => r.userId === id)!.rating;
    expect(rating("a")).toBe(INHOUSE_ELO.START + INHOUSE_ELO.K / 2);
    expect(rating("b")).toBe(INHOUSE_ELO.START + INHOUSE_ELO.K / 2);
    expect(rating("c")).toBe(INHOUSE_ELO.START - INHOUSE_ELO.K / 2);
    expect(rating("d")).toBe(INHOUSE_ELO.START - INHOUSE_ELO.K / 2);
  });

  it("pays an underdog win more than a favorite win", () => {
    // a beats b twice, then b finally wins one.
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
      lobby("g2", 2, 1, [["a", 1], ["b", 2]]),
      lobby("g3", 3, 2, [["a", 1], ["b", 2]]),
    ]);
    const b = recs.find((r) => r.userId === "b")!;
    // b's comeback must earn more than the even-match K/2.
    const comebackGain = b.rating - (INHOUSE_ELO.START - INHOUSE_ELO.K); // vs after 2 losses
    expect(comebackGain).toBeGreaterThan(INHOUSE_ELO.K / 2);
  });

  it("records form newest-first, capped at five results", () => {
    // Chronologically for a: W W L W L W L — form keeps the last 5, newest first.
    const outcomes: (1 | 2)[] = [1, 1, 2, 1, 2, 1, 2];
    const recs = summarizeInhouse(
      outcomes.map((winner, i) =>
        lobby(`g${i}`, i + 1, winner, [["a", 1], ["b", 2]]),
      ),
    );
    const a = recs.find((r) => r.userId === "a")!;
    expect(a.form).toEqual(["L", "W", "L", "W", "L"]);
    const b = recs.find((r) => r.userId === "b")!;
    expect(b.form).toEqual(["W", "L", "W", "L", "W"]);
  });

  it("reports the most recent game's rating swing as lastChange", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
    ]);
    const a = recs.find((r) => r.userId === "a")!;
    const b = recs.find((r) => r.userId === "b")!;
    // First game between even sides moves both by K/2, in opposite directions.
    expect(a.lastChange).toBe(INHOUSE_ELO.K / 2);
    expect(b.lastChange).toBe(-INHOUSE_ELO.K / 2);

    // After a second game the swing reflects only the latest result.
    const recs2 = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
      lobby("g2", 2, 2, [["a", 1], ["b", 2]]),
    ]);
    const a2 = recs2.find((r) => r.userId === "a")!;
    expect(a2.lastChange).toBeGreaterThan(0 - INHOUSE_ELO.K); // sane bound
    expect(a2.lastChange).toBeLessThan(0); // lost the latest game
    expect(a2.lastChange).toBe(-recs2.find((r) => r.userId === "b")!.lastChange);
  });

  it("leaves form empty and lastChange 0 for unrated appearances", () => {
    const recs = summarizeInhouse([lobby("g1", 1, null, [["a", 1], ["b", 2]])]);
    expect(recs.length).toBe(0); // no winner → nobody accrues anything

    const oneSided = summarizeInhouse([lobby("g2", 2, 1, [["c", 1]])]);
    const c = oneSided.find((r) => r.userId === "c")!;
    expect(c.form).toEqual(["W"]); // the win still counts for the record…
    expect(c.lastChange).toBe(0); // …but there was no side to rate against
  });

  it("tracks peak rating and never rates a one-sided lobby", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]), // a → 1016
      lobby("g2", 2, 2, [["a", 1], ["b", 2]]), // a falls back
      lobby("g3", 3, 1, [["c", 1]]), // no opposing side — unrated
    ]);
    const a = recs.find((r) => r.userId === "a")!;
    expect(a.peak).toBe(INHOUSE_ELO.START + INHOUSE_ELO.K / 2);
    expect(a.rating).toBeLessThan(a.peak);
    const c = recs.find((r) => r.userId === "c")!;
    expect(c.games).toBe(1);
    expect(c.rating).toBe(INHOUSE_ELO.START);
  });
});
