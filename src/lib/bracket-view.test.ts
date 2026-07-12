import { describe, expect, it } from "vitest";
import {
  mirrorLayout,
  type BracketMatchView,
  type BracketRound,
} from "./bracket-view";

let seq = 0;
function match(over: Partial<BracketMatchView> = {}): BracketMatchView {
  return {
    id: `m${++seq}`,
    home: { teamId: "h", name: "Home", seed: 1 },
    away: { teamId: "a", name: "Away", seed: 2 },
    homeScore: 0,
    awayScore: 0,
    completed: false,
    winnerTeamId: null,
    when: null,
    whenTs: null,
    bestOf: 3,
    ...over,
  };
}

function round(name: string, slots: (BracketMatchView | null)[]): BracketRound {
  return { name, slots };
}

describe("mirrorLayout", () => {
  it("returns null for an empty bracket", () => {
    expect(mirrorLayout([])).toBeNull();
  });

  it("renders a 2-team bracket as just the final, no wings", () => {
    const final = match();
    const layout = mirrorLayout([round("Grand Final", [final])])!;
    expect(layout.left).toEqual([]);
    expect(layout.right).toEqual([]);
    expect(layout.final).toBe(final);
    expect(layout.finalName).toBe("Grand Final");
  });

  it("splits a 4-team bracket into one semifinal per wing", () => {
    const semi1 = match();
    const semi2 = match();
    const final = match();
    const layout = mirrorLayout([
      round("Semifinals", [semi1, semi2]),
      round("Grand Final", [final]),
    ])!;
    expect(layout.left).toEqual([round("Semifinals", [semi1])]);
    expect(layout.right).toEqual([round("Semifinals", [semi2])]);
    expect(layout.final).toBe(final);
  });

  it("splits an 8-team bracket by slot halves, outermost round first", () => {
    const qf = [match(), match(), match(), match()];
    const sf = [match(), match()];
    const final = match();
    const layout = mirrorLayout([
      round("Quarterfinals", qf),
      round("Semifinals", sf),
      round("Grand Final", [final]),
    ])!;
    // Left wing carries QF slots 0-1 and SF slot 0 — the exact slots the
    // R{r}M{m} indexing feeds into each other.
    expect(layout.left).toEqual([
      round("Quarterfinals", [qf[0], qf[1]]),
      round("Semifinals", [sf[0]]),
    ]);
    expect(layout.right).toEqual([
      round("Quarterfinals", [qf[2], qf[3]]),
      round("Semifinals", [sf[1]]),
    ]);
    expect(layout.final).toBe(final);
  });

  it("keeps TBD (null) slots exactly where they sit", () => {
    const sf1 = match();
    const layout = mirrorLayout([
      round("Semifinals", [sf1, null]),
      round("Grand Final", [null]),
    ])!;
    expect(layout.left[0].slots).toEqual([sf1]);
    expect(layout.right[0].slots).toEqual([null]);
    expect(layout.final).toBeNull();
    expect(layout.finalName).toBe("Grand Final");
  });
});
