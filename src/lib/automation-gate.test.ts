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
  setting: { findMany: vi.fn() },
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
import { AUTO_SYNC, INHOUSE, WEEK_REMINDER } from "./constants";
import {
  honorsAnnouncedKey,
  resultAnnouncedKey,
  SETTING_KEYS,
  weekReminderKey,
} from "./settings";

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
    queue: [],
    unsettledBet: false,
    repairableInhouseResult: false,
    leagueOutbox: [],
    inhouseOutboxes: [],
    outboxClock: { databaseNowMs: NOW, appNowMs: NOW },
    globalAnnouncementMarkers: [],
    boardNeedsSync: false,
    ...overrides,
  };
}

describe("computeAutomationGateSnapshot", () => {
  it("uses an immutable one-hour hard horizon for quiet state", () => {
    const snapshot = computeAutomationGateSnapshot(inputs(), NOW);

    expect(AUTOMATION_GATE_HARD_HORIZON_MS).toBe(60 * 60_000);
    expect(snapshot).toEqual({
      version: 4,
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
      version: 4,
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
            updatedAt: new Date(NOW),
            betsCloseAt: null,
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
              updatedAt: new Date(NOW),
              betsCloseAt: null,
            },
          ],
        }),
        NOW,
      ),
    ).toMatchObject({ nextWakeAtMs: NOW, reason: "INHOUSE" });
  });

  it("keeps an in-progress betting close ahead of result detection", () => {
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
            updatedAt: new Date(NOW),
            betsCloseAt: new Date(NOW + 45_000),
          },
        ],
      }),
      NOW,
    );

    expect(snapshot).toMatchObject({
      nextWakeAtMs: NOW + 45_000,
      reason: "INHOUSE",
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
      version: 4,
      computedAtMs: NOW,
      nextWakeAtMs: NOW + 1,
      hardWakeAtMs: NOW + AUTOMATION_GATE_HARD_HORIZON_MS + 1,
      reason: "LEAGUE",
      runnerHealthy: true,
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
});
