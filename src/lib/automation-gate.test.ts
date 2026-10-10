import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  source: undefined as undefined | (() => Promise<unknown>),
  registration: undefined as
    | undefined
    | {
        keyParts: string[];
        options: { tags: string[]; revalidate: number | false };
      },
  cached: vi.fn<() => Promise<unknown>>(),
  unstableCache: vi.fn(),
  revalidateTag: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => ({
  automationRunState: { findUnique: vi.fn() },
  season: { findMany: vi.fn() },
  setting: { findMany: vi.fn(), findUnique: vi.fn() },
  inhouseLobby: { findMany: vi.fn(), findFirst: vi.fn() },
  inhouseQueueEntry: { findMany: vi.fn() },
  leagueAnnouncement: { findMany: vi.fn() },
  inhouseAnnouncement: { findMany: vi.fn() },
}));

const databaseNowMock = vi.hoisted(() => vi.fn());
const boardNeedsSyncMock = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({
  unstable_cache: cacheMocks.unstableCache.mockImplementation(
    (
      source: () => Promise<unknown>,
      keyParts: string[],
      options: { tags: string[]; revalidate: number | false },
    ) => {
      cacheMocks.source = source;
      cacheMocks.registration = { keyParts, options };
      return cacheMocks.cached;
    },
  ),
  revalidateTag: cacheMocks.revalidateTag,
}));

vi.mock("./prisma", () => ({ prisma: prismaMocks }));
vi.mock("./database-time", () => ({ databaseNow: databaseNowMock }));
vi.mock("./inhouse-board-service", () => ({
  inhouseBoardNeedsSync: boardNeedsSyncMock,
}));

import {
  AUTOMATION_GATE_CACHE_KEY,
  AUTOMATION_GATE_HARD_HORIZON_MS,
  AUTOMATION_GATE_TAG,
  automationGateDecisionFromSnapshot,
  computeAutomationGateSnapshot,
  getAutomationGateDecision,
  loadAutomationGateSnapshot,
  type AutomationGateInputs,
  type AutomationGateMatch,
  type AutomationGateSeason,
} from "./automation-gate";
import { invalidateAutomationGateBestEffort } from "./automation-gate-invalidation";
import { announcementClaimValue } from "./announcement-marker";
import { honorsClaimValue } from "./honors-service";
import {
  AUTO_SYNC,
  DRAFT_REMINDER,
  INHOUSE,
  INHOUSE_STATUS,
  WEEK_REMINDER,
} from "./constants";
import { RESULT_NUDGE } from "./result-nudge";
import { detectIntervalSeconds } from "./inhouse";
import {
  draftReminderKey,
  honorsAnnouncedKey,
  inhouseNightStartKey,
  resultAnnouncedKey,
  resultNudgeKey,
  SETTING_KEYS,
  weekReminderKey,
} from "./settings";
import {
  INHOUSE_NIGHT_START_POST_WINDOW_MS,
  serializeInhouseNight,
} from "./inhouse-night";

const NOW = Date.parse("2026-08-16T20:00:00.000Z");

function match(
  overrides: Partial<AutomationGateMatch> = {},
): AutomationGateMatch {
  return {
    id: "match-1",
    week: 1,
    phase: "REGULAR",
    bracketSlot: null,
    status: "SCHEDULED",
    scheduledAt: new Date(NOW + 24 * 3_600_000),
    autoSyncedAt: null,
    autoSyncAttempts: 0,
    completedAt: null,
    winnerTeamId: null,
    homeTeamId: "home",
    awayTeamId: "away",
    scheduleRevision: 0,
    games: [],
    ...overrides,
  };
}

function season(
  overrides: Partial<AutomationGateSeason> = {},
): AutomationGateSeason {
  return {
    id: "season-1",
    status: "SIGNUPS",
    dotaLeagueId: null,
    championTeamId: null,
    draftAt: null,
    draftRevision: 0,
    draft: null,
    matches: [],
    ...overrides,
  };
}

function inputs(
  overrides: Partial<AutomationGateInputs> = {},
): AutomationGateInputs {
  return {
    runner: {
      lastStatus: "SUCCEEDED",
      leaseExpiresAt: null,
      lastFinishedAt: new Date(NOW),
      consecutiveFailures: 0,
      lastSummary: "{}",
    },
    seasons: [],
    settings: {},
    leagueWebhookConfigured: false,
    leagueDeliveryAvailable: false,
    activeLobbies: [],
    awaitingResultLobbies: [],
    queue: [],
    repairableInhouseResult: false,
    leagueOutbox: [],
    inhouseOutboxes: [],
    outboxClock: { databaseNowMs: NOW, appNowMs: NOW },
    globalAnnouncementMarkers: [],
    boardNeedsSync: false,
    ...overrides,
  };
}

function queued(
  overrides: Partial<AutomationGateInputs["queue"][number]> = {},
): AutomationGateInputs["queue"][number] {
  return {
    joinedAt: new Date(NOW),
    lastSeenAt: new Date(NOW),
    idleExpiresAt: new Date(NOW + INHOUSE.QUEUE_IDLE_HOURS * 3_600_000),
    ...overrides,
  };
}

describe("computeAutomationGateSnapshot", () => {
  it("uses an immutable one-hour hard horizon for quiet state", () => {
    const snapshot = computeAutomationGateSnapshot(inputs(), NOW);

    expect(AUTOMATION_GATE_HARD_HORIZON_MS).toBe(60 * 60_000);
    expect(snapshot).toEqual({
      version: 12,
      computedAtMs: NOW,
      nextWakeAtMs: Number.MAX_SAFE_INTEGER,
      hardWakeAtMs: NOW + AUTOMATION_GATE_HARD_HORIZON_MS,
      reason: null,
      runnerHealthy: true,
    });
    expect(automationGateDecisionFromSnapshot(snapshot, NOW + 1)).toEqual({
      run: false,
      snapshot,
    });
    expect(
      automationGateDecisionFromSnapshot(
        snapshot,
        NOW + AUTOMATION_GATE_HARD_HORIZON_MS,
      ),
    ).toMatchObject({ run: true, snapshot });
  });

  it("anchors the hard wake to the last completed pass, not a later reader", () => {
    const lastFinishedAt =
      NOW - AUTOMATION_GATE_HARD_HORIZON_MS + 60_000;
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        runner: {
          lastStatus: "SUCCEEDED",
          leaseExpiresAt: null,
          lastFinishedAt: new Date(lastFinishedAt),
          consecutiveFailures: 0,
          lastSummary: "{}",
        },
      }),
      NOW,
    );

    expect(snapshot.hardWakeAtMs).toBe(
      lastFinishedAt + AUTOMATION_GATE_HARD_HORIZON_MS,
    );
    expect(
      automationGateDecisionFromSnapshot(snapshot, NOW + 60_000),
    ).toMatchObject({ run: true, snapshot });
  });

  it("wakes just after a live runner lease expires", () => {
    const leaseExpiresAt = new Date(NOW + 45_000);
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        runner: {
          lastStatus: "RUNNING",
          leaseExpiresAt,
          lastFinishedAt: new Date(NOW - 60_000),
          consecutiveFailures: 0,
          lastSummary: "{}",
        },
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: leaseExpiresAt.getTime() + 1,
      reason: "RUNNER",
    });
  });

  it("sleeps a known league delivery failure while delivery is unavailable", () => {
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        runner: {
          lastStatus: "DEGRADED",
          leaseExpiresAt: null,
          lastFinishedAt: new Date(NOW),
          consecutiveFailures: 1,
          lastSummary: JSON.stringify({
            issueCount: 1,
            skippedCount: 0,
            issues: ["LEAGUE_NOTIFICATION_DELIVERY_FAILED"],
            skipped: [],
          }),
        },
        leagueDeliveryAvailable: false,
        leagueOutbox: [
          {
            id: "blocked-delivery",
            status: "PENDING",
            availableAt: new Date(NOW),
            claimedAt: null,
            createdAt: new Date(NOW),
          },
        ],
      }),
      NOW,
    );

    expect(snapshot).toEqual({
      version: 12,
      computedAtMs: NOW,
      nextWakeAtMs: Number.MAX_SAFE_INTEGER,
      hardWakeAtMs: NOW + AUTOMATION_GATE_HARD_HORIZON_MS,
      reason: null,
      runnerHealthy: false,
    });
    expect(automationGateDecisionFromSnapshot(snapshot, NOW + 60_000)).toEqual({
      run: false,
      snapshot,
    });
  });

  it("keeps a blocked league delivery due when delivery becomes available", () => {
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        runner: {
          lastStatus: "DEGRADED",
          leaseExpiresAt: null,
          lastFinishedAt: new Date(NOW),
          consecutiveFailures: 1,
          lastSummary: JSON.stringify({
            issueCount: 1,
            skippedCount: 0,
            issues: ["LEAGUE_NOTIFICATION_DELIVERY_FAILED"],
            skipped: [],
          }),
        },
        leagueDeliveryAvailable: true,
        leagueOutbox: [
          {
            id: "deliverable",
            status: "PENDING",
            availableAt: new Date(NOW),
            claimedAt: null,
            createdAt: new Date(NOW),
          },
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "RUNNER",
      runnerHealthy: false,
    });
  });

  it("keeps degraded runners due when league delivery is not the only issue", () => {
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        runner: {
          lastStatus: "DEGRADED",
          leaseExpiresAt: null,
          lastFinishedAt: new Date(NOW),
          consecutiveFailures: 1,
          lastSummary: JSON.stringify({
            issueCount: 2,
            skippedCount: 0,
            issues: [
              "LEAGUE_NOTIFICATION_DELIVERY_FAILED",
              "BOARD_UPDATE_FAILED",
            ],
            skipped: [],
          }),
        },
        leagueDeliveryAvailable: false,
        leagueOutbox: [
          {
            id: "blocked-delivery",
            status: "PENDING",
            availableAt: new Date(NOW),
            claimedAt: null,
            createdAt: new Date(NOW),
          },
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "RUNNER",
      runnerHealthy: false,
    });
  });

  it("covers the league-wide throttle and per-match exponential backoff", () => {
    const openedAt = NOW - 30 * 60_000;
    const scheduledAt =
      openedAt - AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF * 60_000;
    const lastScanAt = NOW;
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        seasons: [
          season({
            status: "REGULAR_SEASON",
            matches: [
              match({
                scheduledAt: new Date(scheduledAt),
                autoSyncedAt: new Date(lastScanAt),
                autoSyncAttempts: 1,
              }),
            ],
          }),
        ],
        settings: {
          [SETTING_KEYS.ROSTER_AUTO_SYNC_AT]: new Date(NOW).toISOString(),
        },
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs:
        lastScanAt + AUTO_SYNC.MATCH_INTERVAL_SECONDS * 2 * 1_000 + 1,
      reason: "LEAGUE",
    });
  });

  it("does not wake at the young-match backoff after the grace cap changes", () => {
    const opensAt = NOW - (AUTO_SYNC.BACKOFF_GRACE_MINUTES - 1) * 60_000;
    const scheduledAt =
      opensAt - AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF * 60_000;
    const lastScanAt = NOW - 2 * 60_000;
    const fullInterval =
      AUTO_SYNC.MATCH_INTERVAL_SECONDS *
      2 ** AUTO_SYNC.BACKOFF_DOUBLINGS *
      1_000;
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        seasons: [
          season({
            status: "REGULAR_SEASON",
            matches: [
              match({
                scheduledAt: new Date(scheduledAt),
                autoSyncedAt: new Date(lastScanAt),
                autoSyncAttempts: AUTO_SYNC.BACKOFF_DOUBLINGS,
              }),
            ],
          }),
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: lastScanAt + fullInterval + 1,
      reason: "LEAGUE",
    });
  });

  it("does not let a league-id path hide the later roster fallback", () => {
    const scheduledAt = NOW - 60 * 60_000;
    const leagueThrottleAt = NOW + 20_000;
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        seasons: [
          season({
            status: "REGULAR_SEASON",
            dotaLeagueId: "42",
            matches: [match({ scheduledAt: new Date(scheduledAt) })],
          }),
        ],
        settings: {
          [SETTING_KEYS.LEAGUE_AUTO_SYNC_AT]: new Date(
            leagueThrottleAt - AUTO_SYNC.LEAGUE_INTERVAL_SECONDS * 1_000 - 1,
          ).toISOString(),
        },
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: leagueThrottleAt,
      reason: "LEAGUE",
    });
  });

  it("chooses the earliest live draft deadline", () => {
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        seasons: [
          season({
            status: "DRAFT",
            draft: {
              status: "IN_PROGRESS",
              bidEndsAt: new Date(NOW + 30_000),
              nominationEndsAt: new Date(NOW + 90_000),
            },
          }),
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW + 30_000,
      reason: "DRAFT",
    });
  });

  it("covers inhouse phase, queue presence, detection, and cleanup clocks", () => {
    const readyCheck = computeAutomationGateSnapshot(
      inputs({
        activeLobbies: [
          {
            status: "READY_CHECK",
            acceptEndsAt: new Date(NOW + 45_000),
            voteEndsAt: null,
            pickEndsAt: null,
            startedAt: null,
            detectedAt: null,
            createdAt: new Date(NOW),
          },
        ],
      }),
      NOW,
    );
    expect(readyCheck).toMatchObject({
      nextWakeAtMs: NOW + 45_000,
      reason: "INHOUSE",
    });

    const queue = Array.from({ length: INHOUSE.LOBBY_SIZE }, (_, index) => ({
      ...queued(),
      lastSeenAt: new Date(NOW - index),
    }));
    expect(
      computeAutomationGateSnapshot(inputs({ queue }), NOW),
    ).toMatchObject({ nextWakeAtMs: NOW, reason: "INHOUSE" });

    const startedAt = NOW - INHOUSE.DETECT_MIN_MINUTES * 60_000;
    expect(
      computeAutomationGateSnapshot(
        inputs({
          activeLobbies: [
            {
              status: "IN_PROGRESS",
              acceptEndsAt: null,
              voteEndsAt: null,
              pickEndsAt: null,
              startedAt: new Date(startedAt),
              detectedAt: null,
              createdAt: new Date(NOW),
            },
          ],
        }),
        NOW,
      ),
    ).toMatchObject({ nextWakeAtMs: NOW, reason: "INHOUSE" });
  });

  it("wakes for whichever live game's clock comes first", () => {
    type Lobby = AutomationGateInputs["activeLobbies"][number];
    const lobby = (overrides: Partial<Lobby>): Lobby => ({
      status: "DRAFTING",
      acceptEndsAt: null,
      voteEndsAt: null,
      pickEndsAt: null,
      startedAt: null,
      detectedAt: null,
      createdAt: new Date(NOW),
      ...overrides,
    });
    // Game 1's pick clock is far off; game 2's ready check closes first.
    const drafting = lobby({ pickEndsAt: new Date(NOW + 50_000) });
    const checking = lobby({
      status: "READY_CHECK",
      acceptEndsAt: new Date(NOW + 20_000),
    });
    for (const activeLobbies of [
      [drafting, checking],
      [checking, drafting],
    ]) {
      expect(
        computeAutomationGateSnapshot(inputs({ activeLobbies }), NOW),
      ).toMatchObject({ nextWakeAtMs: NOW + 20_000, reason: "INHOUSE" });
    }

    // Ten present players form the next game only while a slot is free.
    const queue = Array.from({ length: INHOUSE.LOBBY_SIZE }, () => queued());
    expect(
      computeAutomationGateSnapshot(
        inputs({ activeLobbies: [drafting], queue }),
        NOW,
      ),
    ).toMatchObject({ nextWakeAtMs: NOW, reason: "INHOUSE" });
    const full = Array.from({ length: INHOUSE.MAX_LIVE_GAMES }, () => drafting);
    expect(
      computeAutomationGateSnapshot(inputs({ activeLobbies: full, queue }), NOW)
        .nextWakeAtMs,
    ).toBe(NOW + 50_000);

    // More live lobbies than game slots is corruption: fail open.
    expect(() =>
      computeAutomationGateSnapshot(
        inputs({ activeLobbies: [...full, drafting] }),
        NOW,
      ),
    ).toThrow(/more active lobbies than game slots/);
  });

  it("runs immediately for a legacy queue older than four hours", () => {
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        queue: [
          queued({
            joinedAt: new Date(
              NOW - INHOUSE.QUEUE_IDLE_HOURS * 3_600_000 - 1,
            ),
            idleExpiresAt: null,
          }),
        ],
      }),
      NOW,
    );

    // Presence alone would wake at the four-hour away boundary. The joinedAt
    // fallback instead wakes now so a pre-deploy 13-hour queue is cleared.
    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "INHOUSE",
    });
  });

  it("treats an overdue shared queue deadline as immediately due", () => {
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        queue: [queued({ idleExpiresAt: new Date(NOW - 1) })],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "INHOUSE",
    });
  });

  it("wakes one millisecond after the strict queue deadline", () => {
    const idleExpiresAt = NOW + 30_000;
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        queue: [queued({ idleExpiresAt: new Date(idleExpiresAt) })],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: idleExpiresAt + 1,
      reason: "INHOUSE",
    });
  });

  it("keeps a background queue off the old three-minute cleanup cadence", () => {
    const lastSeenAt = NOW - 15 * 60_000;
    const snapshot = computeAutomationGateSnapshot(
      inputs({ queue: [queued({ lastSeenAt: new Date(lastSeenAt) })] }),
      NOW,
    );

    expect(INHOUSE.QUEUE_AWAY_SECONDS).toBe(4 * 60 * 60);
    expect(snapshot).toMatchObject({
      nextWakeAtMs: lastSeenAt + 4 * 3_600_000 + 1,
      reason: "INHOUSE",
      hardWakeAtMs: NOW + AUTOMATION_GATE_HARD_HORIZON_MS,
    });
    expect(automationGateDecisionFromSnapshot(snapshot, NOW + 1).run).toBe(false);
  });

  it("does not repeatedly wake for retained, backdated requeue players", () => {
    const idleExpiresAt = NOW + 30 * 60_000;
    const queue = Array.from({ length: INHOUSE.LOBBY_SIZE }, () =>
      queued({
        lastSeenAt: new Date(NOW - INHOUSE.QUEUE_AWAY_SECONDS * 1_000 - 1_000),
        idleExpiresAt: new Date(idleExpiresAt),
      }),
    );
    const snapshot = computeAutomationGateSnapshot(inputs({ queue }), NOW);

    // A full backdated roster is retained but cannot immediately re-form.
    // Its only remaining work is the shared queue reset, not a past presence
    // deadline that pins the worker on every request.
    expect(snapshot).toMatchObject({
      nextWakeAtMs: idleExpiresAt + 1,
      reason: "INHOUSE",
    });
    expect(automationGateDecisionFromSnapshot(snapshot, NOW + 1).run).toBe(false);
  });

  it("wakes once for an upcoming away transition, then waits for queue expiry", () => {
    const awayAt = NOW + 30_000;
    const idleExpiresAt = NOW + 30 * 60_000;
    const queue = [
      queued({
        lastSeenAt: new Date(awayAt - INHOUSE.QUEUE_AWAY_SECONDS * 1_000),
        idleExpiresAt: new Date(idleExpiresAt),
      }),
    ];

    expect(computeAutomationGateSnapshot(inputs({ queue }), NOW)).toMatchObject({
      nextWakeAtMs: awayAt + 1,
      reason: "INHOUSE",
    });
    expect(
      computeAutomationGateSnapshot(inputs({ queue }), awayAt + 1),
    ).toMatchObject({ nextWakeAtMs: idleExpiresAt + 1, reason: "INHOUSE" });
  });

  it("sleeps a just-started game until result detection opens", () => {
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        activeLobbies: [
          {
            status: "IN_PROGRESS",
            acceptEndsAt: null,
            voteEndsAt: null,
            pickEndsAt: null,
            startedAt: new Date(NOW),
            detectedAt: null,
            createdAt: new Date(NOW),
          },
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW + INHOUSE.DETECT_MIN_MINUTES * 60_000,
      reason: "INHOUSE",
    });
  });

  it("keeps scanning a game whose Start was pressed late", () => {
    // Formed an hour ago, scanned a minute ago, Start pressed just now: the
    // scan the READY window opened keeps its backoff instead of sleeping
    // another DETECT_MIN_MINUTES from the press.
    const formed = NOW - 60 * 60_000;
    const scannedAt = NOW - 60_000;
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        activeLobbies: [
          {
            status: "IN_PROGRESS",
            acceptEndsAt: null,
            voteEndsAt: null,
            pickEndsAt: null,
            startedAt: new Date(NOW),
            detectedAt: new Date(scannedAt),
            createdAt: new Date(formed),
          },
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs:
        scannedAt + detectIntervalSeconds(NOW - formed) * 1_000 + 1,
      reason: "INHOUSE",
    });
  });

  it("measures a late-started game's teardown from Start, as the resolver does", () => {
    // The scan runs on the formation clock here, but resolveAbandonedLobby
    // floors IN_PROGRESS on startedAt: waking on formation would pin the
    // worker on a teardown that cannot happen yet.
    const startedAt =
      NOW - (INHOUSE.ABANDON_IN_PROGRESS_HOURS * 60 - 1) * 60_000;
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        activeLobbies: [
          {
            status: "IN_PROGRESS",
            acceptEndsAt: null,
            voteEndsAt: null,
            pickEndsAt: null,
            startedAt: new Date(startedAt),
            // A scan just ran, so the next one is a full (grown) interval out.
            detectedAt: new Date(NOW),
            createdAt: new Date(startedAt - 60 * 60_000),
          },
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs:
        startedAt + INHOUSE.ABANDON_IN_PROGRESS_HOURS * 3_600_000 + 1,
      reason: "INHOUSE",
    });
  });

  it("wakes for a READY game's scan even though nobody pressed Start", () => {
    // Teams locked five minutes ago; nobody pressed the optional Start. The
    // worker must still come back to look for the result — it used to sleep
    // until a three-hour teardown.
    const readyLobby = (overrides: { detectedAt?: Date | null; createdAt: Date }) => ({
      status: "READY",
      acceptEndsAt: null,
      voteEndsAt: null,
      pickEndsAt: null,
      startedAt: null,
      detectedAt: null,
      ...overrides,
    });
    const formed = NOW - 10 * 60_000;
    expect(
      computeAutomationGateSnapshot(
        inputs({ activeLobbies: [readyLobby({ createdAt: new Date(formed) })] }),
        NOW,
      ),
    ).toMatchObject({
      nextWakeAtMs: formed + INHOUSE.DETECT_READY_MIN_MINUTES * 60_000,
      reason: "INHOUSE",
    });

    // Past the opening, a scanned READY lobby wakes on the scan's backoff,
    // not on the abandonment floor hours away.
    const oldFormed = NOW - 30 * 60_000;
    const scannedAt = NOW - 60_000;
    expect(
      computeAutomationGateSnapshot(
        inputs({
          activeLobbies: [
            readyLobby({
              createdAt: new Date(oldFormed),
              detectedAt: new Date(scannedAt),
            }),
          ],
        }),
        NOW,
      ),
    ).toMatchObject({
      nextWakeAtMs: scannedAt + INHOUSE.DETECT_INTERVAL_SECONDS * 1_000 + 1,
      reason: "INHOUSE",
    });
  });

  it("measures a READY lobby's teardown from formation, never from a scan stamp", () => {
    // The scan's detectedAt claim bumps updatedAt every few minutes, so the
    // floor has to run off a clock nothing rewrites.
    const formed = NOW - (INHOUSE.ABANDON_READY_HOURS * 60 - 1) * 60_000;
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        activeLobbies: [
          {
            status: "READY",
            acceptEndsAt: null,
            voteEndsAt: null,
            pickEndsAt: null,
            startedAt: null,
            // A scan just ran, so the next one is a full (grown) interval out
            // — later than the floor.
            detectedAt: new Date(NOW),
            createdAt: new Date(formed),
          },
        ],
      }),
      NOW,
    );
    expect(snapshot).toMatchObject({
      nextWakeAtMs: formed + INHOUSE.ABANDON_READY_HOURS * 3_600_000 + 1,
      reason: "INHOUSE",
    });
  });

  describe("games marked over (awaitingResultLobbies)", () => {
    type Awaiting = AutomationGateInputs["awaitingResultLobbies"][number];
    const MIN = 60_000;
    const HOUR = 3_600_000;
    const awaiting = (overrides: Partial<Awaiting> = {}): Awaiting => ({
      createdAt: new Date(NOW - 50 * MIN),
      startedAt: new Date(NOW - 44 * MIN),
      finishedAt: new Date(NOW - MIN),
      detectedAt: null,
      ...overrides,
    });
    type Live = AutomationGateInputs["activeLobbies"][number];
    const drafting: Live = {
      status: "DRAFTING",
      acceptEndsAt: null,
      voteEndsAt: null,
      pickEndsAt: new Date(NOW + 50_000),
      startedAt: null,
      detectedAt: null,
      createdAt: new Date(NOW),
    };

    it("scans a game marked over at once when it was never scanned", () => {
      expect(
        computeAutomationGateSnapshot(
          inputs({ awaitingResultLobbies: [awaiting()] }),
          NOW,
        ),
      ).toMatchObject({ nextWakeAtMs: NOW, reason: "INHOUSE" });
    });

    it("opens the scan at the press, even before the game's own window", () => {
      // Formed five minutes ago and never started: READY's own window is ten
      // minutes off, but the game is known to be over.
      const snapshot = computeAutomationGateSnapshot(
        inputs({
          awaitingResultLobbies: [
            awaiting({
              createdAt: new Date(NOW - 5 * MIN),
              startedAt: null,
              finishedAt: new Date(NOW - MIN),
            }),
          ],
        }),
        NOW,
      );
      expect(snapshot).toMatchObject({ nextWakeAtMs: NOW, reason: "INHOUSE" });
    });

    it("backs the scan off from the Game over press, not from the game's clock", () => {
      // A long game: its own age would stretch the interval to minutes. The
      // press restarts the backoff, as maybeAutoDetectResult measures it.
      const createdAt = NOW - 180 * MIN;
      const startedAt = NOW - 170 * MIN;
      const finishedAt = NOW - 2 * MIN;
      const scannedAt = NOW - MIN;
      expect(detectIntervalSeconds(NOW - createdAt)).toBeGreaterThan(
        detectIntervalSeconds(NOW - finishedAt),
      );
      expect(
        computeAutomationGateSnapshot(
          inputs({
            awaitingResultLobbies: [
              awaiting({
                createdAt: new Date(createdAt),
                startedAt: new Date(startedAt),
                finishedAt: new Date(finishedAt),
                // Scanned while it was still IN_PROGRESS, then marked over.
                detectedAt: new Date(scannedAt),
              }),
            ],
          }),
          NOW,
        ),
      ).toMatchObject({
        nextWakeAtMs:
          scannedAt + detectIntervalSeconds(NOW - finishedAt) * 1_000 + 1,
        reason: "INHOUSE",
      });

      // Hours after the press the backoff has grown again, from the press.
      const longAgo = NOW - 3 * HOUR;
      expect(
        computeAutomationGateSnapshot(
          inputs({
            awaitingResultLobbies: [
              awaiting({
                createdAt: new Date(longAgo - HOUR),
                startedAt: new Date(longAgo - 50 * MIN),
                finishedAt: new Date(longAgo),
                detectedAt: new Date(scannedAt),
              }),
            ],
          }),
          NOW,
        ).nextWakeAtMs,
      ).toBe(scannedAt + detectIntervalSeconds(NOW - longAgo) * 1_000 + 1);
    });

    it("wakes for the give-up floor ABANDON_AWAITING_RESULT_HOURS after the press", () => {
      // A minute short of the floor, just scanned: the next scan is a grown
      // interval out, so the give-up comes first. Its clock is the press —
      // the game's own IN_PROGRESS floor (from Start) passed long ago.
      const finishedAt =
        NOW - (INHOUSE.ABANDON_AWAITING_RESULT_HOURS * 60 - 1) * MIN;
      const startedAt = finishedAt - 50 * MIN;
      expect(
        startedAt + INHOUSE.ABANDON_IN_PROGRESS_HOURS * HOUR,
      ).toBeLessThan(NOW);
      const snapshot = computeAutomationGateSnapshot(
        inputs({
          awaitingResultLobbies: [
            awaiting({
              createdAt: new Date(startedAt - 10 * MIN),
              startedAt: new Date(startedAt),
              finishedAt: new Date(finishedAt),
              detectedAt: new Date(NOW),
            }),
          ],
        }),
        NOW,
      );
      expect(snapshot).toMatchObject({
        nextWakeAtMs:
          finishedAt + INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR + 1,
        reason: "INHOUSE",
      });

      // Past the floor (the sweep missed it), it is due now.
      expect(
        computeAutomationGateSnapshot(
          inputs({
            awaitingResultLobbies: [
              awaiting({
                createdAt: new Date(NOW - 8 * HOUR),
                startedAt: new Date(NOW - 8 * HOUR + 5 * MIN),
                finishedAt: new Date(NOW - 7 * HOUR),
                detectedAt: new Date(NOW),
              }),
            ],
          }),
          NOW,
        ).nextWakeAtMs,
      ).toBe(NOW);
    });

    it("wakes for whichever game marked over comes due first", () => {
      // x: scanned just now, next scan in three minutes. y: give-up in a minute.
      const x = awaiting({ finishedAt: new Date(NOW - MIN), detectedAt: new Date(NOW) });
      const yFinished =
        NOW - (INHOUSE.ABANDON_AWAITING_RESULT_HOURS * 60 - 1) * MIN;
      const y = awaiting({
        createdAt: new Date(yFinished - HOUR),
        startedAt: new Date(yFinished - 50 * MIN),
        finishedAt: new Date(yFinished),
        detectedAt: new Date(NOW),
      });
      for (const awaitingResultLobbies of [
        [x, y],
        [y, x],
      ]) {
        expect(
          computeAutomationGateSnapshot(inputs({ awaitingResultLobbies }), NOW)
            .nextWakeAtMs,
        ).toBe(yFinished + INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR + 1);
      }
    });

    it("fails open on a game marked over without a finish time", () => {
      // A row the clocks can't be read from must run the worker, never sleep it.
      expect(() =>
        computeAutomationGateSnapshot(
          inputs({ awaitingResultLobbies: [awaiting({ finishedAt: null })] }),
          NOW,
        ),
      ).toThrow(/lobby marked over has no finish time/);
      expect(() =>
        computeAutomationGateSnapshot(
          inputs({
            awaitingResultLobbies: [
              awaiting(),
              awaiting({ finishedAt: new Date("invalid") }),
            ],
          }),
          NOW,
        ),
      ).toThrow(/awaitingResultLobbies\[1\]\.finishedAt is not a valid timestamp/);
      expect(() =>
        computeAutomationGateSnapshot(
          inputs({
            awaitingResultLobbies: [awaiting({ detectedAt: new Date(Number.NaN) })],
          }),
          NOW,
        ),
      ).toThrow(/awaitingResultLobbies\[0\]\.detectedAt is not a valid timestamp/);
    });

    it("never counts toward the game slots: ten queued players still form the next game", () => {
      const queue = Array.from({ length: INHOUSE.LOBBY_SIZE }, () => queued());
      // Each marked-over game next wakes three minutes out (scanned just now).
      const quiet = awaiting({ detectedAt: new Date(NOW) });
      const many = Array.from(
        { length: INHOUSE.MAX_LIVE_GAMES + 1 },
        () => quiet,
      );
      expect(
        computeAutomationGateSnapshot(
          inputs({ awaitingResultLobbies: many }),
          NOW,
        ).nextWakeAtMs,
      ).toBe(NOW + INHOUSE.DETECT_INTERVAL_SECONDS * 1_000 + 1);

      // A slot free: formation is due now, however many games are marked over.
      const oneShort = Array.from(
        { length: INHOUSE.MAX_LIVE_GAMES - 1 },
        () => drafting,
      );
      for (const activeLobbies of [[], oneShort]) {
        expect(
          computeAutomationGateSnapshot(
            inputs({ activeLobbies, awaitingResultLobbies: many, queue }),
            NOW,
          ),
        ).toMatchObject({ nextWakeAtMs: NOW, reason: "INHOUSE" });
      }

      // Every slot live: no formation (the pick clock is next), and games
      // marked over are not the "more active lobbies than slots" corruption.
      const full = Array.from(
        { length: INHOUSE.MAX_LIVE_GAMES },
        () => drafting,
      );
      expect(
        computeAutomationGateSnapshot(
          inputs({ activeLobbies: full, awaitingResultLobbies: many, queue }),
          NOW,
        ).nextWakeAtMs,
      ).toBe(NOW + 50_000);
    });
  });

  it("honors outbox availability and lease recovery without overtaking", () => {
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        leagueDeliveryAvailable: true,
        leagueOutbox: [
          {
            id: "older",
            status: "SENDING",
            availableAt: new Date(NOW - 60_000),
            claimedAt: new Date(NOW),
            createdAt: new Date(NOW - 1_000),
          },
          {
            id: "newer",
            status: "PENDING",
            availableAt: new Date(NOW),
            claimedAt: null,
            createdAt: new Date(NOW),
          },
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW + 30_001,
      reason: "LEAGUE_OUTBOX",
    });
  });

  it("translates database-owned outbox deadlines onto the app clock", () => {
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        leagueDeliveryAvailable: true,
        outboxClock: {
          databaseNowMs: NOW + 5_000,
          appNowMs: NOW,
        },
        leagueOutbox: [
          {
            id: "clock-skewed",
            status: "PENDING",
            availableAt: new Date(NOW + 15_000),
            claimedAt: null,
            createdAt: new Date(NOW),
          },
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW + 10_000,
      reason: "LEAGUE_OUTBOX",
    });
  });

  it("wakes at a reminder window and at an unexpired marker claim", () => {
    const kickoff = NOW + 60 * 60_000;
    const marker = weekReminderKey("season-1", 1, kickoff);
    const claimExpiry = NOW + 55_000;
    const uuidA = "11111111-1111-4111-8111-111111111111";
    const uuidB = "22222222-2222-4222-8222-222222222222";
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        seasons: [
          season({
            status: "REGULAR_SEASON",
            matches: [match({ scheduledAt: new Date(kickoff) })],
          }),
        ],
        leagueWebhookConfigured: true,
        settings: {
          [marker]: `claim:v2:${claimExpiry}:${uuidA}:${uuidB}`,
        },
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: claimExpiry,
      reason: "REMINDER",
    });
    expect(kickoff - WEEK_REMINDER.AHEAD_HOURS * 3_600_000).toBeLessThan(NOW);
  });

  it("wakes for the draft-night reminder window and follows its revision marker", () => {
    const uuidA = "11111111-1111-4111-8111-111111111111";
    const uuidB = "22222222-2222-4222-8222-222222222222";
    const quiet = {
      nextWakeAtMs: Number.MAX_SAFE_INTEGER,
      reason: null,
    };
    const gate = (
      seasonOverrides: Partial<AutomationGateSeason>,
      settings: Record<string, string> = {},
      leagueWebhookConfigured = true,
    ) =>
      computeAutomationGateSnapshot(
        inputs({
          seasons: [season({ draftRevision: 3, ...seasonOverrides })],
          leagueWebhookConfigured,
          settings,
        }),
        NOW,
      );
    const window = DRAFT_REMINDER.AHEAD_HOURS * 3_600_000;

    // Before the window: wake exactly when it opens.
    const later = NOW + window + 6 * 3_600_000;
    expect(gate({ draftAt: new Date(later) })).toMatchObject({
      nextWakeAtMs: later - window,
      reason: "REMINDER",
    });

    // Inside the window with no marker (or a failed one): due now, in both
    // setup phases.
    const soon = NOW + 2 * 3_600_000;
    const key = draftReminderKey("season-1", 3);
    expect(gate({ draftAt: new Date(soon) })).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "REMINDER",
    });
    expect(
      gate(
        {
          status: "DRAFT",
          draftAt: new Date(soon),
          draft: { status: "NOT_STARTED", bidEndsAt: null, nominationEndsAt: null },
        },
        { [key]: `failed:v2:${uuidA}:${NOW - 1_000}` },
      ),
    ).toMatchObject({ nextWakeAtMs: NOW, reason: "REMINDER" });

    // A live claim wakes at its lease expiry; a sent marker is done. A marker
    // for an OLD revision says nothing about the current one.
    const claimExpiry = NOW + 55_000;
    expect(
      gate(
        { draftAt: new Date(soon) },
        { [key]: `claim:v2:${claimExpiry}:${uuidA}:${uuidB}` },
      ),
    ).toMatchObject({ nextWakeAtMs: claimExpiry, reason: "REMINDER" });
    expect(
      gate({ draftAt: new Date(soon) }, { [key]: `sent:v2:${uuidA}:${NOW}` }),
    ).toMatchObject(quiet);
    expect(
      gate(
        { draftAt: new Date(soon) },
        { [draftReminderKey("season-1", 2)]: `sent:v2:${uuidA}:${NOW}` },
      ),
    ).toMatchObject({ nextWakeAtMs: NOW, reason: "REMINDER" });

    // Silent once the draft time has passed, once the auction started, with
    // no draft time, and with no league webhook to post through.
    expect(gate({ draftAt: new Date(NOW - 1_000) })).toMatchObject(quiet);
    expect(
      gate({
        status: "DRAFT",
        draftAt: new Date(soon),
        draft: { status: "COMPLETE", bidEndsAt: null, nominationEndsAt: null },
      }),
    ).toMatchObject(quiet);
    expect(gate({ draftAt: null })).toMatchObject(quiet);
    expect(gate({ draftAt: new Date(soon) }, {}, false)).toMatchObject(quiet);
  });

  it("wakes at an inhouse night's start and follows its start-post marker", () => {
    const uuidA = "11111111-1111-4111-8111-111111111111";
    const uuidB = "22222222-2222-4222-8222-222222222222";
    const quiet = { nextWakeAtMs: Number.MAX_SAFE_INTEGER, reason: null };
    const night = (startsAtMs: number) => ({
      id: "night-1",
      startsAtMs,
      note: "",
      createdAtMs: NOW - 86_400_000,
      revision: 0,
      discordEventId: null,
    });
    const gate = (startsAtMs: number, marker?: string) =>
      computeAutomationGateSnapshot(
        inputs({
          settings: {
            [SETTING_KEYS.INHOUSE_NIGHT]: serializeInhouseNight(night(startsAtMs)),
            ...(marker === undefined
              ? {}
              : { [inhouseNightStartKey("night-1", startsAtMs)]: marker }),
          },
        }),
        NOW,
      );

    // Before the start: wake exactly at it. No season is needed.
    expect(gate(NOW + 3_600_000)).toMatchObject({
      nextWakeAtMs: NOW + 3_600_000,
      reason: "REMINDER",
    });
    // Started, no marker yet (or a failed one): due now.
    const started = NOW - 60_000;
    expect(gate(started)).toMatchObject({ nextWakeAtMs: NOW, reason: "REMINDER" });
    expect(gate(started, `failed:v2:${uuidA}:${NOW - 1_000}`)).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "REMINDER",
    });
    // A live claim wakes at its lease expiry; a sent or covered marker is done.
    const claimExpiry = NOW + 55_000;
    expect(gate(started, `claim:v2:${claimExpiry}:${uuidA}:${uuidB}`)).toMatchObject({
      nextWakeAtMs: claimExpiry,
      reason: "REMINDER",
    });
    expect(gate(started, `sent:v2:${uuidA}:${NOW}`)).toMatchObject(quiet);
    // Past the post window nothing wakes, posted or not.
    expect(gate(NOW - INHOUSE_NIGHT_START_POST_WINDOW_MS - 1)).toMatchObject(quiet);
    // A value that won't parse wakes nothing.
    expect(
      computeAutomationGateSnapshot(
        inputs({ settings: { [SETTING_KEYS.INHOUSE_NIGHT]: "{nope" } }),
        NOW,
      ),
    ).toMatchObject(quiet);
  });

  it("detects a decided playoff round and missing series-result recovery", () => {
    const playoff = computeAutomationGateSnapshot(
      inputs({
        seasons: [
          season({
            status: "PLAYOFFS",
            matches: [
              match({
                phase: "FINAL",
                bracketSlot: "R2M1",
                status: "COMPLETED",
                scheduledAt: null,
                completedAt: new Date(NOW - 1_000),
                winnerTeamId: "home",
              }),
            ],
          }),
        ],
      }),
      NOW,
    );
    expect(playoff).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "PLAYOFF_REPAIR",
    });

    const recovery = computeAutomationGateSnapshot(
      inputs({
        seasons: [
          season({
            status: "REGULAR_SEASON",
            matches: [
              match({
                status: "COMPLETED",
                completedAt: new Date(NOW - 1_000),
                scheduledAt: null,
                winnerTeamId: "home",
              }),
            ],
          }),
        ],
        leagueWebhookConfigured: true,
        settings: {
          [honorsAnnouncedKey("season-1", 1)]: "sent:honors:v2:event:message",
        },
      }),
      NOW,
    );
    expect(recovery).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "ANNOUNCEMENT_RETRY",
    });
  });

  it("repairs only missing ready knockout successors and sleeps once the new bracket is complete", () => {
    const key = `TBS:${"a".repeat(64)}:1:${"b".repeat(64)}:0.1.2.3:0`;
    const game = (stage: number, index: number, completed = true) => match({
      id: `${stage}-${index}`, phase: "TIEBREAKER", week: 8,
      bracketSlot: `${key}:${stage}:${index}`, scheduledAt: null,
      status: completed ? "COMPLETED" : "SCHEDULED", winnerTeamId: completed ? "home" : null,
    });
    const check = (matches: AutomationGateMatch[], status = "REGULAR_SEASON") =>
      computeAutomationGateSnapshot(inputs({ seasons: [season({ status, matches })] }), NOW);
    expect(check([game(1, 0), game(1, 1, false)]).reason).toBeNull();
    expect(check([game(1, 0), game(1, 1)])).toMatchObject({ nextWakeAtMs: NOW, reason: "TIEBREAKER_REPAIR" });
    expect(check([game(1, 0), game(1, 1), game(2, 0)]).reason).toBeNull();
    expect(check([game(1, 0), game(1, 1)], "PLAYOFFS").reason).toBeNull();
  });

  it("wakes for a missing same-week BO1 stage even without remaining scheduled matches or Discord", () => {
    const slot = (stage: number) => `TBD:${"a".repeat(64)}:1:${"b".repeat(64)}:${stage}:0`;
    const fixtures = [1, 2, 3].map((stage) => match({
      id: `tb-${stage}`, phase: "TIEBREAKER", week: 8,
      bracketSlot: slot(stage), scheduledAt: null,
      status: "COMPLETED", winnerTeamId: "home",
    }));
    const snapshot = (matches: AutomationGateMatch[], status = "REGULAR_SEASON") =>
      computeAutomationGateSnapshot(inputs({ seasons: [season({ status, matches })] }), NOW);

    expect(snapshot(fixtures)).toMatchObject({ nextWakeAtMs: NOW, reason: "TIEBREAKER_REPAIR" });
    const game4 = match({
      id: "tb-4", phase: "TIEBREAKER", week: 8, bracketSlot: slot(4), scheduledAt: null,
      status: "COMPLETED", winnerTeamId: "home",
    });
    // An undefeated game-4 winner ends the bracket, so recovery stays idle.
    expect(snapshot([...fixtures, game4]).reason).toBeNull();
    // The other finalist winning needs exactly one reset, including after a
    // process crash between saving that win and creating its fixture.
    expect(snapshot([...fixtures, { ...game4, winnerTeamId: "away" }]))
      .toMatchObject({ nextWakeAtMs: NOW, reason: "TIEBREAKER_REPAIR" });
    const game5 = { ...game4, id: "tb-5", bracketSlot: slot(5) };
    expect(snapshot([...fixtures, { ...game4, winnerTeamId: "away" }, game5]).reason).toBeNull();
    expect(snapshot(fixtures, "PLAYOFFS").reason).toBeNull();
    expect(snapshot([{ ...fixtures[0], bracketSlot: "TB:legacy:1" }]).reason).toBeNull();
    expect(snapshot([{ ...fixtures[0], status: "SCHEDULED", winnerTeamId: null }]).reason).toBeNull();
  });

  it("stops missing-honors recovery after one hour without parking real retries", () => {
    const completed = match({
      status: "COMPLETED",
      scheduledAt: null,
      winnerTeamId: "home",
    });
    const sentResult = {
      [resultAnnouncedKey(completed.id)]: "sent:v2:event:message",
    };
    const snapshot = (completedAt: number, honorsMarker?: string) =>
      computeAutomationGateSnapshot(
        inputs({
          seasons: [
            season({
              status: "REGULAR_SEASON",
              matches: [{ ...completed, completedAt: new Date(completedAt) }],
            }),
          ],
          leagueWebhookConfigured: true,
          settings: {
            ...sentResult,
            ...(honorsMarker === undefined
              ? {}
              : { [honorsAnnouncedKey("season-1", 1)]: honorsMarker }),
          },
        }),
        NOW,
      );
    const windowMs = AUTOMATION_GATE_HARD_HORIZON_MS;

    expect(windowMs).toBe(60 * 60_000);
    expect(snapshot(NOW - windowMs)).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "ANNOUNCEMENT_RETRY",
    });
    const expired = snapshot(NOW - windowMs - 1);
    expect(expired).toMatchObject({
      nextWakeAtMs: Number.MAX_SAFE_INTEGER,
      hardWakeAtMs: NOW + windowMs,
      reason: null,
    });
    expect(
      automationGateDecisionFromSnapshot(expired, NOW + windowMs - 1),
    ).toEqual({ run: false, snapshot: expired });
    expect(
      automationGateDecisionFromSnapshot(expired, NOW + windowMs),
    ).toMatchObject({ run: true, snapshot: expired });
    expect(
      snapshot(
        NOW - windowMs - 1,
        `failed:honors:initial:v2:11111111-1111-4111-8111-111111111111:${NOW - 1}`,
      ),
    ).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "ANNOUNCEMENT_RETRY",
    });
    expect(
      snapshot(NOW - windowMs - 1, "stale:changed-box-score"),
    ).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "ANNOUNCEMENT_RETRY",
    });
    expect(
      snapshot(
        NOW - windowMs - 1,
        "claim:honors:v2:1:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:initial",
      ),
    ).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "ANNOUNCEMENT_RETRY",
    });
  });

  it("uses the newest completion in a week for missing-honors recovery", () => {
    const old = match({
      id: "match-old",
      status: "COMPLETED",
      scheduledAt: null,
      completedAt: new Date(NOW - 2 * AUTOMATION_GATE_HARD_HORIZON_MS),
      winnerTeamId: "home",
    });
    const recent = match({
      id: "match-recent",
      status: "COMPLETED",
      scheduledAt: null,
      completedAt: new Date(NOW - AUTOMATION_GATE_HARD_HORIZON_MS + 1),
      winnerTeamId: "away",
    });
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        seasons: [
          season({
            status: "REGULAR_SEASON",
            matches: [old, recent],
          }),
        ],
        leagueWebhookConfigured: true,
        settings: {
          [resultAnnouncedKey(old.id)]: "sent:v2:old:message",
          [resultAnnouncedKey(recent.id)]: "sent:v2:recent:message",
        },
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "ANNOUNCEMENT_RETRY",
    });
  });

  it("ignores missing honors for untouched historical completions", () => {
    const completed = match({
      status: "COMPLETED",
      scheduledAt: null,
      completedAt: null,
      winnerTeamId: "home",
    });
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        seasons: [season({ status: "REGULAR_SEASON", matches: [completed] })],
        leagueWebhookConfigured: true,
        settings: {
          [resultAnnouncedKey(completed.id)]: "sent:v2:event:message",
        },
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: Number.MAX_SAFE_INTEGER,
      reason: null,
    });
  });

  it("recognises claims minted by announcement-marker and honors-service", () => {
    // The markers are minted by the real writers, never hand-typed here: if a
    // writer's claim format drifts from what the gate parses, the gate would
    // treat a stuck claim as finished (or as legacy) and its announcement
    // would never be retried, with no error anywhere.
    const eventId = "11111111-1111-4111-8111-111111111111";
    const completed = match({
      status: "COMPLETED",
      scheduledAt: null,
      completedAt: new Date(NOW - 1_000),
      winnerTeamId: "home",
    });
    const snapshot = (resultMarker: string, honorsMarker: string) =>
      computeAutomationGateSnapshot(
        inputs({
          seasons: [season({ status: "REGULAR_SEASON", matches: [completed] })],
          leagueWebhookConfigured: true,
          settings: {
            [resultAnnouncedKey(completed.id)]: resultMarker,
            [honorsAnnouncedKey("season-1", 1)]: honorsMarker,
          },
        }),
        NOW,
      );
    const resultSent = `sent:v2:${eventId}:${NOW}`;
    const honorsSent = `sent:honors:v2:${eventId}:digest`;
    expect(snapshot(resultSent, honorsSent)).toMatchObject({
      nextWakeAtMs: Number.MAX_SAFE_INTEGER,
      reason: null,
    });

    // A live lease is waited out: the gate wakes when it expires, not now
    // (an unrecognised honors claim reads as legacy and is due at once; an
    // unrecognised generic claim is rejected as malformed).
    for (const live of [
      snapshot(announcementClaimValue(NOW, eventId), honorsSent),
      snapshot(resultSent, honorsClaimValue(NOW, eventId, "initial")),
      snapshot(resultSent, honorsClaimValue(NOW, eventId, "corrected")),
    ]) {
      expect(live.reason).toBe("ANNOUNCEMENT_RETRY");
      expect(live.nextWakeAtMs).toBeGreaterThan(NOW);
      expect(live.nextWakeAtMs).toBeLessThanOrEqual(NOW + 5 * 60_000);
    }

    // Once the lease has expired the same claims are due immediately.
    const longAgo = NOW - 60 * 60_000;
    for (const expired of [
      snapshot(announcementClaimValue(longAgo, eventId), honorsSent),
      snapshot(resultSent, honorsClaimValue(longAgo, eventId, "initial")),
    ]) {
      expect(expired).toMatchObject({
        nextWakeAtMs: NOW,
        reason: "ANNOUNCEMENT_RETRY",
      });
    }
  });

  it("does not hide recoverable result markers outside the active season", () => {
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        globalAnnouncementMarkers: [
          {
            key: "resultAnnounced:deleted-match",
            value:
              "failed:v2:11111111-1111-4111-8111-111111111111:1786910400000",
          },
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "ANNOUNCEMENT_RETRY",
    });
  });

  it("wakes for a failed playoff-round post, behind the retry throttle and only when Discord can take it", () => {
    const marker = {
      key: "playoffRoundAnnounced:season-1:2",
      value: "failed:v2:11111111-1111-4111-8111-111111111111:1786910400000",
    };
    expect(
      computeAutomationGateSnapshot(
        inputs({ globalAnnouncementMarkers: [marker] }),
        NOW,
      ),
    ).toMatchObject({ nextWakeAtMs: Number.MAX_SAFE_INTEGER, reason: null });

    const delivery = { leagueWebhookConfigured: true, leagueDeliveryAvailable: true };
    expect(
      computeAutomationGateSnapshot(
        inputs({ ...delivery, globalAnnouncementMarkers: [marker] }),
        NOW,
      ),
    ).toMatchObject({ nextWakeAtMs: NOW, reason: "ANNOUNCEMENT_RETRY" });

    // The worker retries it inside the throttled announcement sweep.
    const throttled = computeAutomationGateSnapshot(
      inputs({
        ...delivery,
        globalAnnouncementMarkers: [marker],
        settings: {
          [SETTING_KEYS.ANNOUNCE_RETRY_AT]: new Date(NOW - 60_000).toISOString(),
        },
      }),
      NOW,
    );
    expect(throttled).toMatchObject({
      nextWakeAtMs:
        NOW - 60_000 + AUTO_SYNC.LEAGUE_INTERVAL_SECONDS * 1_000 + 1,
      reason: "ANNOUNCEMENT_RETRY",
    });

    // A crashed worker's claim is retried once its lease runs out.
    const claimed = computeAutomationGateSnapshot(
      inputs({
        ...delivery,
        globalAnnouncementMarkers: [
          {
            key: marker.key,
            value: announcementClaimValue(NOW, "11111111-1111-4111-8111-111111111111"),
          },
        ],
      }),
      NOW,
    );
    expect(claimed.reason).toBe("ANNOUNCEMENT_RETRY");
    expect(claimed.nextWakeAtMs).toBeGreaterThan(NOW);
  });

  describe("the 'we couldn't find your games' nudge", () => {
    const HOUR = 3_600_000;
    // Kicked off 3.5h ago: the week reminder has closed, and the fixture's
    // automatic scans are backed off for hours, so nothing else wakes the
    // worker before the nudge falls due at kickoff + 4h.
    const kickoff = NOW - 3.5 * HOUR;
    const dueAt = kickoff + RESULT_NUDGE.HOURS_AFTER_KICKOFF * HOUR;
    const fixture = (overrides: Partial<AutomationGateMatch> = {}) =>
      match({
        scheduledAt: new Date(kickoff),
        autoSyncedAt: new Date(NOW - 60_000),
        autoSyncAttempts: AUTO_SYNC.BACKOFF_DOUBLINGS,
        ...overrides,
      });
    const snapshot = (
      m: AutomationGateMatch,
      options: {
        status?: string;
        settings?: Record<string, string>;
        delivery?: boolean;
        now?: number;
      } = {},
    ) =>
      computeAutomationGateSnapshot(
        inputs({
          seasons: [
            season({ status: options.status ?? "REGULAR_SEASON", matches: [m] }),
          ],
          settings: options.settings ?? {},
          leagueWebhookConfigured: options.delivery ?? true,
          leagueDeliveryAvailable: options.delivery ?? true,
        }),
        options.now ?? NOW,
      );

    it("sleeps until a fixture with no games falls due", () => {
      expect(snapshot(fixture())).toMatchObject({
        nextWakeAtMs: dueAt,
        reason: "REMINDER",
      });
      // Otherwise the worker would next look hours later.
      const quiet = snapshot(fixture(), { delivery: false });
      expect(quiet.reason).toBe("LEAGUE");
      expect(quiet.nextWakeAtMs).toBeGreaterThan(dueAt + HOUR);
    });

    it("sleeps until a part-played series has stalled", () => {
      const lastEnded = kickoff + 2 * HOUR;
      const live = fixture({
        status: "LIVE",
        games: [
          {
            startTime: Math.floor((lastEnded - 40 * 60_000) / 1000),
            durationSecs: 40 * 60,
            fetchedAt: new Date(lastEnded + 60_000),
          },
        ],
      });
      expect(snapshot(live)).toMatchObject({
        nextWakeAtMs: lastEnded + RESULT_NUDGE.HOURS_SINCE_LAST_GAME * HOUR,
        reason: "REMINDER",
      });
    });

    it("follows the fixture's marker for its current kickoff", () => {
      const key = resultNudgeKey("match-1", 2);
      const moved = fixture({ scheduleRevision: 2 });
      expect(
        snapshot(moved, { settings: { [key]: "sent:v2:event:message" } }).reason,
      ).toBe("LEAGUE");
      // A marker from an earlier kickoff says nothing about this one.
      expect(
        snapshot(moved, {
          settings: { [resultNudgeKey("match-1", 1)]: "sent:v2:event:message" },
        }),
      ).toMatchObject({ nextWakeAtMs: dueAt, reason: "REMINDER" });
      // A post that could not be queued is retried on the next pass.
      expect(
        snapshot(moved, {
          now: dueAt + HOUR,
          settings: {
            [key]: "failed:v2:11111111-1111-4111-8111-111111111111:1",
          },
        }),
      ).toMatchObject({ nextWakeAtMs: dueAt + HOUR, reason: "REMINDER" });
    });

    it("never wakes for a nudge the worker would refuse", () => {
      const notReminder = (s: ReturnType<typeof snapshot>) =>
        expect(s.reason).not.toBe("REMINDER");
      notReminder(snapshot(fixture({ status: "COMPLETED", winnerTeamId: "home" })));
      notReminder(snapshot(fixture({ scheduledAt: null })));
      // A regular week left open once the playoffs start is not theirs.
      notReminder(snapshot(fixture(), { status: "PLAYOFFS" }));
      // Past the automatic import's window it is an admin matter.
      notReminder(
        snapshot(fixture(), {
          now: kickoff + AUTO_SYNC.WINDOW_HOURS * HOUR + 1,
        }),
      );
    });
  });

  it("parks champion retries until Discord delivery is available", () => {
    const marker = {
      key: "championAnnounced:archived-season",
      value: "failed:v2:11111111-1111-4111-8111-111111111111:1786910400000",
    };
    const blocked = computeAutomationGateSnapshot(
      inputs({ globalAnnouncementMarkers: [marker] }),
      NOW,
    );
    expect(blocked).toMatchObject({
      nextWakeAtMs: Number.MAX_SAFE_INTEGER,
      reason: null,
    });

    const available = computeAutomationGateSnapshot(
      inputs({
        globalAnnouncementMarkers: [marker],
        leagueWebhookConfigured: true,
        leagueDeliveryAvailable: true,
      }),
      NOW,
    );
    expect(available).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "ANNOUNCEMENT_RETRY",
    });
  });

  it("runs only when the fresh board digest says synchronization is needed", () => {
    const settings = {
      [SETTING_KEYS.INHOUSE_BOARD]: JSON.stringify({
        webhookId: "12345",
        messageId: "67890",
        digest: "current-digest",
        lastOkAt: new Date(NOW - 60_000).toISOString(),
        failures: 0,
      }),
    };
    const snapshot = computeAutomationGateSnapshot(
      inputs({
        settings,
        boardNeedsSync: true,
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({ nextWakeAtMs: NOW, reason: "BOARD" });
    expect(
      computeAutomationGateSnapshot(
        inputs({ settings, boardNeedsSync: false }),
        NOW,
      ),
    ).toMatchObject({
      nextWakeAtMs: Number.MAX_SAFE_INTEGER,
      reason: null,
    });
  });

  it("rejects contradictory and malformed state", () => {
    expect(() =>
      computeAutomationGateSnapshot(
        inputs({ seasons: [season({ id: "one" }), season({ id: "two" })] }),
        NOW,
      ),
    ).toThrow(/multiple active seasons/);
    expect(() =>
      computeAutomationGateSnapshot(
        inputs({
          runner: {
            lastStatus: "RUNNING",
            leaseExpiresAt: new Date("invalid"),
            lastFinishedAt: new Date(NOW - 60_000),
            consecutiveFailures: 0,
            lastSummary: "{}",
          },
        }),
        NOW,
      ),
    ).toThrow(/valid timestamp/);
    const duplicate = {
      lobbyId: "lobby-1",
      sequence: 1,
      status: "PENDING",
      availableAt: new Date(NOW + 60_000),
      claimedAt: null,
      createdAt: new Date(NOW),
    };
    expect(() =>
      computeAutomationGateSnapshot(
        inputs({
          inhouseOutboxes: [
            { ...duplicate, id: "one" },
            { ...duplicate, id: "two" },
          ],
        }),
        NOW,
      ),
    ).toThrow(/duplicate inhouse outbox sequence/);
  });
});

describe("cached decision boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boardNeedsSyncMock.mockResolvedValue(false);
    databaseNowMock.mockResolvedValue(new Date(NOW));
    cacheMocks.cached.mockImplementation(async () => cacheMocks.source!());
  });

  it("uses one stable key/tag without a reader-renewable TTL", () => {
    expect(cacheMocks.registration).toEqual({
      keyParts: [AUTOMATION_GATE_CACHE_KEY],
      options: {
        tags: [AUTOMATION_GATE_TAG],
        revalidate: false,
      },
    });
  });

  it("calls the cached loader with no tick argument", async () => {
    const snapshot = computeAutomationGateSnapshot(inputs(), NOW);
    cacheMocks.cached.mockResolvedValueOnce(snapshot);

    await expect(getAutomationGateDecision(NOW + 1)).resolves.toMatchObject({
      run: false,
    });
    expect(cacheMocks.cached).toHaveBeenCalledWith();
  });

  it("runs when a deadline passes while a cache miss is loading", async () => {
    const snapshot = {
      ...computeAutomationGateSnapshot(inputs(), NOW),
      nextWakeAtMs: NOW + 5,
      reason: "DRAFT" as const,
    };
    cacheMocks.cached.mockResolvedValueOnce(snapshot);
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW + 10);

    try {
      await expect(getAutomationGateDecision(NOW)).resolves.toMatchObject({
        run: true,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("accepts normal cache-fill ordering but fails open for a future clock", () => {
    const snapshot = computeAutomationGateSnapshot(inputs(), NOW);

    expect(
      automationGateDecisionFromSnapshot(snapshot, NOW - 1),
    ).toMatchObject({ run: false, snapshot });
    expect(
      automationGateDecisionFromSnapshot(snapshot, NOW - 60_001),
    ).toEqual({ run: true });
  });

  it("serves later idle ticks without another Prisma read", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    prismaMocks.automationRunState.findUnique.mockResolvedValue({
      lastStatus: "SUCCEEDED",
      leaseExpiresAt: null,
      lastFinishedAt: new Date(NOW),
      consecutiveFailures: 0,
      lastSummary: "{}",
    });
    prismaMocks.season.findMany.mockResolvedValue([]);
    prismaMocks.setting.findMany.mockResolvedValue([]);
    prismaMocks.inhouseLobby.findMany.mockResolvedValue([]);
    prismaMocks.inhouseLobby.findFirst.mockResolvedValue(null);
    prismaMocks.inhouseQueueEntry.findMany.mockResolvedValue([]);
    prismaMocks.leagueAnnouncement.findMany.mockResolvedValue([]);
    prismaMocks.inhouseAnnouncement.findMany.mockResolvedValue([]);
    let stored: unknown;
    cacheMocks.cached.mockImplementation(async () => {
      stored ??= await cacheMocks.source!();
      return stored;
    });

    try {
      await expect(getAutomationGateDecision(NOW)).resolves.toMatchObject({
        run: false,
      });
      const readsAfterFill = Object.values(prismaMocks).reduce(
        (sum, model) =>
          sum +
          Object.values(model).reduce(
            (modelSum, read) => modelSum + read.mock.calls.length,
            0,
          ),
        0,
      );

      await expect(
        getAutomationGateDecision(NOW + 60_000),
      ).resolves.toMatchObject({ run: false });
      const readsAfterHit = Object.values(prismaMocks).reduce(
        (sum, model) =>
          sum +
          Object.values(model).reduce(
            (modelSum, read) => modelSum + read.mock.calls.length,
            0,
          ),
        0,
      );

      expect(readsAfterFill).toBeGreaterThan(0);
      expect(readsAfterHit).toBe(readsAfterFill);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("fails open for cache errors and malformed cached snapshots", async () => {
    cacheMocks.cached.mockRejectedValueOnce(new Error("cache unavailable"));
    await expect(getAutomationGateDecision(NOW)).resolves.toEqual({ run: true });

    cacheMocks.cached.mockResolvedValueOnce({
      version: 12,
      computedAtMs: NOW,
      nextWakeAtMs: NOW + 1,
      hardWakeAtMs: NOW + AUTOMATION_GATE_HARD_HORIZON_MS + 1,
      reason: "LEAGUE",
      runnerHealthy: true,
    });
    await expect(getAutomationGateDecision(NOW)).resolves.toEqual({ run: true });
  });

  it("rejects a cached snapshot from the previous queue-timeout policy", async () => {
    cacheMocks.cached.mockResolvedValueOnce({
      ...computeAutomationGateSnapshot(inputs(), NOW),
      version: 5,
    });

    await expect(getAutomationGateDecision(NOW)).resolves.toEqual({ run: true });
  });

  it("uses the request-context invalidation primitives", () => {
    invalidateAutomationGateBestEffort();
    expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(AUTOMATION_GATE_TAG, {
      expire: 0,
    });
    cacheMocks.revalidateTag.mockImplementationOnce(() => {
      throw new Error("outside request context");
    });
    expect(() => invalidateAutomationGateBestEffort()).not.toThrow();
  });
});

describe("loadAutomationGateSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boardNeedsSyncMock.mockResolvedValue(false);
    databaseNowMock.mockResolvedValue(new Date(NOW));
    prismaMocks.automationRunState.findUnique.mockResolvedValue({
      lastStatus: "SUCCEEDED",
      leaseExpiresAt: null,
      lastFinishedAt: new Date(NOW),
      consecutiveFailures: 0,
      lastSummary: "{}",
    });
  });

  it("fails open before secondary reads when multiple seasons are active", async () => {
    prismaMocks.season.findMany.mockResolvedValue([
      season({ id: "one" }),
      season({ id: "two" }),
    ]);

    await expect(loadAutomationGateSnapshot(NOW)).rejects.toThrow(
      /multiple active seasons/,
    );
    expect(prismaMocks.setting.findMany).not.toHaveBeenCalled();
  });

  describe("games marked over", () => {
    type LobbyQuery = { where?: { status?: unknown } };
    function quietSite(awaiting: unknown[]) {
      prismaMocks.season.findMany.mockResolvedValue([]);
      prismaMocks.setting.findMany.mockResolvedValue([]);
      prismaMocks.setting.findUnique.mockResolvedValue(null);
      prismaMocks.inhouseLobby.findFirst.mockResolvedValue(null);
      prismaMocks.inhouseQueueEntry.findMany.mockResolvedValue([]);
      prismaMocks.leagueAnnouncement.findMany.mockResolvedValue([]);
      prismaMocks.inhouseAnnouncement.findMany.mockResolvedValue([]);
      // The live-slot query and the marked-over query are both findMany on
      // inhouseLobby: answer each by its own status filter.
      prismaMocks.inhouseLobby.findMany.mockImplementation(
        async (args: LobbyQuery) =>
          args?.where?.status === INHOUSE_STATUS.AWAITING_RESULT
            ? awaiting
            : [],
      );
    }
    // A cache fill computes on the wall clock, so pin it to the test's NOW.
    async function decisionThroughTheCache() {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
      try {
        cacheMocks.cached.mockImplementationOnce(async () =>
          cacheMocks.source!(),
        );
        return await getAutomationGateDecision(NOW);
      } finally {
        nowSpy.mockRestore();
      }
    }
    const finishedAt = NOW - 2 * 60_000;
    const scannedAt = NOW - 30_000;
    const row = {
      createdAt: new Date(NOW - 50 * 60_000),
      startedAt: new Date(NOW - 44 * 60_000),
      finishedAt: new Date(finishedAt),
      detectedAt: new Date(scannedAt),
    };

    it("reads them apart from the live games and wakes for their scan", async () => {
      quietSite([row]);
      await expect(loadAutomationGateSnapshot(NOW)).resolves.toMatchObject({
        nextWakeAtMs:
          scannedAt + detectIntervalSeconds(NOW - finishedAt) * 1_000 + 1,
        reason: "INHOUSE",
      });
      expect(prismaMocks.inhouseLobby.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: INHOUSE_STATUS.AWAITING_RESULT },
          select: expect.objectContaining({ finishedAt: true, detectedAt: true }),
        }),
      );
      // So the gate sleeps until then (the contrast for the fail-open below).
      expect(await decisionThroughTheCache()).toMatchObject({ run: false });
    });

    it("fails the worker open on one without a finish time", async () => {
      quietSite([{ ...row, finishedAt: null }]);
      await expect(loadAutomationGateSnapshot(NOW)).rejects.toThrow(
        /lobby marked over has no finish time/,
      );
      expect(await decisionThroughTheCache()).toEqual({ run: true });
    });
  });
});
