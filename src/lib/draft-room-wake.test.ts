import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DRAFT_ROOM, DRAFT_STATUS, SEASON_STATUS } from "./constants";
import {
  draftRoomClockAt,
  draftRoomDue,
  draftRoomWakeAt,
  type DraftRoomClockInput,
} from "./draft-room-wake";

// The draft room's clocks as a held tick reads them (draft-room-wake.ts).

const NOW = Date.UTC(2026, 9, 24, 2, 0, 0);
const GRACE = DRAFT_ROOM.LONG_POLL_CLOCK_GRACE_MS;
const RETRY = DRAFT_ROOM.LONG_POLL_DUE_RETRY_MS;

function rows(
  draft: Partial<NonNullable<DraftRoomClockInput["draft"]>> | null,
  season: Partial<DraftRoomClockInput["season"]> = {},
): DraftRoomClockInput {
  return {
    season: { isActive: true, status: SEASON_STATUS.DRAFT, ...season },
    draft:
      draft === null
        ? null
        : {
            status: DRAFT_STATUS.IN_PROGRESS,
            nominatedUserId: null,
            currentBidTeamId: null,
            nominatorTeamId: "team-1",
            bidEndsAt: null,
            nominationEndsAt: new Date(NOW + 60_000),
            ...draft,
          },
  };
}

/** A lot on the block whose bid clock runs out at `endsAt`. */
const lot = (endsAt: number) =>
  rows({
    nominatedUserId: "player-1",
    currentBidTeamId: "team-2",
    bidEndsAt: new Date(endsAt),
    nominationEndsAt: null,
  });

describe("draftRoomClockAt", () => {
  it("is the live lot's bid clock, or with no lot the nomination clock", () => {
    expect(draftRoomClockAt(lot(NOW + 30_000))).toBe(NOW + 30_000);
    expect(draftRoomClockAt(rows({}))).toBe(NOW + 60_000);
  });

  it("is null whenever the resolvers would not act", () => {
    for (const status of [
      DRAFT_STATUS.NOT_STARTED,
      DRAFT_STATUS.PAUSED,
      DRAFT_STATUS.COMPLETE,
    ]) {
      expect(draftRoomClockAt(rows({ status }))).toBeNull();
    }
    expect(draftRoomClockAt(rows(null))).toBeNull();
    // Phase is the outer gate: a live row stranded outside DRAFT, or on an
    // archived season, never settles.
    expect(
      draftRoomClockAt(rows({}, { status: SEASON_STATUS.REGULAR_SEASON })),
    ).toBeNull();
    expect(draftRoomClockAt(rows({}, { isActive: false }))).toBeNull();
    // Half a lot (no high bidder) or a turn with no team: nothing to settle.
    expect(
      draftRoomClockAt(
        rows({ nominatedUserId: "p", bidEndsAt: new Date(NOW), nominationEndsAt: null }),
      ),
    ).toBeNull();
    expect(draftRoomClockAt(rows({ nominatorTeamId: null }))).toBeNull();
  });
});

describe("draftRoomDue", () => {
  it("is due at the clock's zero, as the resolvers test it (not after `now`)", () => {
    expect(draftRoomDue(lot(NOW + 1), NOW)).toBe(false);
    expect(draftRoomDue(lot(NOW), NOW)).toBe(true);
    expect(draftRoomDue(rows({ nominationEndsAt: new Date(NOW - 1) }), NOW)).toBe(true);
    expect(draftRoomDue(rows({ status: DRAFT_STATUS.PAUSED }), NOW)).toBe(false);
  });

  it("mirrors both resolvers' act conditions", () => {
    // A source guard on the resolvers' own early returns: a resolver that
    // starts acting on another condition must change the due check with it,
    // or a held tick never wakes to settle that lot.
    const src = readFileSync(
      path.join(process.cwd(), "src/lib/draft-service.ts"),
      "utf8",
    );
    expect(src).toContain("if (draft.bidEndsAt.getTime() > Date.now()) return false;");
    expect(src).toContain("draft.nominationEndsAt.getTime() > Date.now()");
    expect(src).toMatch(
      /draft\.status !== DRAFT_STATUS\.IN_PROGRESS \|\|\s*!draft\.nominatedUserId \|\|\s*!draft\.currentBidTeamId \|\|\s*!draft\.bidEndsAt/,
    );
    expect(src).toMatch(
      /draft\.status !== DRAFT_STATUS\.IN_PROGRESS \|\|\s*draft\.nominatedUserId \|\|\s*!draft\.nominatorTeamId \|\|\s*!draft\.nominationEndsAt/,
    );
  });
});

describe("draftRoomWakeAt", () => {
  it("wakes a captain or an admin just after the clock, to settle the lot", () => {
    expect(draftRoomWakeAt(lot(NOW + 30_000), NOW, { role: "acts" })).toBe(
      NOW + 30_000 + GRACE,
    );
    expect(draftRoomWakeAt(rows({}), NOW, { role: "acts" })).toBe(
      NOW + 60_000 + GRACE,
    );
  });

  it("wakes any other signed-in viewer only after the captains' settle had its chance", () => {
    expect(draftRoomWakeAt(lot(NOW + 30_000), NOW, { role: "maintains" })).toBe(
      NOW + 30_000 + RETRY,
    );
    expect(RETRY).toBeGreaterThan(GRACE + DRAFT_ROOM.LONG_POLL_JITTER_MS);
  });

  it("never wakes a signed-out viewer on a clock: they wait for the publish", () => {
    expect(draftRoomWakeAt(lot(NOW + 30_000), NOW, { role: "reads" })).toBeNull();
    expect(draftRoomWakeAt(lot(NOW - 5_000), NOW, { role: "reads" })).toBeNull();
  });

  it("has nothing to wake on while no clock runs", () => {
    for (const role of ["acts", "maintains"] as const) {
      expect(draftRoomWakeAt(rows({ status: DRAFT_STATUS.PAUSED }), NOW, { role })).toBeNull();
      expect(draftRoomWakeAt(rows(null), NOW, { role })).toBeNull();
    }
  });

  it("answers at once when the clock ran out after the reply the client shows", () => {
    // The reply is from before the lot closed: it is already stale.
    const shownAt = NOW - 10_000;
    const wake = draftRoomWakeAt(lot(NOW - 5_000), NOW, {
      role: "acts",
      fromMs: shownAt,
    });
    expect(wake).toBe(NOW - 5_000 + GRACE);
    expect(wake!).toBeLessThanOrEqual(NOW);
  });

  it("retries a clock nobody settled at a fast poll's pace, once the client has seen it at zero", () => {
    // The shown reply is from after the wake time and the version hasn't
    // moved: another tick holds the claim, or its settle failed.
    for (const role of ["acts", "maintains"] as const) {
      expect(
        draftRoomWakeAt(lot(NOW - 5_000), NOW, { role, fromMs: NOW - 1_000 }),
      ).toBe(NOW + RETRY);
    }
  });

  it("reads a shown reply from the future as now", () => {
    expect(
      draftRoomWakeAt(lot(NOW - 5_000), NOW, { role: "acts", fromMs: NOW + 60_000 }),
    ).toBe(NOW + RETRY);
    expect(
      draftRoomWakeAt(lot(NOW + 5_000), NOW, { role: "acts", fromMs: NOW + 60_000 }),
    ).toBe(NOW + 5_000 + GRACE);
  });
});
