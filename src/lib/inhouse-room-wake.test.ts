import { describe, expect, it } from "vitest";
import { INHOUSE, INHOUSE_STATUS } from "./constants";
import { inhouseDetectWindow } from "./inhouse";
import {
  boardMemoAfterCheck,
  boardMemoAfterLostClaim,
  boardRetryAtMs,
  inhouseRoomDue,
  type InhouseRoomDueInput,
} from "./inhouse-room-due";
import { inhouseRoomWakeAt, type InhouseRoomWakeInput } from "./inhouse-room-wake";
import { INHOUSE_DUEL, INHOUSE_DUEL_STATUS } from "./constants";

// When a held state request answers on its own (inhouse-room-wake.ts): each
// clock is a boundary where the due check or the reply flips, so a request
// that wakes LONG_POLL_CLOCK_GRACE_MS after it sees the flip.

const NOW = Date.UTC(2026, 9, 18, 20, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const GRACE = INHOUSE.LONG_POLL_CLOCK_GRACE_MS;

type Lobby = InhouseRoomDueInput["lobbies"][number];
type Queued = InhouseRoomDueInput["queue"][number];

const lobby = (over: Partial<Lobby>): Lobby => ({
  slot: 1,
  status: INHOUSE_STATUS.READY_CHECK,
  createdAt: new Date(NOW - MIN),
  startedAt: null,
  acceptEndsAt: null,
  voteEndsAt: null,
  pickTeam: null,
  pickEndsAt: null,
  players: [],
  ...over,
});
const queued = (over: Partial<Queued> = {}): Queued => ({
  lastSeenAt: new Date(NOW - 5 * SEC),
  joinedAt: new Date(NOW - HOUR),
  idleExpiresAt: new Date(NOW + 3 * HOUR),
  ...over,
});
const room = (over: Partial<InhouseRoomWakeInput> = {}): InhouseRoomWakeInput => ({
  queue: [],
  lobbies: [],
  pending: [],
  ...over,
});
const spectator = { maintains: false };
const member = { maintains: true };

/** A seat that has neither accepted, voted nor been picked. */
const seat = { team: null, acceptedAt: null, votedMethod: null };

describe("inhouseRoomWakeAt", () => {
  it("an empty room has no clock: the hold's own end decides", () => {
    expect(inhouseRoomWakeAt(room(), NOW, member)).toBeNull();
  });

  it.each([
    [INHOUSE_STATUS.READY_CHECK, "acceptEndsAt"],
    [INHOUSE_STATUS.CAPTAIN_VOTE, "voteEndsAt"],
    [INHOUSE_STATUS.DRAFTING, "pickEndsAt"],
  ] as const)("%s wakes just after its %s, when its resolver is due", (status, field) => {
    const endsAt = new Date(NOW + 20 * SEC);
    const rows = room({
      lobbies: [lobby({ status, [field]: endsAt, pickTeam: 1, players: [seat, seat] })],
    });
    const wake = inhouseRoomWakeAt(rows, NOW, spectator)!;
    expect(wake).toBe(endsAt.getTime() + GRACE);
    // The resolver the poll that wakes will find due, and not a moment before.
    expect(inhouseRoomDue(rows, endsAt.getTime() - 1)).toEqual([]);
    expect(inhouseRoomDue(rows, wake).length).toBeGreaterThan(0);
  });

  it("a played game wakes when its result window opens ('Game over' and the READY rate flip)", () => {
    const createdAt = new Date(NOW - 5 * MIN);
    for (const status of [INHOUSE_STATUS.READY, INHOUSE_STATUS.IN_PROGRESS]) {
      const startedAt = status === INHOUSE_STATUS.IN_PROGRESS ? new Date(NOW - 2 * MIN) : null;
      const opens = inhouseDetectWindow({
        status,
        createdAtMs: createdAt.getTime(),
        startedAtMs: startedAt?.getTime() ?? null,
      })!.opensAtMs;
      expect(opens).toBeGreaterThan(NOW);
      expect(
        inhouseRoomWakeAt(room({ lobbies: [lobby({ status, createdAt, startedAt })] }), NOW, spectator),
      ).toBe(opens + GRACE);
    }
  });

  it("a game long past its window still wakes for its abandon floor", () => {
    const createdAt = new Date(NOW - 5 * HOUR);
    const rows = room({ lobbies: [lobby({ status: INHOUSE_STATUS.READY, createdAt })] });
    const floor = createdAt.getTime() + INHOUSE.ABANDON_READY_HOURS * HOUR;
    const wake = inhouseRoomWakeAt(rows, NOW, spectator)!;
    expect(wake).toBe(floor + 1 + GRACE);
    expect(inhouseRoomDue(rows, floor)).toEqual([]);
    expect(inhouseRoomDue(rows, wake)).toEqual(["abandon"]);
  });

  it("a game marked over wakes for its give-up floor", () => {
    const finishedAt = new Date(NOW - 6 * HOUR + 30 * SEC);
    const rows = room({ pending: [{ finishedAt }] });
    const wake = inhouseRoomWakeAt(rows, NOW, spectator)!;
    expect(wake).toBe(finishedAt.getTime() + INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR + 1 + GRACE);
    expect(inhouseRoomDue(rows, wake)).toEqual(["abandon"]);
  });

  it("the queue wakes for its idle reset and for each player turning away", () => {
    const idle = room({ queue: [queued({ idleExpiresAt: new Date(NOW + 40 * SEC) })] });
    const idleWake = inhouseRoomWakeAt(idle, NOW, spectator)!;
    expect(idleWake).toBe(NOW + 40 * SEC + 1 + GRACE);
    expect(inhouseRoomDue(idle, idleWake)).toEqual(["queueExpired"]);
    // Legacy rows with no stored deadline reset from their join.
    const legacy = room({
      queue: [queued({ idleExpiresAt: null, joinedAt: new Date(NOW - INHOUSE.QUEUE_IDLE_HOURS * HOUR + 10 * SEC) })],
    });
    expect(inhouseRoomWakeAt(legacy, NOW, spectator)).toBe(NOW + 10 * SEC + 1 + GRACE);
    // A player last seen just under four hours ago turns away soon: their
    // row in the reply reads "away" from then on.
    const seenAt = NOW - INHOUSE.QUEUE_AWAY_SECONDS * SEC + 15 * SEC;
    const away = room({ queue: [queued({ lastSeenAt: new Date(seenAt) })] });
    expect(inhouseRoomWakeAt(away, NOW, spectator)).toBe(
      seenAt + INHOUSE.QUEUE_AWAY_SECONDS * SEC + 1 + GRACE,
    );
  });

  it("takes the earliest clock of every live game, and never one already past", () => {
    const rows = room({
      lobbies: [
        lobby({ slot: 1, status: INHOUSE_STATUS.DRAFTING, pickTeam: 1, pickEndsAt: new Date(NOW + 50 * SEC), players: [seat] }),
        lobby({ slot: 2, status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(NOW + 30 * SEC) }),
        // Ran out a while ago: due now, not a future wake.
        lobby({ slot: 1, status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(NOW - 5 * SEC) }),
      ],
    });
    expect(inhouseRoomWakeAt(rows, NOW, spectator)).toBe(NOW + 30 * SEC + GRACE);
  });

  it("a signed-in request that finds work due retries past the 2s claim", () => {
    // Another poll holds the maintenance claim and will publish; if it never
    // finishes, this request must try again as a fast poll would have.
    const rows = room({
      lobbies: [lobby({ status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(NOW - SEC) })],
    });
    expect(inhouseRoomDue(rows, NOW)).toEqual(["captainVote"]);
    expect(inhouseRoomWakeAt(rows, NOW, member)).toBe(NOW + INHOUSE.LONG_POLL_DUE_RETRY_MS);
    expect(INHOUSE.LONG_POLL_DUE_RETRY_MS).toBeGreaterThan(2_000);
    // A spectator can't run it, so waits for the publish (or the hold).
    expect(inhouseRoomWakeAt(rows, NOW, spectator)).toBeNull();
    // A clock sooner than the retry still wins.
    const sooner = room({
      lobbies: [
        ...rows.lobbies,
        lobby({ slot: 2, status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(NOW + 500) }),
      ],
    });
    expect(inhouseRoomWakeAt(sooner, NOW, member)).toBe(NOW + 500 + GRACE);
  });

  it("a draft with no turn is due at once for a member, as the due check says", () => {
    const rows = room({ lobbies: [lobby({ status: INHOUSE_STATUS.DRAFTING, pickTeam: null })] });
    expect(inhouseRoomDue(rows, NOW)).toEqual(["pickTurnLost"]);
    expect(inhouseRoomWakeAt(rows, NOW, member)).toBe(NOW + INHOUSE.LONG_POLL_DUE_RETRY_MS);
  });

  it("every wake is after now, so a hold can never spin", () => {
    const rows = room({
      queue: [queued({ idleExpiresAt: new Date(NOW - GRACE + 1) })],
      lobbies: [lobby({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(NOW - GRACE) })],
    });
    for (const o of [spectator, member]) {
      const wake = inhouseRoomWakeAt(rows, NOW, o);
      if (wake !== null) expect(wake).toBeGreaterThan(NOW);
    }
  });
});

describe("inhouseRoomWakeAt from the reply the client shows", () => {
  it("a clock that ran out after that reply answers at once (a wake at or before now)", () => {
    // A played game's result window opened while the tab was hidden: the
    // reply it shows predates "Game over", so it must not sit out a hold.
    const createdAt = new Date(NOW - 20 * MIN);
    const rows = room({ lobbies: [lobby({ status: INHOUSE_STATUS.READY, createdAt })] });
    const opens = inhouseDetectWindow({
      status: INHOUSE_STATUS.READY,
      createdAtMs: createdAt.getTime(),
      startedAtMs: null,
    })!.opensAtMs;
    expect(opens).toBeLessThan(NOW);
    for (const o of [spectator, member]) {
      const shownAt = opens - 30 * SEC;
      const wake = inhouseRoomWakeAt(rows, NOW, { ...o, fromMs: shownAt });
      expect(wake).toBe(opens + GRACE);
      expect(wake).toBeLessThanOrEqual(NOW);
      // A reply from after the window opened already shows it: no wake for it.
      const after = inhouseRoomWakeAt(rows, NOW, { ...o, fromMs: opens + GRACE });
      if (after !== null) expect(after).toBeGreaterThan(NOW);
      // Without the shown reply's clock, only clocks still ahead count.
      const ahead = inhouseRoomWakeAt(rows, NOW, o);
      if (ahead !== null) expect(ahead).toBeGreaterThan(NOW);
    }
  });

  it("each clock run out since the reply answers once: the next reply's clock is past it", () => {
    const rows = room({
      lobbies: [lobby({ status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(NOW - 3 * SEC) })],
    });
    expect(inhouseRoomWakeAt(rows, NOW, { ...spectator, fromMs: NOW - 10 * SEC })).toBe(
      NOW - 3 * SEC + GRACE,
    );
    // The reply that answered carries a later `now`; the next request sends it.
    expect(inhouseRoomWakeAt(rows, NOW + 50, { ...spectator, fromMs: NOW })).toBeNull();
  });

  it("a reply clock from the future counts from now, so it never hides a clock ahead", () => {
    const rows = room({
      lobbies: [lobby({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(NOW + 20 * SEC) })],
    });
    expect(inhouseRoomWakeAt(rows, NOW, { ...spectator, fromMs: NOW + HOUR })).toBe(
      NOW + 20 * SEC + GRACE,
    );
  });

  it("the viewer's post-game banner ends on a clock, for the viewer who played that game only", () => {
    const completedAt = new Date(NOW - INHOUSE.LAST_RESULT_WINDOW_MS + 40 * SEC);
    const rows = room({
      recentResults: [{ completedAt, players: [{ userId: "me" }, { userId: "them" }] }],
    });
    const end = completedAt.getTime() + INHOUSE.LAST_RESULT_WINDOW_MS + 1;
    expect(inhouseRoomWakeAt(rows, NOW, { ...member, viewerId: "me" })).toBe(end + GRACE);
    // buildInhouseState's boundary: shown at the window's last ms, gone 1ms on.
    expect(completedAt.getTime() >= end - 1 - INHOUSE.LAST_RESULT_WINDOW_MS).toBe(true);
    expect(completedAt.getTime() >= end - INHOUSE.LAST_RESULT_WINDOW_MS).toBe(false);
    // Nobody else's reply changes when it ends.
    expect(inhouseRoomWakeAt(rows, NOW, { ...member, viewerId: "someone-else" })).toBeNull();
    expect(inhouseRoomWakeAt(rows, NOW, spectator)).toBeNull();
    // A result with no completedAt never counts.
    expect(
      inhouseRoomWakeAt(
        room({ recentResults: [{ completedAt: null, players: [{ userId: "me" }] }] }),
        NOW,
        { ...member, viewerId: "me" },
      ),
    ).toBeNull();
  });
});

describe("a throttled board edit's retry", () => {
  const key = "board-key";

  it("is due BOARD_MIN_SECONDS after the throttled check, never inside a lost claim's back-off", () => {
    const throttled = boardMemoAfterCheck(key, "throttled", NOW);
    expect(boardRetryAtMs(throttled)).toBe(NOW + INHOUSE.BOARD_MIN_SECONDS * SEC);
    const lostLate = boardMemoAfterLostClaim(throttled, NOW + INHOUSE.BOARD_MIN_SECONDS * SEC - 500);
    expect(boardRetryAtMs(lostLate)).toBe(
      NOW + INHOUSE.BOARD_MIN_SECONDS * SEC - 500 + INHOUSE.BOARD_CLAIM_BACKOFF_MS,
    );
    // Only a throttle: a failed edit waits on its own back-off (20s and up),
    // and every settled outcome waits for the next change.
    for (const outcome of ["failed", "edited", "unchanged", "off", "no-webhook", "cleared", "gone"] as const) {
      expect(boardRetryAtMs(boardMemoAfterCheck(key, outcome, NOW))).toBeNull();
    }
    expect(boardRetryAtMs(null)).toBeNull();
    expect(boardRetryAtMs(boardMemoAfterLostClaim(null, NOW))).toBeNull();
  });

  it("wakes a signed-in hold at the retry; a signed-out one never checks the board", () => {
    // Two joins 4s apart: the second's board check came back throttled.
    const rows = room({ queue: [queued(), queued({ lastSeenAt: new Date(NOW) })] });
    const retryAt = boardRetryAtMs(boardMemoAfterCheck(key, "throttled", NOW - 4 * SEC))!;
    expect(inhouseRoomWakeAt(rows, NOW, { ...member, boardRetryAtMs: retryAt })).toBe(
      retryAt + GRACE,
    );
    // Well inside the 25s hold the request would otherwise sit out.
    expect(retryAt + GRACE - NOW).toBeLessThan(INHOUSE.LONG_POLL_HOLD_MS);
    expect(
      inhouseRoomWakeAt(rows, NOW, { ...spectator, boardRetryAtMs: retryAt }),
    ).toBeGreaterThan(NOW + INHOUSE.LONG_POLL_HOLD_MS);
    // No retry pending: the queue's own clocks only.
    expect(inhouseRoomWakeAt(rows, NOW, { ...member, boardRetryAtMs: null })).toBe(
      inhouseRoomWakeAt(rows, NOW, spectator),
    );
  });

  it("wakes for the 1v1 block's own clocks, for any viewer", () => {
    const expiresAt = new Date(NOW + 2 * MIN);
    const rows = room({
      duel: {
        queue: [{ lastSeenAt: new Date(NOW - 5 * SEC), expiresAt }],
        duels: [
          {
            status: INHOUSE_DUEL_STATUS.COMPLETED,
            createdAt: new Date(NOW - INHOUSE_DUEL.LAST_RESULT_WINDOW_MS),
            completedAt: new Date(NOW - INHOUSE_DUEL.LAST_RESULT_WINDOW_MS + 30 * SEC),
          },
        ],
      },
    });
    // The result leaves its window first (30s), then the waiter turns away.
    expect(inhouseRoomWakeAt(rows, NOW, spectator)).toBe(NOW + 30 * SEC + 1 + GRACE);
    const later = room({
      duel: { queue: [{ lastSeenAt: new Date(NOW), expiresAt }], duels: [] },
    });
    expect(inhouseRoomWakeAt(later, NOW, spectator)).toBe(expiresAt.getTime() + GRACE);
  });
});
