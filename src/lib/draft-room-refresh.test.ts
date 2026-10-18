import { describe, expect, it } from "vitest";
import { draftRoomNeedsRefresh, type DraftRoomPhase } from "./draft-room-refresh";

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
