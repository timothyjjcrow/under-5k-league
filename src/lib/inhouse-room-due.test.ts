import { describe, expect, it } from "vitest";
import { INHOUSE, INHOUSE_STATUS } from "./constants";
import { requeueLastSeenAt } from "./inhouse";
import {
  boardCheckDue,
  boardCheckKey,
  boardMemoAfterCheck,
  boardMemoAfterLostClaim,
  inhouseAllAccepted,
  inhouseAllVoted,
  inhouseClockDue,
  inhouseDraftPool,
  inhouseRoomDue,
  roomHeartbeatAction,
  type InhouseRoomDueInput,
  type InhouseRoomDueReason,
} from "./inhouse-room-due";
import type { InhouseBoardSyncOutcome } from "./inhouse-board-service";

// One row per resolver act condition, at its exact boundary. A clause that
// drifts from its resolver fails the row for that boundary.

const NOW = Date.UTC(2026, 9, 13, 20, 0, 0);
const at = (offsetMs: number) => new Date(NOW + offsetMs);
const HOUR = 3_600_000;

type Lobby = InhouseRoomDueInput["lobbies"][number];
type Player = Lobby["players"][number];

const player = (over: Partial<Player> = {}): Player => ({
  team: null,
  acceptedAt: null,
  votedMethod: null,
  ...over,
});
const ten = (over: Partial<Player> = {}) =>
  Array.from({ length: INHOUSE.LOBBY_SIZE }, () => player(over));

const lobby = (over: Partial<Lobby> = {}): Lobby => ({
  slot: 1,
  status: INHOUSE_STATUS.IN_PROGRESS,
  createdAt: at(-HOUR),
  startedAt: at(-HOUR / 2),
  acceptEndsAt: null,
  voteEndsAt: null,
  pickTeam: null,
  pickEndsAt: null,
  players: ten({ team: 1 }),
  ...over,
});

type QueueRow = InhouseRoomDueInput["queue"][number];
const queued = (over: Partial<QueueRow> = {}): QueueRow => ({
  lastSeenAt: at(-5_000),
  joinedAt: at(-HOUR),
  idleExpiresAt: at(3 * HOUR),
  ...over,
});
const present = (n: number) => Array.from({ length: n }, () => queued());

const input = (over: Partial<InhouseRoomDueInput> = {}): InhouseRoomDueInput => ({
  queue: [],
  lobbies: [],
  pending: [],
  ...over,
});

const ABANDON_READY = INHOUSE.ABANDON_READY_HOURS * HOUR;
const ABANDON_PLAYING = INHOUSE.ABANDON_IN_PROGRESS_HOURS * HOUR;
const ABANDON_PENDING = INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR;
const IDLE = INHOUSE.QUEUE_IDLE_HOURS * HOUR;
const AWAY = INHOUSE.QUEUE_AWAY_SECONDS * 1000;

const CASES: [string, InhouseRoomDueInput, InhouseRoomDueReason[]][] = [
  ["nothing at all", input(), []],
  [
    "a quiet room: a game in progress and a short queue",
    input({ lobbies: [lobby()], queue: present(4) }),
    [],
  ],

  // ---- resolveAbandonedLobby: strict lt on each floor -----------------------
  [
    "READY formed exactly at the floor",
    input({
      lobbies: [lobby({ status: INHOUSE_STATUS.READY, createdAt: at(-ABANDON_READY) })],
    }),
    [],
  ],
  [
    "READY formed 1ms past the floor",
    input({
      lobbies: [
        lobby({ status: INHOUSE_STATUS.READY, createdAt: at(-ABANDON_READY - 1) }),
      ],
    }),
    ["abandon"],
  ],
  [
    "IN_PROGRESS started exactly at the floor",
    input({ lobbies: [lobby({ startedAt: at(-ABANDON_PLAYING) })] }),
    [],
  ],
  [
    "IN_PROGRESS started 1ms past the floor",
    input({ lobbies: [lobby({ startedAt: at(-ABANDON_PLAYING - 1) })] }),
    ["abandon"],
  ],
  [
    "IN_PROGRESS with no startedAt (never matches the lt filter)",
    input({ lobbies: [lobby({ startedAt: null, createdAt: at(-100 * HOUR) })] }),
    [],
  ],
  [
    "a READY lobby is judged by createdAt, not startedAt",
    input({
      lobbies: [
        lobby({
          status: INHOUSE_STATUS.READY,
          createdAt: at(-HOUR),
          startedAt: at(-100 * HOUR),
        }),
      ],
    }),
    [],
  ],
  [
    "AWAITING_RESULT marked over exactly at the floor",
    input({ pending: [{ finishedAt: at(-ABANDON_PENDING) }] }),
    [],
  ],
  [
    "AWAITING_RESULT marked over 1ms past the floor",
    input({ pending: [{ finishedAt: at(-ABANDON_PENDING - 1) }] }),
    ["abandon"],
  ],
  [
    "AWAITING_RESULT with no finishedAt",
    input({ pending: [{ finishedAt: null }] }),
    [],
  ],

  // ---- expireStaticQueue ------------------------------------------------------
  [
    "idle deadline exactly now",
    input({ queue: [queued({ idleExpiresAt: at(0) })] }),
    [],
  ],
  [
    "idle deadline 1ms ago",
    input({ queue: [queued({ idleExpiresAt: at(-1) })] }),
    ["queueExpired"],
  ],
  [
    "legacy null deadline, joined exactly four hours ago",
    input({ queue: [queued({ idleExpiresAt: null, joinedAt: at(-IDLE) })] }),
    [],
  ],
  [
    "legacy null deadline, joined more than four hours ago",
    input({ queue: [queued({ idleExpiresAt: null, joinedAt: at(-IDLE - 1) })] }),
    ["queueExpired"],
  ],
  [
    "a stored deadline wins over an old join",
    input({
      queue: [queued({ idleExpiresAt: at(HOUR), joinedAt: at(-100 * HOUR) })],
    }),
    [],
  ],

  // ---- formOneLobby: a free slot by number and ten present -------------------
  [
    "ten present, no live game",
    input({ queue: present(INHOUSE.LOBBY_SIZE) }),
    ["formation"],
  ],
  [
    "nine present",
    input({ queue: present(INHOUSE.LOBBY_SIZE - 1) }),
    [],
  ],
  [
    "ten present, slots 1 and 2 held",
    input({
      queue: present(INHOUSE.LOBBY_SIZE),
      lobbies: [lobby({ slot: 1 }), lobby({ slot: 2 })],
    }),
    [],
  ],
  [
    "ten present, only slot 2 held (slot 1 is free)",
    input({ queue: present(INHOUSE.LOBBY_SIZE), lobbies: [lobby({ slot: 2 })] }),
    ["formation"],
  ],
  [
    "ten queued, one away: away rows don't count",
    input({
      queue: [
        ...present(INHOUSE.LOBBY_SIZE - 1),
        queued({ lastSeenAt: at(-AWAY - 1) }),
      ],
    }),
    [],
  ],
  [
    "ten queued, one seen exactly at the presence cutoff (present)",
    input({
      queue: [
        ...present(INHOUSE.LOBBY_SIZE - 1),
        queued({ lastSeenAt: at(-AWAY) }),
      ],
    }),
    ["formation"],
  ],

  // ---- resolveReadyCheck -----------------------------------------------------
  [
    "ready check, clock exactly now",
    input({
      lobbies: [lobby({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: at(0), players: ten() })],
    }),
    ["readyCheck"],
  ],
  [
    "ready check, clock 1ms ahead",
    input({
      lobbies: [lobby({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: at(1), players: ten() })],
    }),
    [],
  ],
  [
    "ready check, all accepted before the clock",
    input({
      lobbies: [
        lobby({
          status: INHOUSE_STATUS.READY_CHECK,
          acceptEndsAt: at(60_000),
          players: ten({ acceptedAt: at(-1_000) }),
        }),
      ],
    }),
    ["readyCheck"],
  ],
  [
    "ready check, nine of ten accepted before the clock",
    input({
      lobbies: [
        lobby({
          status: INHOUSE_STATUS.READY_CHECK,
          acceptEndsAt: at(60_000),
          players: [...ten({ acceptedAt: at(-1_000) }).slice(1), player()],
        }),
      ],
    }),
    [],
  ],
  [
    "ready check with no players and its clock ahead (never 'all accepted')",
    input({
      lobbies: [lobby({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: at(60_000), players: [] })],
    }),
    [],
  ],
  [
    "ready check with a null clock",
    input({
      lobbies: [lobby({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: null, players: ten() })],
    }),
    [],
  ],

  // ---- resolveCaptainVote ----------------------------------------------------
  [
    "vote, clock exactly now",
    input({
      lobbies: [lobby({ status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: at(0), players: ten() })],
    }),
    ["captainVote"],
  ],
  [
    "vote, clock 1ms ahead",
    input({
      lobbies: [lobby({ status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: at(1), players: ten() })],
    }),
    [],
  ],
  [
    "vote, all voted before the clock",
    input({
      lobbies: [
        lobby({
          status: INHOUSE_STATUS.CAPTAIN_VOTE,
          voteEndsAt: at(20_000),
          players: ten({ votedMethod: "MMR" }),
        }),
      ],
    }),
    ["captainVote"],
  ],
  [
    "vote, one ballot missing before the clock",
    input({
      lobbies: [
        lobby({
          status: INHOUSE_STATUS.CAPTAIN_VOTE,
          voteEndsAt: at(20_000),
          players: [...ten({ votedMethod: "MMR" }).slice(1), player()],
        }),
      ],
    }),
    [],
  ],
  [
    "vote with a null clock",
    input({
      lobbies: [lobby({ status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: null, players: ten() })],
    }),
    [],
  ],

  // ---- resolveStalledPick / restoreLostPickTurn -----------------------------
  [
    "draft with no pick turn",
    input({
      lobbies: [lobby({ status: INHOUSE_STATUS.DRAFTING, pickTeam: null, pickEndsAt: at(60_000) })],
    }),
    ["pickTurnLost"],
  ],
  [
    "draft, pick clock exactly now, pool not empty",
    input({
      lobbies: [
        lobby({ status: INHOUSE_STATUS.DRAFTING, pickTeam: 1, pickEndsAt: at(0), players: ten() }),
      ],
    }),
    ["pickClock"],
  ],
  [
    "draft, pick clock 1ms ahead",
    input({
      lobbies: [
        lobby({ status: INHOUSE_STATUS.DRAFTING, pickTeam: 1, pickEndsAt: at(1), players: ten() }),
      ],
    }),
    [],
  ],
  [
    "draft, pick clock run out but the pool is empty",
    input({
      lobbies: [
        lobby({
          status: INHOUSE_STATUS.DRAFTING,
          pickTeam: 1,
          pickEndsAt: at(-1_000),
          players: ten({ team: 2 }),
        }),
      ],
    }),
    [],
  ],
  [
    "draft with a null pick clock",
    input({
      lobbies: [
        lobby({ status: INHOUSE_STATUS.DRAFTING, pickTeam: 1, pickEndsAt: null, players: ten() }),
      ],
    }),
    [],
  ],

  // ---- several at once, in chain order, each once ----------------------------
  [
    "two games due and a full queue",
    input({
      queue: present(INHOUSE.LOBBY_SIZE),
      lobbies: [
        lobby({ slot: 1, status: INHOUSE_STATUS.DRAFTING, pickTeam: 2, pickEndsAt: at(-1), players: ten() }),
        lobby({ slot: 2, status: INHOUSE_STATUS.READY, createdAt: at(-ABANDON_READY - 1) }),
      ],
      pending: [{ finishedAt: at(-ABANDON_PENDING - 1) }],
    }),
    ["abandon", "pickClock"],
  ],
  [
    "both games' clocks run out in the same phase",
    input({
      lobbies: [
        lobby({ slot: 1, status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: at(-1), players: ten() }),
        lobby({ slot: 2, status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: at(-1), players: ten() }),
      ],
      queue: [queued({ idleExpiresAt: at(-1) })],
    }),
    ["queueExpired", "readyCheck"],
  ],
];

describe("inhouseRoomDue", () => {
  it.each(CASES)("%s", (_label, room, expected) => {
    expect(inhouseRoomDue(room, NOW)).toEqual(expected);
  });

  it("names a resolver for every reason", async () => {
    const { REASON_RESOLVER } = await import("./inhouse-room-due");
    for (const [, , reasons] of CASES) {
      for (const r of reasons) expect(REASON_RESOLVER[r]).toMatch(/^(resolve|maybe)/);
    }
  });
});

describe("the predicates the resolvers share", () => {
  it("a clock is due at its deadline, not 1ms before, and never when null", () => {
    expect(inhouseClockDue(at(0), NOW)).toBe(true);
    expect(inhouseClockDue(at(-1), NOW)).toBe(true);
    expect(inhouseClockDue(at(1), NOW)).toBe(false);
    expect(inhouseClockDue(null, NOW)).toBe(false);
  });

  it("all accepted / all voted need at least one player", () => {
    expect(inhouseAllAccepted([])).toBe(false);
    expect(inhouseAllAccepted([{ acceptedAt: at(0) }])).toBe(true);
    expect(inhouseAllAccepted([{ acceptedAt: at(0) }, { acceptedAt: null }])).toBe(false);
    expect(inhouseAllVoted([])).toBe(false);
    expect(inhouseAllVoted([{ votedMethod: "VOTE" }])).toBe(true);
    // An empty method is no ballot, exactly as the resolver's truthiness read.
    expect(inhouseAllVoted([{ votedMethod: "" }])).toBe(false);
    expect(inhouseAllVoted([{ votedMethod: "MMR" }, { votedMethod: null }])).toBe(false);
  });

  it("the pool is everyone on no team, in the order given", () => {
    const a = { id: "a", team: null };
    const b = { id: "b", team: 1 };
    const c = { id: "c", team: null };
    expect(inhouseDraftPool([a, b, c])).toEqual([a, c]);
  });
});

describe("roomHeartbeatAction", () => {
  const HB = INHOUSE.QUEUE_HEARTBEAT_SECONDS * 1000;
  it.each([
    ["not queued", null, null, "skip"],
    ["seen exactly 30s ago", { lastSeenAt: at(-HB) }, null, "skip"],
    ["seen 30s and 1ms ago", { lastSeenAt: at(-HB - 1) }, null, "write"],
    ["seen just now", { lastSeenAt: at(0) }, null, "skip"],
    ["a backdated requeue", { lastSeenAt: requeueLastSeenAt(NOW) }, null, "writeAndRefresh"],
    ["seen exactly at the presence cutoff", { lastSeenAt: at(-AWAY) }, null, "write"],
    ["seen 1ms past the presence cutoff", { lastSeenAt: at(-AWAY - 1) }, null, "writeAndRefresh"],
    ["a stale row this server already refreshed", { lastSeenAt: at(-HB - 1) }, NOW - 1_000, "skip"],
    ["a stale row refreshed too long ago", { lastSeenAt: at(-HB - 5) }, NOW - HB - 1, "write"],
  ] as const)("%s → %s", (_label, row, seenAtMs, expected) => {
    expect(roomHeartbeatAction(row, seenAtMs, NOW)).toBe(expected);
  });
});

describe("board checks", () => {
  const key = boardCheckKey("basis", ["u1", "u2"], 1);

  it("keys on the basis, the present ids and the away count", () => {
    expect(boardCheckKey("basis", ["u1", "u2"], 1)).toBe(key);
    expect(boardCheckKey("other", ["u1", "u2"], 1)).not.toBe(key);
    expect(boardCheckKey("basis", ["u2", "u1"], 1)).not.toBe(key);
    expect(boardCheckKey("basis", ["u1"], 1)).not.toBe(key);
    expect(boardCheckKey("basis", ["u1", "u2"], 2)).not.toBe(key);
  });

  it("is due with no memo and on a new key", () => {
    expect(boardCheckDue(null, key, NOW)).toBe(true);
    const memo = boardMemoAfterCheck(key, "unchanged", NOW);
    expect(boardCheckDue(memo, key, NOW + 1)).toBe(false);
    expect(boardCheckDue(memo, boardCheckKey("moved", [], 0), NOW + 1)).toBe(true);
  });

  it.each(["throttled", "failed"] as const)(
    "stays due after %s (the board is still behind)",
    (outcome) => {
      const memo = boardMemoAfterCheck(key, outcome, NOW);
      expect(boardCheckDue(memo, key, NOW + 1)).toBe(true);
    },
  );

  it.each(["off", "no-webhook", "cleared", "unchanged", "edited", "gone"] as const)(
    "settles after %s until the recheck",
    (outcome: InhouseBoardSyncOutcome) => {
      const memo = boardMemoAfterCheck(key, outcome, NOW);
      expect(boardCheckDue(memo, key, NOW + INHOUSE.BOARD_RECHECK_MS - 1)).toBe(false);
      expect(boardCheckDue(memo, key, NOW + INHOUSE.BOARD_RECHECK_MS)).toBe(true);
    },
  );

  it("backs off after a lost claim, even on a new key, then resumes", () => {
    const settled = boardMemoAfterCheck(key, "unchanged", NOW);
    const lost = boardMemoAfterLostClaim(settled, NOW + 10);
    const moved = boardCheckKey("moved", [], 0);
    expect(boardCheckDue(lost, moved, NOW + 10)).toBe(false);
    expect(
      boardCheckDue(lost, moved, NOW + 10 + INHOUSE.BOARD_CLAIM_BACKOFF_MS - 1),
    ).toBe(false);
    expect(
      boardCheckDue(lost, moved, NOW + 10 + INHOUSE.BOARD_CLAIM_BACKOFF_MS),
    ).toBe(true);
    // The last check still stands for the old key.
    expect(boardCheckDue(lost, key, NOW + 10 + INHOUSE.BOARD_CLAIM_BACKOFF_MS)).toBe(false);
    // A lost first claim backs off too, then checks.
    const first = boardMemoAfterLostClaim(null, NOW);
    expect(boardCheckDue(first, key, NOW + 1)).toBe(false);
    expect(boardCheckDue(first, key, NOW + INHOUSE.BOARD_CLAIM_BACKOFF_MS)).toBe(true);
  });
});
