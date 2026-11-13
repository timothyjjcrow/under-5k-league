import { describe, expect, it } from "vitest";
import { SCRIM_STATUS } from "./constants";
import {
  isScrimNotPlayed,
  scrimBookedToast,
  scrimEndConfirm,
  scrimEndedMessage,
  scrimJoinCheck,
  scrimManageView,
  scrimNotPlayedCutoff,
  type ScrimViewerFacts,
} from "./scrim-view";
import {
  SCRIM_DETECT_WINDOW_AFTER_MS,
  SCRIM_PAST_GRACE_MS,
} from "./scrim-window";

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
      "Scrim booked. Raccoon Cap (Radiant Raccoons) hosts; the lobby's name, password and settings are on the scrim page.",
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

describe("scrimManageView", () => {
  const nobody: ScrimViewerFacts = {
    isAdmin: false,
    captainsHost: false,
    captainsAway: false,
    coachesHost: false,
    coachesAway: false,
    rostered: false,
  };
  const booked = {
    status: SCRIM_STATUS.SCHEDULED as string,
    hasOpponent: true,
    seasonOpen: true,
    notPlayed: false,
    hasTicket: true,
    kickoffPassed: false,
  };
  const view = (
    viewer: Partial<ScrimViewerFacts> | null,
    scrim: Partial<typeof booked> = {},
  ) =>
    scrimManageView({
      ...booked,
      ...scrim,
      viewer: viewer ? { ...nobody, ...viewer } : null,
    });

  it("gives either captain a booked scrim's guests, results, cancel and password", () => {
    for (const side of ["captainsHost", "captainsAway"] as const) {
      const v = view({ [side]: true });
      expect(v.role).toBe(side === "captainsHost" ? "host-captain" : "away-captain");
      expect(v.managesHost).toBe(side === "captainsHost");
      expect(v.managesAway).toBe(side === "captainsAway");
      expect(v).toMatchObject({
        booked: true,
        mutable: true,
        showCancel: true,
        canEndSeries: false,
        showResultTools: true,
        seesPassword: true,
      });
    }
  });

  it("lets a coach manage guests and results, never cancel or end", () => {
    const v = view({ coachesAway: true });
    expect(v).toMatchObject({
      role: "member",
      managesAway: true,
      managesHost: false,
      showResultTools: true,
      showCancel: false,
      canEndSeries: false,
      seesPassword: true,
    });
    expect(view({ coachesHost: true }, { status: SCRIM_STATUS.LIVE }).canEndSeries).toBe(false);
  });

  it("ends a live series instead of cancelling it", () => {
    const v = view({ captainsHost: true }, { status: SCRIM_STATUS.LIVE });
    expect(v).toMatchObject({
      booked: true,
      mutable: true,
      showCancel: false,
      canEndSeries: true,
      showResultTools: true,
    });
  });

  it("gives a rostered player the password and nothing to change", () => {
    expect(view({ rostered: true })).toMatchObject({
      role: "member",
      managesHost: false,
      managesAway: false,
      showCancel: false,
      showResultTools: false,
      seesPassword: true,
    });
  });

  it("gives a visitor or a signed-out viewer nothing", () => {
    for (const v of [view({}), view(null)]) {
      expect(v).toMatchObject({
        role: "other",
        managesHost: false,
        managesAway: false,
        showCancel: false,
        canEndSeries: false,
        showResultTools: false,
        seesPassword: false,
      });
    }
  });

  it("gives an admin cancel, results and the password on any scrim", () => {
    expect(view({ isAdmin: true })).toMatchObject({
      role: "other",
      managesHost: false,
      showCancel: true,
      showResultTools: true,
      seesPassword: true,
    });
    // Results stay open to an admin after the season, to nobody else.
    expect(view({ isAdmin: true }, { seasonOpen: false }).showResultTools).toBe(true);
    expect(view({ captainsHost: true }, { seasonOpen: false })).toMatchObject({
      mutable: false,
      showCancel: false,
      showResultTools: false,
    });
  });

  it("offers an open time's host only Cancel, and no away side to manage", () => {
    const v = view(
      { captainsHost: true, captainsAway: true, coachesAway: true },
      { status: SCRIM_STATUS.OPEN, hasOpponent: false },
    );
    expect(v).toMatchObject({
      role: "host-captain",
      managesAway: false,
      booked: false,
      mutable: true,
      showCancel: true,
      canEndSeries: false,
      showResultTools: false,
    });
  });

  it("stops listing a booking as booked once it reads as not played", () => {
    expect(view({ captainsHost: true }, { notPlayed: true })).toMatchObject({
      booked: false,
      // The captain who did play can still add the game by its match ID.
      showResultTools: true,
      foldTools: false,
    });
  });

  it("takes nothing on a finished or cancelled scrim", () => {
    for (const status of [SCRIM_STATUS.COMPLETED, SCRIM_STATUS.CANCELLED]) {
      expect(view({ captainsHost: true }, { status })).toMatchObject({
        booked: false,
        mutable: false,
        showCancel: false,
        canEndSeries: false,
        showResultTools: false,
      });
    }
  });

  it("folds the result tools away only while games record by themselves", () => {
    const captain = { captainsHost: true };
    expect(view(captain).foldTools).toBe(true);
    expect(view(captain, { kickoffPassed: true }).foldTools).toBe(false);
    expect(
      view(captain, { kickoffPassed: true, status: SCRIM_STATUS.LIVE }).foldTools,
    ).toBe(true);
    expect(view(captain, { hasTicket: false }).foldTools).toBe(false);
  });
});
