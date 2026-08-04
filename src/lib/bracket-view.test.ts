import { describe, expect, it } from "vitest";
import {
  buildBracketRounds,
  mirrorLayout,
  type BracketMatchView,
  type BracketRound,
} from "./bracket-view";
import { MATCH_STATUS } from "./constants";

let seq = 0;
function match(over: Partial<BracketMatchView> = {}): BracketMatchView {
  return {
    id: `m${++seq}`,
    home: { teamId: "h", name: "Home", seed: 1 },
    away: { teamId: "a", name: "Away", seed: 2 },
    homeScore: 0,
    awayScore: 0,
    status: MATCH_STATUS.SCHEDULED,
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
    const layout = mirrorLayout([round("Final", [final])])!;
    expect(layout.left).toEqual([]);
    expect(layout.right).toEqual([]);
    expect(layout.final).toBe(final);
    expect(layout.finalName).toBe("Grand final");
  });

  it("splits a 4-team bracket into one semifinal per wing", () => {
    const semi1 = match();
    const semi2 = match();
    const final = match();
    const layout = mirrorLayout([
      round("Semifinals", [semi1, semi2]),
      round("Final", [final]),
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
      round("Final", [final]),
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
      round("Final", [null]),
    ])!;
    expect(layout.left[0].slots).toEqual([sf1]);
    expect(layout.right[0].slots).toEqual([null]);
    expect(layout.final).toBeNull();
    expect(layout.finalName).toBe("Grand final");
  });
});

describe("buildBracketRounds", () => {
  it("preserves live status and partial series scores for the client bracket", () => {
    const scheduledAt = new Date("2026-08-09T19:00:00.000Z");
    const rounds = buildBracketRounds(
      [
        {
          id: "live-final",
          bracketSlot: "R0M0",
          homeTeamId: "home",
          awayTeamId: "away",
          homeScore: 1,
          awayScore: 0,
          status: MATCH_STATUS.LIVE,
          winnerTeamId: null,
          scheduledAt,
          bestOf: 3,
        },
      ],
      new Map([
        ["home", "Home Team"],
        ["away", "Away Team"],
      ]),
      new Map([
        ["home", 1],
        ["away", 2],
      ]),
      (date) => date.toISOString(),
    );

    expect(rounds).toHaveLength(1);
    expect(rounds[0].name).toBe("Grand final");
    expect(rounds[0].slots[0]).toMatchObject({
      id: "live-final",
      homeScore: 1,
      awayScore: 0,
      status: MATCH_STATUS.LIVE,
      completed: false,
      when: scheduledAt.toISOString(),
      whenTs: scheduledAt.getTime(),
    });
  });
});
