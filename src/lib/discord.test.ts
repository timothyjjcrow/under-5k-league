import { describe, it, expect } from "vitest";
import {
  newsMessage,
  rescheduleMessage,
  signupMessage,
  draftStartedMessage,
  draftCompleteMessage,
  freeAgentSignedMessage,
  matchResultMessage,
  playerReleasedMessage,
  playerSoldMessage,
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

  it("announces a sale with the price", () => {
    const msg = playerSoldMessage("Fly", "Fear's Team", 23);
    expect(msg).toContain("**Fly**");
    expect(msg).toContain("**Fear's Team**");
    expect(msg).toContain("$23");
  });

  it("announces a free-agent signing", () => {
    const msg = freeAgentSignedMessage("Late Joiner", "Short Squad");
    expect(msg).toContain("**Late Joiner**");
    expect(msg).toContain("**Short Squad**");
    expect(msg).toContain("/teams");
  });

  it("announces a release", () => {
    const msg = playerReleasedMessage("Ghoster", "Short Squad");
    expect(msg).toContain("**Ghoster**");
    expect(msg).toContain("released from **Short Squad**");
  });

  it("flavors min-bid steals and big spends", () => {
    expect(playerSoldMessage("A", "T", 1)).toContain("steal");
    expect(playerSoldMessage("A", "T", 75)).toContain("big spender");
    expect(playerSoldMessage("A", "T", 20)).not.toMatch(/steal|big spender/);
  });
});

describe("rescheduleMessage", () => {
  it("announces the agreed new time", () => {
    const msg = rescheduleMessage({
      homeName: "A",
      awayName: "B",
      week: 3,
      isPlayoff: false,
      when: "Sat, Jul 18, 7:30 PM",
    });
    expect(msg).toContain("Week 3");
    expect(msg).toContain("**A** vs **B**");
    expect(msg).toContain("Sat, Jul 18, 7:30 PM");
  });

  it("labels playoff matches", () => {
    expect(
      rescheduleMessage({
        homeName: "A",
        awayName: "B",
        week: 9,
        isPlayoff: true,
        when: "x",
      }),
    ).toContain("Playoffs");
  });
});

describe("newsMessage", () => {
  it("announces the title with a body snippet and /news link", () => {
    const msg = newsMessage("Week 3 moved", "Matches now play Thursday.");
    expect(msg).toContain("**Week 3 moved**");
    expect(msg).toContain("Matches now play Thursday.");
    expect(msg).toContain("/news");
  });

  it("flattens whitespace and truncates long bodies", () => {
    const msg = newsMessage("T", `line one\n\nline two ${"x".repeat(300)}`);
    expect(msg).toContain("line one line two");
    expect(msg).toContain("…");
    expect(msg.length).toBeLessThan(300);
  });
});
