import { describe, expect, it } from "vitest";
import { SCRIM_STATUS } from "./constants";
import {
  isScrimNotPlayed,
  scrimBookedToast,
  scrimEndConfirm,
  scrimEndedMessage,
  scrimHostLine,
  scrimJoinCheck,
  scrimNotPlayedCutoff,
} from "./scrim-view";
import {
  SCRIM_DETECT_WINDOW_AFTER_MS,
  SCRIM_PAST_GRACE_MS,
} from "./scrim-window";

describe("scrimHostLine", () => {
  it("says the posting captain hosts and who gets the lobby details", () => {
    expect(
      scrimHostLine({
        hostTeamName: "Radiant Raccoons",
        hostCaptainName: "Raccoon Cap",
        opponentCaptainName: "Straits Cap",
        bestOf: 3,
        region: "US East",
      }),
    ).toBe(
      "Raccoon Cap (Radiant Raccoons) hosts: make the Dota lobby on US East and send Straits Cap the lobby name and password on Discord. Bo3 = one lobby per game, first to 2 wins.",
    );
  });

  it("uses the region it is given and the series rule for the format", () => {
    const line = scrimHostLine({
      hostTeamName: "A",
      hostCaptainName: "a",
      opponentCaptainName: "b",
      bestOf: 2,
      region: "Europe West",
    });
    expect(line).toContain("on Europe West");
    expect(line).toContain("Bo2 = two separate lobbies.");
  });
});

describe("scrimJoinCheck", () => {
  const NOW = Date.UTC(2026, 9, 4, 3, 0);
  const base = {
    status: SCRIM_STATUS.OPEN,
    seasonOpen: true,
    signedIn: true,
    viewerTeam: { id: "mine", name: "Dire Straits", withdrawn: false },
    hostTeamId: "host",
    hostWithdrawn: false,
    scheduledAtMs: NOW + 3_600_000,
    nowMs: NOW,
  };

  it("lets another team's captain claim an open time", () => {
    expect(scrimJoinCheck(base)).toEqual({
      canJoin: true,
      teamName: "Dire Straits",
    });
  });

  it("offers nothing once the time is no longer open", () => {
    for (const status of [
      SCRIM_STATUS.SCHEDULED,
      SCRIM_STATUS.LIVE,
      SCRIM_STATUS.COMPLETED,
      SCRIM_STATUS.CANCELLED,
    ]) {
      expect(scrimJoinCheck({ ...base, status })).toBeNull();
    }
  });

  it("gives the reason a captain can't claim it", () => {
    const reason = (overrides: Partial<Parameters<typeof scrimJoinCheck>[0]>) => {
      const check = scrimJoinCheck({ ...base, ...overrides });
      return check && !check.canJoin ? check.reason : null;
    };
    expect(reason({ seasonOpen: false })).toMatch(/season is over/);
    expect(reason({ hostWithdrawn: true })).toMatch(/posted this time has withdrawn/);
    expect(reason({ viewerTeam: null })).toBe(
      "Only a team captain can claim a scrim time.",
    );
    expect(reason({ viewerTeam: { ...base.viewerTeam, id: "host" } })).toMatch(
      /your team's time/,
    );
    expect(
      reason({ viewerTeam: { ...base.viewerTeam, withdrawn: true } }),
    ).toMatch(/Your team has withdrawn/);
    expect(reason({ viewerTeamClash: "a league match" })).toBe(
      "Dire Straits already has a league match within four hours of this time.",
    );
  });

  it("asks a signed-out visitor to sign in", () => {
    expect(scrimJoinCheck({ ...base, signedIn: false, viewerTeam: null })).toEqual({
      canJoin: false,
      reason: "Sign in as a team captain to claim this time.",
      signIn: true,
    });
  });

  it("uses the service's grace for a time that has just started", () => {
    const edge = NOW - SCRIM_PAST_GRACE_MS;
    expect(scrimJoinCheck({ ...base, scheduledAtMs: edge })?.canJoin).toBe(true);
    const passed = scrimJoinCheck({ ...base, scheduledAtMs: edge - 1 });
    expect(passed && !passed.canJoin && passed.reason).toMatch(/time has passed/);
  });
});

describe("scrimBookedToast", () => {
  const base = {
    hostTeamName: "Radiant Raccoons",
    hostCaptainName: "Raccoon Cap",
    ownWithdrawn: 0,
    hostWithdrawn: 0,
  };

  it("says who hosts", () => {
    expect(scrimBookedToast(base)).toBe(
      "Scrim booked. Raccoon Cap (Radiant Raccoons) hosts and will send you the lobby details on Discord.",
    );
  });

  it("says which open times the booking withdrew, for each side", () => {
    expect(scrimBookedToast({ ...base, ownWithdrawn: 1 })).toContain(
      "Your other open time within four hours of it was withdrawn.",
    );
    expect(scrimBookedToast({ ...base, ownWithdrawn: 2 })).toContain(
      "Your 2 other open times within four hours of it were withdrawn.",
    );
    expect(scrimBookedToast({ ...base, hostWithdrawn: 1 })).toContain(
      "Radiant Raccoons's other open time within four hours of it was withdrawn.",
    );
    expect(scrimBookedToast({ ...base, hostWithdrawn: 3 })).toContain(
      "Radiant Raccoons's 3 other open times within four hours of it were withdrawn.",
    );
  });
});

describe("isScrimNotPlayed", () => {
  const NOW = Date.UTC(2026, 9, 4, 3, 0);
  const edge = NOW - SCRIM_DETECT_WINDOW_AFTER_MS;

  it("marks a booking not played 36 hours after its start", () => {
    expect(SCRIM_DETECT_WINDOW_AFTER_MS).toBe(36 * 60 * 60 * 1000);
    expect(isScrimNotPlayed(SCRIM_STATUS.SCHEDULED, edge - 1, NOW)).toBe(true);
    expect(isScrimNotPlayed(SCRIM_STATUS.SCHEDULED, edge, NOW)).toBe(false);
    expect(scrimNotPlayedCutoff(NOW).getTime()).toBe(edge);
  });

  it("only ever applies to a booking with no games", () => {
    for (const status of [
      SCRIM_STATUS.OPEN,
      SCRIM_STATUS.LIVE,
      SCRIM_STATUS.COMPLETED,
      SCRIM_STATUS.CANCELLED,
    ]) {
      expect(isScrimNotPlayed(status, edge - 1, NOW)).toBe(false);
    }
  });
});

describe("ending a series at its current score", () => {
  const score = {
    hostTeamName: "Radiant Raccoons",
    awayTeamName: "Dire Straits",
    hostScore: 0,
    awayScore: 1,
  };

  it("names the leader as the winner", () => {
    expect(scrimEndConfirm(score)).toBe(
      "End this series at 0–1? Dire Straits win it, and no more games can be added.",
    );
    expect(scrimEndedMessage(score)).toBe(
      "Series ended at 0–1. Dire Straits win it.",
    );
  });

  it("ends a level series with no winner", () => {
    const level = { ...score, hostScore: 1, awayScore: 1 };
    expect(scrimEndConfirm(level)).toBe(
      "End this series level at 1–1, with no winner? No more games can be added.",
    );
    expect(scrimEndedMessage(level)).toBe(
      "Series ended level at 1–1, with no winner.",
    );
  });
});
