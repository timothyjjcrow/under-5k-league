import { describe, expect, it } from "vitest";
import {
  DRAFT_ROOM_REFRESH_SPREAD_MS,
  draftRoomNeedsRefresh,
  draftRoomRefreshDelayMs,
  type DraftRoomPhase,
} from "./draft-room-refresh";

const phase = (seasonStatus: string, draftStatus: string): DraftRoomPhase => ({
  seasonStatus,
  draftStatus,
});

describe("draftRoomNeedsRefresh", () => {
  it("refreshes a tab parked before Start once the auction goes live", () => {
    // Started straight from Signups: both statuses move in one poll.
    expect(
      draftRoomNeedsRefresh(
        phase("SIGNUPS", "NOT_STARTED"),
        phase("DRAFT", "IN_PROGRESS"),
      ),
    ).toBe(true);
    // Signups were closed first: only the auction moves.
    expect(
      draftRoomNeedsRefresh(
        phase("DRAFT", "NOT_STARTED"),
        phase("DRAFT", "IN_PROGRESS"),
      ),
    ).toBe(true);
  });

  it("refreshes on pause, resume, completion and abort", () => {
    const steps: [DraftRoomPhase, DraftRoomPhase][] = [
      [phase("DRAFT", "IN_PROGRESS"), phase("DRAFT", "PAUSED")],
      [phase("DRAFT", "PAUSED"), phase("DRAFT", "IN_PROGRESS")],
      [phase("DRAFT", "IN_PROGRESS"), phase("DRAFT", "COMPLETE")],
      [phase("DRAFT", "IN_PROGRESS"), phase("SIGNUPS", "NOT_STARTED")],
      [phase("DRAFT", "COMPLETE"), phase("REGULAR_SEASON", "COMPLETE")],
    ];
    for (const [rendered, polled] of steps) {
      expect(draftRoomNeedsRefresh(rendered, polled)).toBe(true);
    }
  });

  it("never refreshes on a poll where nothing moved", () => {
    for (const p of [
      phase("SIGNUPS", "NOT_STARTED"),
      phase("DRAFT", "NOT_STARTED"),
      phase("DRAFT", "IN_PROGRESS"),
      phase("DRAFT", "PAUSED"),
      phase("DRAFT", "COMPLETE"),
    ]) {
      expect(draftRoomNeedsRefresh(p, { ...p })).toBe(false);
    }
  });

  it("never refreshes before it knows what the tab rendered", () => {
    expect(draftRoomNeedsRefresh(null, phase("DRAFT", "IN_PROGRESS"))).toBe(
      false,
    );
  });
});

describe("draftRoomRefreshDelayMs", () => {
  it("refreshes a captain's or an admin's tab at once", () => {
    expect(draftRoomRefreshDelayMs(true, () => 0.99)).toBe(0);
  });

  it("spreads everyone else's refresh over up to five seconds", () => {
    expect(draftRoomRefreshDelayMs(false, () => 0)).toBe(0);
    expect(draftRoomRefreshDelayMs(false, () => 0.5)).toBe(2_500);
    expect(draftRoomRefreshDelayMs(false, () => 0.9999)).toBeLessThanOrEqual(
      DRAFT_ROOM_REFRESH_SPREAD_MS,
    );
    // Out-of-contract randoms are clamped, never negative or past the spread.
    expect(draftRoomRefreshDelayMs(false, () => -1)).toBe(0);
    expect(draftRoomRefreshDelayMs(false, () => 7)).toBe(DRAFT_ROOM_REFRESH_SPREAD_MS);
    // Well inside the e2e's 15s wait for a parked tab's header.
    expect(DRAFT_ROOM_REFRESH_SPREAD_MS).toBeLessThanOrEqual(5_000);
  });
});
