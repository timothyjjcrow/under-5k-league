import { describe, it, expect } from "vitest";
import {
  signupMessage,
  draftStartedMessage,
  draftCompleteMessage,
  matchResultMessage,
  playoffsStartedMessage,
  championMessage,
} from "./discord";

describe("discord message formatters", () => {
  it("counts down remaining signups", () => {
    const msg = signupMessage("Zai", 17, 20);
    expect(msg).toContain("**Zai**");
    expect(msg).toContain("17 players");
    expect(msg).toContain("3 more to start");
  });

  it("celebrates when signups hit the threshold", () => {
    expect(signupMessage("Zai", 20, 20)).toContain("enough to start");
    expect(signupMessage("Zai", 25, 20)).toContain("enough to start");
  });

  it("uses singular for the first signup", () => {
    expect(signupMessage("Zai", 1, 20)).toContain("1 player in");
  });

  it("links the draft room when the draft starts", () => {
    const msg = draftStartedMessage("Season 1");
    expect(msg).toContain("Season 1");
    expect(msg).toContain("/draft");
  });

  it("links the teams page when the draft completes", () => {
    expect(draftCompleteMessage("Season 1")).toContain("/teams");
  });

  it("announces a decided series with the winner", () => {
    const msg = matchResultMessage({
      homeName: "A",
      awayName: "B",
      homeScore: 0,
      awayScore: 2,
      week: 3,
      isPlayoff: false,
    });
    expect(msg).toContain("Week 3");
    expect(msg).toContain("A 0–2 B");
    expect(msg).toContain("**B** take the series");
  });

  it("labels playoff results and handles draws", () => {
    const msg = matchResultMessage({
      homeName: "A",
      awayName: "B",
      homeScore: 1,
      awayScore: 1,
      week: 4,
      isPlayoff: true,
    });
    expect(msg).toContain("Playoffs:");
    expect(msg).toContain("a draw");
  });

  it("lists every playoff pairing", () => {
    const msg = playoffsStartedMessage("Season 1", [
      { home: "A", away: "D" },
      { home: "B", away: "C" },
    ]);
    expect(msg).toContain("A vs D");
    expect(msg).toContain("B vs C");
    expect(msg).toContain("/schedule");
  });

  it("crowns the champion", () => {
    const msg = championMessage("Season 1", "Zai's Team");
    expect(msg).toContain("**Zai's Team**");
    expect(msg).toContain("champions");
  });
});
