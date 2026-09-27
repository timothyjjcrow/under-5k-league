import { describe, expect, it } from "vitest";
import {
  playoffRoundLabel,
  scrimCancelledMessage,
  scrimClaimedMessage,
  scrimPostedMessage,
  scrimYieldedMessage,
} from "./scrim-discord";

const WHEN = Date.UTC(2026, 9, 4, 3, 0);
const EVIL = "[free mmr](https://evil.test)";

describe("scrim announcements", () => {
  it("offers a posted time to the other captains with a link to claim it", () => {
    const msg = scrimPostedMessage({
      scrimId: "s1",
      hostTeamName: "Radiant Raccoons",
      whenMs: WHEN,
      bestOf: 3,
    });
    expect(msg).toContain("**Radiant Raccoons**");
    expect(msg).toContain(`<t:${WHEN / 1000}:F>`);
    expect(msg).toContain("best of 3");
    expect(msg).toMatch(/\/scrims\/s1>$/);
  });

  it("tells the posting captain who claimed it, that they host, and what was withdrawn", () => {
    const withdrawn = [WHEN + 2 * 3_600_000, WHEN - 3_600_000];
    const msg = scrimClaimedMessage({
      scrimId: "s1",
      hostTeamName: "Radiant Raccoons",
      opponentTeamName: "Dire Straits",
      opponentCaptainName: "Straits Cap",
      whenMs: WHEN,
      bestOf: 1,
      withdrawnHostOffersMs: withdrawn,
    });
    expect(msg).toContain("**Dire Straits** claimed your scrim time");
    expect(msg).toContain("You host");
    expect(msg).toContain("**Straits Cap**");
    expect(msg).toContain("Your other open times within four hours");
    for (const ms of withdrawn) expect(msg).toContain(`<t:${ms / 1000}:f>`);
    expect(msg).toContain("were withdrawn");

    const none = scrimClaimedMessage({
      scrimId: "s1",
      hostTeamName: "Radiant Raccoons",
      opponentTeamName: "Dire Straits",
      opponentCaptainName: "Straits Cap",
      whenMs: WHEN,
      bestOf: 1,
      withdrawnHostOffersMs: [],
    });
    expect(none).not.toContain("withdrawn");
    const one = scrimClaimedMessage({
      scrimId: "s1",
      hostTeamName: "Radiant Raccoons",
      opponentTeamName: "Dire Straits",
      opponentCaptainName: "Straits Cap",
      whenMs: WHEN,
      bestOf: 1,
      withdrawnHostOffersMs: [WHEN + 3_600_000],
    });
    expect(one).toContain("Your other open time within four hours");
    expect(one).toContain("was withdrawn");
  });

  it("names who cancelled, or says an admin did", () => {
    expect(
      scrimCancelledMessage({
        hostTeamName: "Radiant Raccoons",
        opponentTeamName: "Dire Straits",
        whenMs: WHEN,
        cancellerName: "Raccoon Cap",
      }),
    ).toContain(
      "**Raccoon Cap** cancelled the **Radiant Raccoons** vs **Dire Straits** scrim on",
    );
    expect(
      scrimCancelledMessage({
        hostTeamName: "Radiant Raccoons",
        opponentTeamName: null,
        whenMs: WHEN,
        cancellerName: null,
      }),
    ).toContain("An admin cancelled **Radiant Raccoons**'s open scrim time on");
  });

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
      scrimPostedMessage({ scrimId: "s", hostTeamName: EVIL, whenMs: WHEN, bestOf: 1 }),
      scrimClaimedMessage({
        scrimId: "s",
        hostTeamName: EVIL,
        opponentTeamName: EVIL,
        opponentCaptainName: EVIL,
        whenMs: WHEN,
        bestOf: 1,
        withdrawnHostOffersMs: [],
      }),
      scrimCancelledMessage({
        hostTeamName: EVIL,
        opponentTeamName: EVIL,
        whenMs: WHEN,
        cancellerName: EVIL,
      }),
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
