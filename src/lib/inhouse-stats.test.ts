import { describe, expect, it } from "vitest";
import { summarizeInhouse, type FinishedLobby } from "./inhouse-stats";

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

  it("ranks by wins, then win rate, then games", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
      lobby("g2", 2, 1, [["a", 1], ["b", 2]]),
      lobby("g3", 3, 1, [["c", 1], ["b", 2]]),
    ]);
    // a: 2 wins, c: 1 win, b: 0 wins → a, c, b
    expect(recs.map((r) => r.userId)).toEqual(["a", "c", "b"]);
  });
});
