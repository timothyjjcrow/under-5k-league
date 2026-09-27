import { describe, expect, it } from "vitest";
import { playoffRoundLabel, scrimYieldedMessage } from "./scrim-discord";

const WHEN = Date.UTC(2026, 9, 4, 3, 0);
const EVIL = "[free mmr](https://evil.test)";

describe("scrim announcements", () => {
  it("says a booked scrim yielded to a league fixture, or that a live one must finish", () => {
    const cancelled = scrimYieldedMessage({
      scrimId: "s1",
      hostTeamName: "Radiant Raccoons",
      opponentTeamName: "Dire Straits",
      scrimAtMs: WHEN,
      cancelled: true,
      fixtureLabel: "the grand final",
      fixtureAtMs: WHEN + 3_600_000,
    });
    expect(cancelled).toContain("was cancelled: it clashed with the grand final");
    expect(cancelled).toContain("league matches come first");
    const kept = scrimYieldedMessage({
      scrimId: "s1",
      hostTeamName: "Radiant Raccoons",
      opponentTeamName: "Dire Straits",
      scrimAtMs: WHEN,
      cancelled: false,
      fixtureLabel: "the playoff semifinals",
      fixtureAtMs: WHEN + 3_600_000,
    });
    expect(kept).toContain("is still in progress");
    expect(kept).toContain("end it at its current score");
    expect(kept).toMatch(/\/scrims\/s1>$/);
  });

  it("escapes player-chosen team and captain names in every message", () => {
    const messages = [
      scrimYieldedMessage({
        scrimId: "s",
        hostTeamName: EVIL,
        opponentTeamName: EVIL,
        scrimAtMs: WHEN,
        cancelled: true,
        fixtureLabel: "the grand final",
        fixtureAtMs: WHEN,
      }),
    ];
    for (const msg of messages) expect(msg).not.toContain("](");
  });

  it("labels a playoff round by its number of fixtures", () => {
    expect(playoffRoundLabel(1)).toBe("the grand final");
    expect(playoffRoundLabel(2)).toBe("the playoff semifinals");
    expect(playoffRoundLabel(4)).toBe("the playoff quarterfinals");
    expect(playoffRoundLabel(8)).toBe("the next playoff round");
  });
});
