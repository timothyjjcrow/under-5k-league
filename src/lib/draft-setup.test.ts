import { describe, expect, it } from "vitest";
import { DRAFT_REMINDER, DRAFT_STATUS, SEASON_STATUS } from "./constants";
import { LIVE_WINDOW_MS } from "./countdown";
import {
  DRAFT_ROOM_LEAD_HOURS,
  captainTransferOpen,
  draftReminderDue,
  draftReminderOpensAt,
  draftRosterCounts,
  draftSeatPlan,
  draftSetupLockedMessage,
  draftNightSoon,
  draftSetupOpen,
  startDraftCheck,
  startDraftConfirm,
} from "./draft-setup";

describe("draftSetupOpen", () => {
  it("keeps setup open in signups and the pre-auction Draft waiting room", () => {
    expect(draftSetupOpen(SEASON_STATUS.SIGNUPS, null)).toBe(true);
    expect(draftSetupOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.NOT_STARTED)).toBe(
      true,
    );
  });

  it("locks every started-auction and later-phase state", () => {
    expect(draftSetupOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS)).toBe(
      false,
    );
    expect(draftSetupOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.PAUSED)).toBe(
      false,
    );
    expect(draftSetupOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE)).toBe(
      false,
    );
    expect(draftSetupOpen(SEASON_STATUS.REGULAR_SEASON, null)).toBe(false);
    expect(draftSetupOpen(SEASON_STATUS.COMPLETE, null)).toBe(false);
  });

  it("gives a phase-specific reason instead of a silent disabled control", () => {
    expect(draftSetupLockedMessage(SEASON_STATUS.REGULAR_SEASON, null)).toMatch(
      /regular season.*locked/i,
    );
    expect(draftSetupLockedMessage(SEASON_STATUS.COMPLETE, null)).toMatch(
      /historical.*read-only/i,
    );
  });
});

describe("draftReminderDue", () => {
  const DRAFT_AT = Date.parse("2026-09-20T19:00:00.000Z");
  const HOUR = 3_600_000;

  it("opens the documented window ahead of draft night", () => {
    expect(DRAFT_REMINDER.AHEAD_HOURS).toBe(24);
    expect(draftReminderOpensAt(DRAFT_AT)).toBe(DRAFT_AT - 24 * HOUR);
  });

  it("is due from the window opening until (not including) draftAt", () => {
    const due = (nowMs: number) =>
      draftReminderDue(SEASON_STATUS.SIGNUPS, null, DRAFT_AT, nowMs);
    expect(due(DRAFT_AT - 24 * HOUR - 1)).toBe(false);
    expect(due(DRAFT_AT - 24 * HOUR)).toBe(true);
    expect(due(DRAFT_AT - 1)).toBe(true);
    expect(due(DRAFT_AT)).toBe(false);
    expect(due(DRAFT_AT + HOUR)).toBe(false);
  });

  it("needs a scheduled time and an auction that hasn't started", () => {
    const now = DRAFT_AT - HOUR;
    expect(draftReminderDue(SEASON_STATUS.SIGNUPS, null, null, now)).toBe(false);
    expect(
      draftReminderDue(SEASON_STATUS.DRAFT, DRAFT_STATUS.NOT_STARTED, DRAFT_AT, now),
    ).toBe(true);
    for (const status of [
      DRAFT_STATUS.IN_PROGRESS,
      DRAFT_STATUS.PAUSED,
      DRAFT_STATUS.COMPLETE,
    ]) {
      expect(draftReminderDue(SEASON_STATUS.DRAFT, status, DRAFT_AT, now)).toBe(
        false,
      );
    }
    expect(
      draftReminderDue(SEASON_STATUS.REGULAR_SEASON, null, DRAFT_AT, now),
    ).toBe(false);
  });
});

describe("captainTransferOpen", () => {
  it("allows operational handover after the auction and in later live phases", () => {
    expect(
      captainTransferOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE),
    ).toBe(true);
    expect(captainTransferOpen(SEASON_STATUS.REGULAR_SEASON, null)).toBe(true);
    expect(captainTransferOpen(SEASON_STATUS.PLAYOFFS, null)).toBe(true);
  });

  it("blocks a live/paused auction and immutable completion", () => {
    expect(
      captainTransferOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS),
    ).toBe(false);
    expect(captainTransferOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.PAUSED)).toBe(
      false,
    );
    expect(captainTransferOpen(SEASON_STATUS.COMPLETE, null)).toBe(false);
  });
});

describe("draftSeatPlan", () => {
  it("blocks too few captains and an empty player pool", () => {
    expect(draftSeatPlan(1, 5, 20)).toMatchObject({ canStart: false });
    expect(draftSeatPlan(2, 5, 0)).toMatchObject({
      canStart: false,
      openSeats: 8,
    });
  });

  it("reports exact, short, and overflow pool shapes", () => {
    expect(draftSeatPlan(2, 5, 8)).toMatchObject({
      canStart: true,
      shortfall: 0,
      overflow: 0,
    });
    expect(draftSeatPlan(2, 5, 5)).toMatchObject({ shortfall: 3 });
    expect(draftSeatPlan(2, 5, 11)).toMatchObject({ overflow: 3 });
  });
});

describe("draftRosterCounts", () => {
  it("counts captains, bought players and the unrostered pool", () => {
    const teams = [
      {
        members: [
          { userId: "c1", isCaptain: true },
          { userId: "p1", isCaptain: false },
        ],
      },
      { members: [{ userId: "c2", isCaptain: true }] },
    ];
    const players = ["c1", "c2", "p1", "p2", "p3"].map((userId) => ({
      userId,
    }));
    expect(draftRosterCounts(teams, players)).toEqual({
      captainCount: 2,
      boughtCount: 1,
      poolCount: 2,
    });
  });
});

describe("startDraftCheck", () => {
  it("passes the seat plan's verdict through when rosters are captain-only", () => {
    expect(
      startDraftCheck({
        captainCount: 2,
        teamSize: 5,
        poolCount: 8,
        boughtCount: 0,
      }),
    ).toMatchObject({ canStart: true, blocker: null });
    expect(
      startDraftCheck({
        captainCount: 1,
        teamSize: 5,
        poolCount: 8,
        boughtCount: 0,
      }),
    ).toMatchObject({
      canStart: false,
      blocker: "Designate at least 2 captains before starting the auction.",
    });
  });

  it("blocks Start while non-captains are already on rosters", () => {
    const one = startDraftCheck({
      captainCount: 2,
      teamSize: 5,
      poolCount: 8,
      boughtCount: 1,
    });
    expect(one.canStart).toBe(false);
    expect(one.blocker).toMatch(/^1 non-captain roster member is already/);
    expect(
      startDraftCheck({
        captainCount: 2,
        teamSize: 5,
        poolCount: 8,
        boughtCount: 3,
      }).blocker,
    ).toMatch(/^3 non-captain roster members are already/);
  });
});

describe("startDraftConfirm", () => {
  const base = {
    captainCount: 2,
    minTeams: 4,
    teamSize: 5,
    draftScheduled: true,
    confirmations: { ready: 5, awaiting: 3, stale: 1, total: 9 },
    mmrWarning: "",
  };

  it("states the team count, seat fit, the way back and confirmations", () => {
    expect(
      startDraftConfirm({
        ...base,
        seats: { openSeats: 8, poolCount: 5 },
      }),
    ).toBe(
      "Start the draft with 2 captains? That is fewer than this season's 4-team target." +
        " 5 players for 8 open seats — 3 seats will go unfilled (standins cover them). Removing a captain would tighten it." +
        " Captains are locked once the auction begins — the way back is Abort draft, which returns every drafted player and refund and keeps the captains, but is refused once any result has been recorded." +
        " Draft confirmations: 5 of 9 ready; 3 awaiting; 1 must reconfirm. This is a warning only and does not block the draft.",
    );
  });

  it("covers an exact fit, an overflow and an unscheduled draft", () => {
    const exact = startDraftConfirm({
      ...base,
      minTeams: 2,
      seats: { openSeats: 8, poolCount: 8 },
      draftScheduled: false,
    });
    expect(exact).toContain(
      "Start the draft with 2 captains? The pool fits exactly: 8 players for 8 open seats.",
    );
    expect(exact).toContain(
      " No draft night is scheduled, so players have not been asked to confirm one.",
    );
    expect(
      startDraftConfirm({ ...base, seats: { openSeats: 8, poolCount: 9 } }),
    ).toContain(
      " 9 players for only 8 open seats — 1 player will go undrafted. Adding a captain opens 4 more seats.",
    );
  });

  it("ends with the MMR warning it is given", () => {
    const text = startDraftConfirm({
      ...base,
      seats: { openSeats: 8, poolCount: 8 },
      mmrWarning: " Unverified captain MMR sets draft budgets: A (no medal).",
    });
    expect(text.endsWith(" Unverified captain MMR sets draft budgets: A (no medal).")).toBe(true);
  });
});

describe("draftNightSoon", () => {
  const draftAt = Date.UTC(2026, 9, 3, 18, 0);
  const lead = DRAFT_ROOM_LEAD_HOURS * 3_600_000;

  it("opens the lead time before draft night and closes once it has passed", () => {
    const at = (offsetMs: number) =>
      draftNightSoon(SEASON_STATUS.SIGNUPS, draftAt, draftAt + offsetMs);
    expect(at(-lead - 1)).toBe(false);
    expect(at(-lead)).toBe(true);
    expect(at(0)).toBe(true);
    expect(at(LIVE_WINDOW_MS - 1)).toBe(true);
    expect(at(LIVE_WINDOW_MS)).toBe(false);
  });

  it("is Signups only and needs a scheduled draft night", () => {
    expect(draftNightSoon(SEASON_STATUS.DRAFT, draftAt, draftAt)).toBe(false);
    expect(draftNightSoon(SEASON_STATUS.REGULAR_SEASON, draftAt, draftAt)).toBe(
      false,
    );
    expect(draftNightSoon(null, draftAt, draftAt)).toBe(false);
    expect(draftNightSoon(SEASON_STATUS.SIGNUPS, null, draftAt)).toBe(false);
  });
});
