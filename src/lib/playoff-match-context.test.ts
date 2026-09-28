import { describe, expect, it } from "vitest";
import {
  playoffMatchContext,
  playoffMatchContextText,
  type PlayoffContextMatch,
} from "./playoff-match-context";

const names: Record<string, string> = {
  s1: "Radiant Raccoons",
  s2: "Dire Straits",
  s3: "Roshan's Revenge",
  s4: "Pudge Patrol",
  s5: "Tinker Tailors",
  s6: "Mid or Feed",
  s7: "Ward Wardens",
  s8: "Creep Skippers",
};
const name = (id: string) => names[id] ?? "?";

function match(
  slot: string,
  home: string,
  away: string,
  over: Partial<PlayoffContextMatch> = {},
): PlayoffContextMatch {
  return {
    id: slot,
    week: 8,
    phase: "PLAYOFF",
    bracketSlot: slot,
    status: "SCHEDULED",
    winnerTeamId: null,
    homeTeamId: home,
    awayTeamId: away,
    ...over,
  };
}
const won = (winner: string) => ({ status: "COMPLETED", winnerTeamId: winner });

describe("playoffMatchContext", () => {
  // A four-team bracket: semifinals R0M0 (s1 v s4) and R0M1 (s2 v s3).
  it("names the other semifinal's teams while it is still to play", () => {
    const semi = match("R0M0", "s1", "s4");
    const other = match("R0M1", "s2", "s3");
    const context = playoffMatchContext(semi, [semi, other]);
    expect(context).toEqual({
      kind: "ahead",
      nextRound: "Grand final",
      opponent: { winnerOf: ["s2", "s3"] },
    });
    expect(playoffMatchContextText(context!, name, "GGD2L")).toBe(
      "The winner goes through to the grand final to play the winner of Dire Straits vs Roshan's Revenge; the loser is knocked out.",
    );
  });

  it("names the team already waiting in the next round", () => {
    const semi = match("R0M1", "s2", "s3", { status: "LIVE" });
    const other = match("R0M0", "s1", "s4", won("s4"));
    const context = playoffMatchContext(semi, [other, semi]);
    expect(context).toEqual({
      kind: "ahead",
      nextRound: "Grand final",
      opponent: { teamId: "s4" },
    });
    expect(playoffMatchContextText(context!, name, "GGD2L")).toBe(
      "The winner goes through to the grand final to play Pudge Patrol; the loser is knocked out.",
    );
  });

  it("says who went through and who is out once a series is decided", () => {
    const semi = match("R0M0", "s1", "s4", won("s1"));
    const other = match("R0M1", "s2", "s3");
    const context = playoffMatchContext(semi, [semi, other]);
    expect(context).toEqual({
      kind: "decided",
      nextRound: "Grand final",
      winnerTeamId: "s1",
      loserTeamId: "s4",
      opponent: { winnerOf: ["s2", "s3"] },
      nextMatchId: null,
    });
    expect(playoffMatchContextText(context!, name, "GGD2L")).toBe(
      "Radiant Raccoons went through to the grand final to play the winner of Dire Straits vs Roshan's Revenge; Pudge Patrol was knocked out.",
    );
  });

  it("points a decided series at the winner's next match once it exists", () => {
    const semi = match("R0M1", "s2", "s3", won("s3"));
    const other = match("R0M0", "s1", "s4", won("s1"));
    const final = match("R1M0", "s1", "s3", { phase: "FINAL" });
    const context = playoffMatchContext(semi, [other, semi, final]);
    expect(context).toMatchObject({
      kind: "decided",
      winnerTeamId: "s3",
      loserTeamId: "s2",
      opponent: { teamId: "s1" },
      nextMatchId: "R1M0",
    });
  });

  it("pairs slots the way the bracket advances: M2 with M3 into M1", () => {
    // Eight teams: quarterfinals R0M0..R0M3, semifinals next.
    const quarters = [
      match("R0M0", "s1", "s8", won("s1")),
      match("R0M1", "s4", "s5", won("s5")),
      match("R0M2", "s2", "s7", won("s7")),
      match("R0M3", "s3", "s6"),
    ];
    const semi = match("R1M0", "s1", "s5");
    const bracket = [...quarters, semi];
    expect(playoffMatchContext(quarters[2], bracket)).toEqual({
      kind: "decided",
      nextRound: "Semifinals",
      winnerTeamId: "s7",
      loserTeamId: "s2",
      opponent: { winnerOf: ["s3", "s6"] },
      nextMatchId: null,
    });
    const text = playoffMatchContextText(
      playoffMatchContext(quarters[3], bracket)!,
      name,
      "GGD2L",
    );
    expect(text).toBe(
      "The winner goes through to the semifinals to play Ward Wardens; the loser is knocked out.",
    );
    // The first semifinal leads to the final, whose other half is unbuilt.
    expect(playoffMatchContext(semi, bracket)).toEqual({
      kind: "ahead",
      nextRound: "Grand final",
      opponent: null,
    });
    expect(
      playoffMatchContextText(playoffMatchContext(semi, bracket)!, name, "GGD2L"),
    ).toBe("The winner goes through to the grand final; the loser is knocked out.");
  });

  it("says an undecided grand final crowns the champion, and a decided one says nothing", () => {
    const final = match("R1M0", "s1", "s3", { phase: "FINAL" });
    const context = playoffMatchContext(final, [final]);
    expect(context).toEqual({ kind: "final" });
    expect(playoffMatchContextText(context!, name, "GGD2L Europe")).toBe(
      "The winner is crowned GGD2L Europe champion.",
    );
    const decided = { ...final, ...won("s1") };
    expect(playoffMatchContext(decided, [decided])).toBeNull();
  });

  it("stays quiet where the bracket can't place the series", () => {
    const regular = match("R0M0", "s1", "s2", { phase: "REGULAR" });
    expect(playoffMatchContext(regular, [])).toBeNull();
    const tiebreaker = match("TB1", "s1", "s2", { phase: "TIEBREAKER" });
    expect(playoffMatchContext(tiebreaker, [])).toBeNull();
    // A legacy playoff row with no slot.
    const legacy = match("R0M0", "s1", "s2", { bracketSlot: null });
    expect(playoffMatchContext(legacy, [legacy])).toBeNull();
    // A finished knockout with no winner can't be placed either.
    const drawn = match("R0M0", "s1", "s4", { status: "COMPLETED" });
    const other = match("R0M1", "s2", "s3");
    expect(playoffMatchContext(drawn, [drawn, other])).toBeNull();
  });

  it("ignores a sibling that finished without a winner", () => {
    const semi = match("R0M0", "s1", "s4");
    const other = match("R0M1", "s2", "s3", { status: "COMPLETED" });
    expect(playoffMatchContext(semi, [semi, other])).toEqual({
      kind: "ahead",
      nextRound: "Grand final",
      opponent: null,
    });
  });

  it("uses no article before a numbered round", () => {
    // Thirty-two teams: round 1 (R0) feeds round 2 (R1) before the quarters.
    const bracket = Array.from({ length: 16 }, (_, i) =>
      match(`R0M${i}`, `a${i}`, `b${i}`),
    );
    const context = playoffMatchContext(bracket[0], bracket);
    expect(context).toMatchObject({ kind: "ahead", nextRound: "Round 2" });
    expect(playoffMatchContextText(context!, (id) => id, "GGD2L")).toBe(
      "The winner goes through to round 2 to play the winner of a1 vs b1; the loser is knocked out.",
    );
  });
});
