import { unstable_cache } from "next/cache";
import {
  AUTO_SYNC,
  DRAFT_STATUS,
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_BET_STATUS,
  INHOUSE_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
  WEEK_REMINDER,
} from "./constants";
import { normalizeDiscordWebhookUrl } from "./discord-webhook.mjs";
import { discordMutationsAllowed } from "./discord-mutation-policy";
import { databaseNow } from "./database-time";
import { detectIntervalSeconds } from "./inhouse";
import { inhouseBoardNeedsSync } from "./inhouse-board-service";
import { prisma } from "./prisma";
import {
  autoSyncClosesAt,
  autoSyncIntervalSeconds,
  autoSyncOpensAt,
  leagueFallbackOpensAt,
  minutesSinceAutoSyncOpen,
} from "./result-sync";
import {
  ANNOUNCE_FAILED_PREFIX,
  CHAMPION_ANNOUNCED_PREFIX,
  championAnnouncedKey,
  honorsAnnouncedKey,
  honorsAnnouncedPrefix,
  RESULT_ANNOUNCED_PREFIX,
  resultAnnouncedKey,
  SETTING_KEYS,
  weekReminderKey,
  weekReminderPrefix,
} from "./settings";
import {
  AUTOMATION_GATE_CACHE_KEY,
  AUTOMATION_GATE_HARD_HORIZON_MS,
  AUTOMATION_GATE_TAG,
  AUTOMATION_GATE_VERSION,
} from "./automation-gate-constants";

export {
  AUTOMATION_GATE_CACHE_KEY,
  AUTOMATION_GATE_HARD_HORIZON_MS,
  AUTOMATION_GATE_TAG,
  AUTOMATION_GATE_VERSION,
} from "./automation-gate-constants";

const OUTBOX_CLAIM_LEASE_MS = 30_000;
const AUTOMATION_GATE_CLOCK_SKEW_MS = 60_000;
const ANNOUNCEMENT_CLAIM_PREFIX = "claim:v2:";
const HONORS_CLAIM_PREFIX = "claim:honors:";
const HONORS_STALE_PREFIX = "stale:";
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ANNOUNCEMENT_CLAIM_PATTERN = new RegExp(
  `^claim:v2:(\\d{1,16}):${UUID}:${UUID}$`,
  "i",
);
const HONORS_CLAIM_PATTERN = new RegExp(
  `^claim:honors:v2:(\\d{1,16}):${UUID}:${UUID}:(?:initial|corrected)$`,
  "i",
);
const PLAYOFF_SLOT_PATTERN = /^R(\d+)M(\d+)$/;

export const AUTOMATION_GATE_REASONS = [
  "RUNNER",
  "LEAGUE",
  "DRAFT",
  "INHOUSE",
  "LEAGUE_OUTBOX",
  "INHOUSE_OUTBOX",
  "REMINDER",
  "PLAYOFF_REPAIR",
  "ANNOUNCEMENT_RETRY",
  "BOARD",
] as const;

export type AutomationGateReason =
  (typeof AUTOMATION_GATE_REASONS)[number];

/**
 * Safe cache payload: no ids, settings, statuses, webhook material, or other
 * domain data can survive beyond this preflight request.
 */
export type AutomationGateSnapshot = {
  version: typeof AUTOMATION_GATE_VERSION;
  computedAtMs: number;
  nextWakeAtMs: number;
  hardWakeAtMs: number;
  reason: AutomationGateReason | null;
  /** Generic runner health only; safe for the public dead-man response. */
  runnerHealthy: boolean;
};

export type AutomationGateDecision =
  | { run: true; snapshot?: AutomationGateSnapshot }
  | { run: false; snapshot: AutomationGateSnapshot };

export type AutomationGateMatch = {
  id: string;
  week: number;
  phase: string;
  bracketSlot: string | null;
  status: string;
  scheduledAt: Date | null;
  autoSyncedAt: Date | null;
  autoSyncAttempts: number;
  completedAt: Date | null;
  winnerTeamId: string | null;
  homeTeamId: string;
  awayTeamId: string;
};

export type AutomationGateSeason = {
  id: string;
  status: string;
  dotaLeagueId: string | null;
  championTeamId: string | null;
  draft: {
    status: string;
    bidEndsAt: Date | null;
    nominationEndsAt: Date | null;
  } | null;
  matches: AutomationGateMatch[];
};

export type AutomationGateInputs = {
  runner: {
    lastStatus: string;
    leaseExpiresAt: Date | null;
    lastFinishedAt: Date | null;
    consecutiveFailures: number;
    lastSummary: string;
  } | null;
  /** The loader takes two rows so corruption can fail open, not pick a winner. */
  seasons: AutomationGateSeason[];
  settings: Readonly<Record<string, string>>;
  leagueWebhookConfigured: boolean;
  leagueDeliveryAvailable: boolean;
  activeLobbies: Array<{
    status: string;
    acceptEndsAt: Date | null;
    voteEndsAt: Date | null;
    pickEndsAt: Date | null;
    startedAt: Date | null;
    detectedAt: Date | null;
    updatedAt: Date;
    betsCloseAt: Date | null;
  }>;
  queue: Array<{
    joinedAt: Date;
    lastSeenAt: Date;
    idleExpiresAt: Date | null;
  }>;
  unsettledBet: boolean;
  repairableInhouseResult: boolean;
  leagueOutbox: Array<{
    id: string;
    status: string;
    availableAt: Date;
    claimedAt: Date | null;
    createdAt: Date;
  }>;
  inhouseOutboxes: Array<{
    id: string;
    lobbyId: string;
    sequence: number;
    status: string;
    availableAt: Date;
    claimedAt: Date | null;
    createdAt: Date;
  }>;
  /**
   * App/database clock pair sampled together when database-defaulted outbox
   * timestamps are present. Other deadlines are application-owned.
   */
  outboxClock: { databaseNowMs: number; appNowMs: number };
  /** Recoverable result/champion markers are global, including orphan rows. */
  globalAnnouncementMarkers: Array<{ key: string; value: string }>;
  /** Result of a fresh canonical board digest probe on cache fills. */
  boardNeedsSync: boolean;
};

type Candidate = { at: number; reason: AutomationGateReason };

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid automation gate state: ${message}`);
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function dateMs(value: Date, label: string): number {
  invariant(value instanceof Date, `${label} is not a Date`);
  const result = value.getTime();
  invariant(validTimestamp(result), `${label} is not a valid timestamp`);
  return result;
}

function optionalDateMs(value: Date | null, label: string): number | null {
  return value === null ? null : dateMs(value, label);
}

function settingTimestamp(
  settings: Readonly<Record<string, string>>,
  key: string,
): number | null {
  const raw = settings[key];
  if (raw === undefined || raw === "") return null;
  const parsed = Date.parse(raw);
  invariant(validTimestamp(parsed), `${key} is not a timestamp`);
  return parsed;
}

function nextThrottleAt(
  settings: Readonly<Record<string, string>>,
  key: string,
  intervalMs: number,
): number {
  const stampedAt = settingTimestamp(settings, key);
  return stampedAt === null ? 0 : stampedAt + intervalMs + 1;
}

function nextMatchScanAt(
  scheduledAt: number,
  autoSyncedAt: number,
  attempts: number,
  nowMs: number,
): number {
  const graceEndsAt =
    autoSyncOpensAt(scheduledAt) + AUTO_SYNC.BACKOFF_GRACE_MINUTES * 60_000;
  if (nowMs < graceEndsAt) {
    const youngAt =
      autoSyncedAt + autoSyncIntervalSeconds(attempts, 0) * 1_000 + 1;
    // At graceEndsAt the service switches to its full backoff. If the young
    // deadline has not become strictly claimable before that discontinuity,
    // sleeping to it would wake the worker only to discover a longer delay.
    if (youngAt < graceEndsAt) return youngAt;
  }
  return (
    autoSyncedAt +
    autoSyncIntervalSeconds(
      attempts,
      minutesSinceAutoSyncOpen(scheduledAt, Math.max(nowMs, graceEndsAt)),
    ) *
      1_000 +
    1
  );
}

function addCandidate(
  candidates: Candidate[],
  nowMs: number,
  at: number,
  reason: AutomationGateReason,
): void {
  invariant(validTimestamp(at), `${reason} deadline is invalid`);
  candidates.push({ at: Math.max(nowMs, at), reason });
}

function genericMarkerWakeAt(value: string | undefined, nowMs: number) {
  if (value === undefined || value.startsWith(ANNOUNCE_FAILED_PREFIX)) {
    return nowMs;
  }
  const claim = ANNOUNCEMENT_CLAIM_PATTERN.exec(value);
  if (claim) {
    const expiresAt = Number(claim[1]);
    invariant(validTimestamp(expiresAt), "announcement claim expiry is invalid");
    return Math.max(nowMs, expiresAt);
  }
  invariant(
    !value.startsWith(ANNOUNCEMENT_CLAIM_PREFIX),
    "announcement claim is malformed",
  );
  return null;
}

function honorsMarkerWakeAt(value: string | undefined, nowMs: number) {
  if (value === undefined) return nowMs;
  if (
    value.startsWith(HONORS_STALE_PREFIX) ||
    value.startsWith(`${ANNOUNCE_FAILED_PREFIX}honors:`)
  ) {
    return nowMs;
  }
  const claim = HONORS_CLAIM_PATTERN.exec(value);
  if (claim) {
    const expiresAt = Number(claim[1]);
    invariant(validTimestamp(expiresAt), "honors claim expiry is invalid");
    return Math.max(nowMs, expiresAt);
  }
  // Legacy honors claims are explicitly recoverable by honors-service.
  if (value.startsWith(HONORS_CLAIM_PREFIX)) return nowMs;
  return null;
}

function outboxWakeAt(
  row: { status: string; availableAt: Date; claimedAt: Date | null },
  label: string,
  nowMs: number,
  outboxClock: AutomationGateInputs["outboxClock"],
): number {
  invariant(
    validTimestamp(outboxClock.databaseNowMs) &&
      validTimestamp(outboxClock.appNowMs),
    "outbox clock is invalid",
  );
  const appDeadline = (databaseDeadlineMs: number) => {
    const translated =
      outboxClock.appNowMs +
      (databaseDeadlineMs - outboxClock.databaseNowMs);
    invariant(validTimestamp(translated), `${label} translated deadline is invalid`);
    return Math.max(nowMs, translated);
  };
  if (row.status === "PENDING") {
    return appDeadline(dateMs(row.availableAt, `${label}.availableAt`));
  }
  invariant(row.status === "SENDING", `${label}.status is unknown`);
  const claimedAt = optionalDateMs(row.claimedAt, `${label}.claimedAt`);
  invariant(claimedAt !== null, `${label} SENDING row has no claim`);
  return appDeadline(claimedAt + OUTBOX_CLAIM_LEASE_MS + 1);
}

function latestPlayoffRound(matches: AutomationGateMatch[]) {
  const playoff = matches.filter(
    (match) =>
      match.phase === MATCH_PHASE.PLAYOFF || match.phase === MATCH_PHASE.FINAL,
  );
  if (playoff.length === 0) return [];
  const roundOf = (slot: string | null) => {
    if (!slot) return 0;
    const match = PLAYOFF_SLOT_PATTERN.exec(slot);
    return match ? Number(match[1]) : 0;
  };
  const maxRound = Math.max(...playoff.map((match) => roundOf(match.bracketSlot)));
  return playoff.filter((match) => roundOf(match.bracketSlot) === maxRound);
}

function boardWakeAt(
  settings: Readonly<Record<string, string>>,
  nowMs: number,
  needsSync: boolean,
): number | null {
  const raw = settings[SETTING_KEYS.INHOUSE_BOARD];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return nowMs;
  }
  if (!parsed || typeof parsed !== "object") return nowMs;
  const state = parsed as Record<string, unknown>;
  if (state.messageId === "") {
    // Posting reservations are intentionally admin-recovered, not retried by
    // automation. A malformed reservation remains ambiguous and fails open.
    if (state.reservedAt === null) return null;
    if (typeof state.reservedAt !== "string") return nowMs;
    const reservedAt = Date.parse(state.reservedAt);
    return validTimestamp(reservedAt) ? null : nowMs;
  }
  if (
    typeof state.webhookId !== "string" ||
    state.webhookId.length === 0 ||
    typeof state.messageId !== "string" ||
    state.messageId.length === 0 ||
    typeof state.digest !== "string"
  ) {
    return nowMs;
  }
  const failures = state.failures ?? 0;
  if (!Number.isSafeInteger(failures) || (failures as number) < 0) return nowMs;
  const lastOkAt =
    state.lastOkAt === undefined
      ? null
      : typeof state.lastOkAt === "string"
        ? Date.parse(state.lastOkAt)
        : NaN;
  if (lastOkAt !== null && !validTimestamp(lastOkAt)) return nowMs;
  if (lastOkAt !== null && lastOkAt > nowMs) return nowMs;
  if (!needsSync) return null;
  return Math.max(
    nowMs,
    nextThrottleAt(
      settings,
      SETTING_KEYS.INHOUSE_BOARD_AT,
      INHOUSE.BOARD_MIN_SECONDS * 1_000,
    ),
  );
}

function onlyBlockedLeagueDelivery(
  inputs: AutomationGateInputs,
): boolean {
  const runner = inputs.runner;
  if (
    runner?.lastStatus !== "DEGRADED" ||
    inputs.leagueDeliveryAvailable ||
    inputs.leagueOutbox.length === 0
  ) {
    return false;
  }
  try {
    const summary = JSON.parse(runner.lastSummary) as Record<string, unknown>;
    return (
      summary.issueCount === 1 &&
      summary.skippedCount === 0 &&
      Array.isArray(summary.issues) &&
      summary.issues.length === 1 &&
      summary.issues[0] === "LEAGUE_NOTIFICATION_DELIVERY_FAILED" &&
      Array.isArray(summary.skipped) &&
      summary.skipped.length === 0
    );
  } catch {
    return false;
  }
}

/**
 * Pure deadline calculation. It throws on corrupt or contradictory input so
 * the public decision boundary can fail open and run the ordinary worker.
 */
export function computeAutomationGateSnapshot(
  inputs: AutomationGateInputs,
  nowMs: number,
): AutomationGateSnapshot {
  invariant(
    validTimestamp(nowMs) &&
      nowMs <= Number.MAX_SAFE_INTEGER - AUTOMATION_GATE_HARD_HORIZON_MS,
    "now is invalid",
  );
  invariant(inputs.seasons.length <= 1, "multiple active seasons");
  invariant(inputs.activeLobbies.length <= 1, "multiple active lobbies");
  const candidates: Candidate[] = [];
  let hardWakeAtMs = nowMs + AUTOMATION_GATE_HARD_HORIZON_MS;
  let runnerHealthy = false;
  const blockedLeagueDelivery = onlyBlockedLeagueDelivery(inputs);

  if (!inputs.runner) {
    addCandidate(candidates, nowMs, nowMs, "RUNNER");
  } else {
    invariant(
      Number.isSafeInteger(inputs.runner.consecutiveFailures) &&
        inputs.runner.consecutiveFailures >= 0,
      "runner failure count is invalid",
    );
    if (inputs.runner.lastStatus === "RUNNING") {
      const lease = optionalDateMs(
        inputs.runner.leaseExpiresAt,
        "runner.leaseExpiresAt",
      );
      addCandidate(candidates, nowMs, lease === null ? nowMs : lease + 1, "RUNNER");
    } else if (blockedLeagueDelivery) {
      const finishedAt = optionalDateMs(
        inputs.runner.lastFinishedAt,
        "runner.lastFinishedAt",
      );
      if (finishedAt === null) {
        addCandidate(candidates, nowMs, nowMs, "RUNNER");
      } else {
        // This work cannot succeed until configuration changes. Preserve its
        // degraded public health signal, but do not keep Neon awake retrying an
        // unchanged missing transport every minute.
        hardWakeAtMs = Math.min(
          hardWakeAtMs,
          finishedAt + AUTOMATION_GATE_HARD_HORIZON_MS,
        );
      }
    } else if (
      inputs.runner.lastStatus === "NEVER" ||
      inputs.runner.lastStatus === "FAILED" ||
      inputs.runner.lastStatus === "DEGRADED" ||
      inputs.runner.consecutiveFailures > 0
    ) {
      addCandidate(candidates, nowMs, nowMs, "RUNNER");
    } else {
      invariant(inputs.runner.lastStatus === "SUCCEEDED", "runner status is unknown");
      const finishedAt = optionalDateMs(
        inputs.runner.lastFinishedAt,
        "runner.lastFinishedAt",
      );
      if (finishedAt === null) {
        addCandidate(candidates, nowMs, nowMs, "RUNNER");
      } else {
        runnerHealthy = true;
        // A cache miss caused by a mutation or health reader cannot buy a new
        // safety horizon. Only a persisted completed pass moves this boundary.
        hardWakeAtMs = Math.min(
          hardWakeAtMs,
          finishedAt + AUTOMATION_GATE_HARD_HORIZON_MS,
        );
      }
    }
  }

  const season = inputs.seasons[0] ?? null;
  if (season) {
    invariant(
      Object.values(SEASON_STATUS).includes(
        season.status as (typeof SEASON_STATUS)[keyof typeof SEASON_STATUS],
      ),
      "season status is unknown",
    );
    if (season.draft) {
      invariant(
        Object.values(DRAFT_STATUS).includes(
          season.draft.status as (typeof DRAFT_STATUS)[keyof typeof DRAFT_STATUS],
        ),
        "draft status is unknown",
      );
    }
    for (const match of season.matches) {
      invariant(
        Object.values(MATCH_STATUS).includes(
          match.status as (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS],
        ),
        "match status is unknown",
      );
      invariant(
        Object.values(MATCH_PHASE).includes(
          match.phase as (typeof MATCH_PHASE)[keyof typeof MATCH_PHASE],
        ),
        "match phase is unknown",
      );
      invariant(Number.isSafeInteger(match.week) && match.week >= 0, "match week is invalid");
      invariant(
        Number.isSafeInteger(match.autoSyncAttempts) && match.autoSyncAttempts >= 0,
        "match sync attempts are invalid",
      );
      if (match.scheduledAt) dateMs(match.scheduledAt, "match.scheduledAt");
      if (match.autoSyncedAt) dateMs(match.autoSyncedAt, "match.autoSyncedAt");
      if (match.completedAt) dateMs(match.completedAt, "match.completedAt");
    }
  }

  if (
    season &&
    (season.status === SEASON_STATUS.REGULAR_SEASON ||
      season.status === SEASON_STATUS.PLAYOFFS)
  ) {
    const leagueThrottle = nextThrottleAt(
      inputs.settings,
      SETTING_KEYS.LEAGUE_AUTO_SYNC_AT,
      AUTO_SYNC.LEAGUE_INTERVAL_SECONDS * 1_000,
    );
    const rosterThrottle = nextThrottleAt(
      inputs.settings,
      SETTING_KEYS.ROSTER_AUTO_SYNC_AT,
      AUTO_SYNC.SCAN_GAP_SECONDS * 1_000,
    );
    for (const match of season.matches) {
      if (match.status === MATCH_STATUS.COMPLETED || !match.scheduledAt) continue;
      const scheduledAt = dateMs(match.scheduledAt, "match.scheduledAt");
      const opensAt = autoSyncOpensAt(scheduledAt);
      const closesAt = autoSyncClosesAt(scheduledAt);
      if (nowMs > closesAt) continue;
      if (nowMs < opensAt) {
        addCandidate(candidates, nowMs, opensAt, "LEAGUE");
        continue;
      }

      if (season.dotaLeagueId?.trim()) {
        const leagueAt = Math.max(nowMs, leagueThrottle);
        if (leagueAt <= closesAt) {
          addCandidate(candidates, nowMs, leagueAt, "LEAGUE");
        }
      }

      const rosterOpensAt = !season.dotaLeagueId?.trim()
        ? opensAt
        : match.status === MATCH_STATUS.LIVE
          ? opensAt
          : leagueFallbackOpensAt(scheduledAt);
      if (rosterOpensAt > closesAt) continue;
      const syncedAt = optionalDateMs(match.autoSyncedAt, "match.autoSyncedAt");
      const matchThrottle =
        syncedAt === null
          ? 0
          : nextMatchScanAt(
              scheduledAt,
              syncedAt,
              match.autoSyncAttempts,
              nowMs,
            );
      const rosterAt = Math.max(rosterOpensAt, rosterThrottle, matchThrottle);
      if (rosterAt <= closesAt) {
        addCandidate(candidates, nowMs, rosterAt, "LEAGUE");
      }
    }
  }

  if (
    season?.status === SEASON_STATUS.DRAFT &&
    season.draft?.status === DRAFT_STATUS.IN_PROGRESS
  ) {
    const deadlines = [
      optionalDateMs(season.draft.bidEndsAt, "draft.bidEndsAt"),
      optionalDateMs(season.draft.nominationEndsAt, "draft.nominationEndsAt"),
    ].filter((value): value is number => value !== null);
    addCandidate(
      candidates,
      nowMs,
      deadlines.length > 0 ? Math.min(...deadlines) : nowMs,
      "DRAFT",
    );
  }

  const lobby = inputs.activeLobbies[0] ?? null;
  const presentCutoff = nowMs - INHOUSE.QUEUE_AWAY_SECONDS * 1_000;
  const present = inputs.queue.filter(
    (entry) => dateMs(entry.lastSeenAt, "queue.lastSeenAt") >= presentCutoff,
  );
  if (!lobby && present.length >= INHOUSE.LOBBY_SIZE) {
    addCandidate(candidates, nowMs, nowMs, "INHOUSE");
  }
  for (const [index, entry] of inputs.queue.entries()) {
    const seenAt = dateMs(entry.lastSeenAt, `queue[${index}].lastSeenAt`);
    const joinedAt = dateMs(entry.joinedAt, `queue[${index}].joinedAt`);
    const storedIdleExpiresAt = optionalDateMs(
      entry.idleExpiresAt,
      `queue[${index}].idleExpiresAt`,
    );
    // New rows share one persisted deadline. joinedAt is the rollback bridge
    // for rows written by an older binary during a rolling deployment.
    addCandidate(
      candidates,
      nowMs,
      (storedIdleExpiresAt ??
        joinedAt + INHOUSE.QUEUE_IDLE_HOURS * 3_600_000) + 1,
      "INHOUSE",
    );
    const awayAt = seenAt + INHOUSE.QUEUE_AWAY_SECONDS * 1_000 + 1;
    // Presence is display/formation eligibility, not a removal deadline. A
    // background tab retains its queue membership until the shared idle clock
    // expires. Wake once for a FUTURE away transition so the board can update;
    // an already-away player (including a backdated admin requeue) must not
    // keep the scheduler immediately due on every pass.
    if (nowMs < awayAt) {
      addCandidate(candidates, nowMs, awayAt, "INHOUSE");
    }
  }

  if (lobby) {
    invariant(INHOUSE_ACTIVE_STATUSES.includes(lobby.status as never), "lobby status is unknown");
    const lobbyDeadline = (value: Date | null, label: string) => {
      const deadline = optionalDateMs(value, label);
      addCandidate(candidates, nowMs, deadline ?? nowMs, "INHOUSE");
    };
    if (
      (lobby.status === INHOUSE_STATUS.READY ||
        lobby.status === INHOUSE_STATUS.IN_PROGRESS) &&
      lobby.betsCloseAt
    ) {
      const betsCloseAt = dateMs(lobby.betsCloseAt, "lobby.betsCloseAt");
      if (betsCloseAt > nowMs) {
        addCandidate(candidates, nowMs, betsCloseAt, "INHOUSE");
      }
    }
    if (lobby.status === INHOUSE_STATUS.READY_CHECK) {
      lobbyDeadline(lobby.acceptEndsAt, "lobby.acceptEndsAt");
    } else if (lobby.status === INHOUSE_STATUS.CAPTAIN_VOTE) {
      lobbyDeadline(lobby.voteEndsAt, "lobby.voteEndsAt");
    } else if (lobby.status === INHOUSE_STATUS.DRAFTING) {
      lobbyDeadline(lobby.pickEndsAt, "lobby.pickEndsAt");
    } else if (lobby.status === INHOUSE_STATUS.READY) {
      const updatedAt = dateMs(lobby.updatedAt, "lobby.updatedAt");
      addCandidate(
        candidates,
        nowMs,
        updatedAt + INHOUSE.ABANDON_READY_HOURS * 3_600_000 + 1,
        "INHOUSE",
      );
    } else if (lobby.status === INHOUSE_STATUS.IN_PROGRESS) {
      const startedAt = optionalDateMs(lobby.startedAt, "lobby.startedAt");
      invariant(startedAt !== null, "in-progress lobby has no start time");
      const detectOpensAt = startedAt + INHOUSE.DETECT_MIN_MINUTES * 60_000;
      const detectedAt = optionalDateMs(lobby.detectedAt, "lobby.detectedAt");
      const detectAt =
        nowMs < detectOpensAt
          ? detectOpensAt
          : detectedAt === null
            ? nowMs
            : detectedAt + detectIntervalSeconds(nowMs - startedAt) * 1_000 + 1;
      addCandidate(candidates, nowMs, detectAt, "INHOUSE");
      addCandidate(
        candidates,
        nowMs,
        startedAt + INHOUSE.ABANDON_IN_PROGRESS_HOURS * 3_600_000 + 1,
        "INHOUSE",
      );
    }
  }
  if (inputs.unsettledBet || inputs.repairableInhouseResult) {
    addCandidate(candidates, nowMs, nowMs, "INHOUSE");
  }

  if (inputs.leagueDeliveryAvailable && inputs.leagueOutbox.length > 0) {
    for (const row of inputs.leagueOutbox) {
      outboxWakeAt(
        row,
        "leagueOutbox",
        nowMs,
        inputs.outboxClock,
      );
      dateMs(row.createdAt, "leagueOutbox.createdAt");
    }
    const sorted = [...inputs.leagueOutbox].sort((left, right) => {
      const byCreated =
        dateMs(left.createdAt, "leagueOutbox.createdAt") -
        dateMs(right.createdAt, "leagueOutbox.createdAt");
      return byCreated || left.id.localeCompare(right.id);
    });
    addCandidate(
      candidates,
      nowMs,
      outboxWakeAt(
        sorted[0]!,
        "leagueOutbox",
        nowMs,
        inputs.outboxClock,
      ),
      "LEAGUE_OUTBOX",
    );
  }

  const inhouseHeads = new Map<
    string,
    AutomationGateInputs["inhouseOutboxes"][number]
  >();
  const inhouseSequences = new Set<string>();
  for (const row of inputs.inhouseOutboxes) {
    invariant(
      Number.isSafeInteger(row.sequence) && row.sequence >= 0,
      "inhouse outbox sequence is invalid",
    );
    const sequenceKey = `${row.lobbyId}:${row.sequence}`;
    invariant(
      !inhouseSequences.has(sequenceKey),
      "duplicate inhouse outbox sequence",
    );
    inhouseSequences.add(sequenceKey);
    outboxWakeAt(
      row,
      "inhouseOutbox",
      nowMs,
      inputs.outboxClock,
    );
    dateMs(row.createdAt, "inhouseOutbox.createdAt");
    const current = inhouseHeads.get(row.lobbyId);
    if (
      !current ||
      row.sequence < current.sequence ||
      (row.sequence === current.sequence &&
        (dateMs(row.createdAt, "inhouseOutbox.createdAt") <
          dateMs(current.createdAt, "inhouseOutbox.createdAt") ||
          (row.createdAt.getTime() === current.createdAt.getTime() &&
            row.id.localeCompare(current.id) < 0)))
    ) {
      inhouseHeads.set(row.lobbyId, row);
    }
  }
  for (const row of inhouseHeads.values()) {
    addCandidate(
      candidates,
      nowMs,
      outboxWakeAt(
        row,
        "inhouseOutbox",
        nowMs,
        inputs.outboxClock,
      ),
      "INHOUSE_OUTBOX",
    );
  }

  if (
    season &&
    inputs.leagueWebhookConfigured &&
    (season.status === SEASON_STATUS.REGULAR_SEASON ||
      season.status === SEASON_STATUS.PLAYOFFS)
  ) {
    const seenClusters = new Set<string>();
    for (const match of season.matches) {
      if (match.status !== MATCH_STATUS.SCHEDULED || !match.scheduledAt) continue;
      const kickoff = dateMs(match.scheduledAt, "match.scheduledAt");
      const cluster = `${match.week}:${kickoff}`;
      if (seenClusters.has(cluster)) continue;
      seenClusters.add(cluster);
      const opensAt = kickoff - WEEK_REMINDER.AHEAD_HOURS * 3_600_000;
      const closesAt = kickoff + WEEK_REMINDER.BEHIND_HOURS * 3_600_000;
      if (nowMs > closesAt) continue;
      if (nowMs < opensAt) {
        addCandidate(candidates, nowMs, opensAt, "REMINDER");
        continue;
      }
      const markerAt = genericMarkerWakeAt(
        inputs.settings[weekReminderKey(season.id, match.week, kickoff)],
        nowMs,
      );
      if (markerAt !== null && markerAt <= closesAt) {
        addCandidate(candidates, nowMs, markerAt, "REMINDER");
      }
    }
  }

  if (season?.status === SEASON_STATUS.PLAYOFFS) {
    const latest = latestPlayoffRound(season.matches);
    if (
      latest.length > 0 &&
      latest.every(
        (match) =>
          match.status === MATCH_STATUS.COMPLETED &&
          !!match.winnerTeamId &&
          (match.winnerTeamId === match.homeTeamId ||
            match.winnerTeamId === match.awayTeamId),
      ) &&
      (latest.length > 1 || latest[0]?.phase === MATCH_PHASE.FINAL)
    ) {
      addCandidate(candidates, nowMs, nowMs, "PLAYOFF_REPAIR");
    }
  }

  const retryThrottle = nextThrottleAt(
    inputs.settings,
    SETTING_KEYS.ANNOUNCE_RETRY_AT,
    AUTO_SYNC.LEAGUE_INTERVAL_SECONDS * 1_000,
  );
  for (const marker of inputs.globalAnnouncementMarkers) {
    invariant(
      marker.key.startsWith(RESULT_ANNOUNCED_PREFIX) ||
        marker.key.startsWith(CHAMPION_ANNOUNCED_PREFIX),
      "global announcement marker has an unknown key",
    );
    // Champion recovery deliberately preserves its marker while Discord is
    // unavailable so the winner can still be announced after configuration
    // returns. Retrying before then cannot make progress; the webhook mutation
    // invalidates this gate, and the hard wake covers runtime env changes.
    if (
      marker.key.startsWith(CHAMPION_ANNOUNCED_PREFIX) &&
      !inputs.leagueDeliveryAvailable
    ) {
      continue;
    }
    const markerAt = genericMarkerWakeAt(marker.value, nowMs);
    if (markerAt !== null) {
      addCandidate(
        candidates,
        nowMs,
        Math.max(markerAt, retryThrottle),
        "ANNOUNCEMENT_RETRY",
      );
    }
  }

  if (season) {
    if (
      inputs.leagueWebhookConfigured &&
      (season.status === SEASON_STATUS.REGULAR_SEASON ||
        season.status === SEASON_STATUS.PLAYOFFS ||
        season.status === SEASON_STATUS.COMPLETE)
    ) {
      for (const match of season.matches) {
        if (match.status !== MATCH_STATUS.COMPLETED) continue;
        const markerValue = inputs.settings[resultAnnouncedKey(match.id)];
        if (markerValue === undefined && !match.completedAt) continue;
        const markerAt = genericMarkerWakeAt(
          markerValue,
          nowMs,
        );
        if (markerAt !== null) {
          addCandidate(
            candidates,
            nowMs,
            Math.max(markerAt, retryThrottle),
            "ANNOUNCEMENT_RETRY",
          );
        }
      }
    }

    if (
      inputs.leagueWebhookConfigured &&
      season.status === SEASON_STATUS.COMPLETE &&
      season.championTeamId &&
      (inputs.settings[championAnnouncedKey(season.id)] !== undefined ||
        season.matches.some(
          (match) =>
            match.phase === MATCH_PHASE.FINAL &&
            match.status === MATCH_STATUS.COMPLETED &&
            match.completedAt !== null &&
            match.winnerTeamId === season.championTeamId,
        ))
    ) {
      const markerAt = genericMarkerWakeAt(
        inputs.settings[championAnnouncedKey(season.id)],
        nowMs,
      );
      if (markerAt !== null) {
        addCandidate(
          candidates,
          nowMs,
          Math.max(markerAt, retryThrottle),
          "ANNOUNCEMENT_RETRY",
        );
      }
    }

    const regularByWeek = new Map<number, AutomationGateMatch[]>();
    for (const match of season.matches) {
      if (match.phase !== MATCH_PHASE.REGULAR) continue;
      const rows = regularByWeek.get(match.week) ?? [];
      rows.push(match);
      regularByWeek.set(match.week, rows);
    }
    for (const [week, matches] of regularByWeek) {
      const markerValue = inputs.settings[honorsAnnouncedKey(season.id, week)];
      // An absent marker is post-commit crash recovery. Retry it briskly for
      // one hard horizon, then leave old recovery to the hourly safety pass:
      // unchanged incomplete box scores cannot become ready by polling. An
      // explicit failed/stale/claim marker remains retryable without this cap.
      if (
        matches.length === 0 ||
        matches.some((match) => match.status !== MATCH_STATUS.COMPLETED) ||
        (markerValue === undefined &&
          !matches.some(
            (match) =>
              match.completedAt !== null &&
              dateMs(match.completedAt, "match.completedAt") >=
                nowMs - AUTOMATION_GATE_HARD_HORIZON_MS,
          ))
      ) {
        continue;
      }
      const markerAt = honorsMarkerWakeAt(
        markerValue,
        nowMs,
      );
      if (markerAt !== null) {
        addCandidate(
          candidates,
          nowMs,
          Math.max(markerAt, retryThrottle),
          "ANNOUNCEMENT_RETRY",
        );
      }
    }
  }

  const boardAt = boardWakeAt(inputs.settings, nowMs, inputs.boardNeedsSync);
  if (boardAt !== null) addCandidate(candidates, nowMs, boardAt, "BOARD");

  const next = candidates.reduce<Candidate | null>(
    (best, candidate) => (!best || candidate.at < best.at ? candidate : best),
    null,
  );
  return {
    version: AUTOMATION_GATE_VERSION,
    computedAtMs: nowMs,
    nextWakeAtMs: next?.at ?? Number.MAX_SAFE_INTEGER,
    hardWakeAtMs,
    reason: next?.reason ?? null,
    runnerHealthy:
      runnerHealthy &&
      !(!inputs.leagueDeliveryAvailable && inputs.leagueOutbox.length > 0),
  };
}

/** Read all state required to prove a safe sleep deadline. */
export async function loadAutomationGateSnapshot(
  nowMs = Date.now(),
): Promise<AutomationGateSnapshot> {
  const [runner, seasons] = await Promise.all([
    prisma.automationRunState.findUnique({
      where: { key: "league-maintenance" },
      select: {
        lastStatus: true,
        leaseExpiresAt: true,
        lastFinishedAt: true,
        consecutiveFailures: true,
        lastSummary: true,
      },
    }),
    prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: {
        id: true,
        status: true,
        dotaLeagueId: true,
        championTeamId: true,
        draft: {
          select: {
            status: true,
            bidEndsAt: true,
            nominationEndsAt: true,
          },
        },
        matches: {
          select: {
            id: true,
            week: true,
            phase: true,
            bracketSlot: true,
            status: true,
            scheduledAt: true,
            autoSyncedAt: true,
            autoSyncAttempts: true,
            completedAt: true,
            winnerTeamId: true,
            homeTeamId: true,
            awayTeamId: true,
          },
        },
      },
    }),
  ]);
  invariant(seasons.length <= 1, "multiple active seasons");
  const season = seasons[0] ?? null;
  const markerScopes = season
    ? [
        { key: { startsWith: weekReminderPrefix(season.id) } },
        { key: { in: season.matches.map((match) => resultAnnouncedKey(match.id)) } },
        { key: championAnnouncedKey(season.id) },
        { key: { startsWith: honorsAnnouncedPrefix(season.id) } },
      ]
    : [];
  const [
    settingRows,
    activeLobbies,
    queue,
    unsettledBet,
    repairableInhouseResult,
    leagueOutbox,
    inhouseOutboxes,
  ] = await Promise.all([
    prisma.setting.findMany({
      where: {
        OR: [
          {
            key: {
              in: [
                SETTING_KEYS.DISCORD_WEBHOOK_URL,
                SETTING_KEYS.LEAGUE_AUTO_SYNC_AT,
                SETTING_KEYS.ROSTER_AUTO_SYNC_AT,
                SETTING_KEYS.ANNOUNCE_RETRY_AT,
                SETTING_KEYS.INHOUSE_BOARD,
                SETTING_KEYS.INHOUSE_BOARD_AT,
              ],
            },
          },
          ...markerScopes,
          {
            key: { startsWith: RESULT_ANNOUNCED_PREFIX },
            value: { startsWith: ANNOUNCE_FAILED_PREFIX },
          },
          {
            key: { startsWith: RESULT_ANNOUNCED_PREFIX },
            value: { startsWith: ANNOUNCEMENT_CLAIM_PREFIX },
          },
          {
            key: { startsWith: CHAMPION_ANNOUNCED_PREFIX },
            value: { startsWith: ANNOUNCE_FAILED_PREFIX },
          },
          {
            key: { startsWith: CHAMPION_ANNOUNCED_PREFIX },
            value: { startsWith: ANNOUNCEMENT_CLAIM_PREFIX },
          },
        ],
      },
      select: { key: true, value: true },
    }),
    prisma.inhouseLobby.findMany({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: {
        status: true,
        acceptEndsAt: true,
        voteEndsAt: true,
        pickEndsAt: true,
        startedAt: true,
        detectedAt: true,
        updatedAt: true,
        betsCloseAt: true,
      },
    }),
    prisma.inhouseQueueEntry.findMany({
      select: {
        joinedAt: true,
        lastSeenAt: true,
        idleExpiresAt: true,
      },
    }),
    prisma.inhouseLobby.findFirst({
      where: {
        OR: [
          {
            betSettlement: INHOUSE_BET_STATUS.PENDING,
            status: {
              in: [INHOUSE_STATUS.COMPLETED, INHOUSE_STATUS.CANCELLED],
            },
          },
          {
            betSettlement: INHOUSE_BET_STATUS.SETTLED,
            status: INHOUSE_STATUS.CANCELLED,
          },
        ],
      },
      select: { id: true },
    }),
    prisma.inhouseLobby.findFirst({
      where: {
        status: INHOUSE_STATUS.COMPLETED,
        completedAt: { gte: new Date(nowMs - 60 * 60_000) },
        dotaMatchId: { not: null },
        OR: [
          { eloDeltas: "{}" },
          { announcements: { none: { kind: "RESULT" } } },
        ],
      },
      select: { id: true },
    }),
    prisma.leagueAnnouncement.findMany({
      where: { status: { in: ["PENDING", "SENDING"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 1,
      select: {
        id: true,
        status: true,
        availableAt: true,
        claimedAt: true,
        createdAt: true,
      },
    }),
    prisma.inhouseAnnouncement.findMany({
      where: { status: { in: ["PENDING", "SENDING"] } },
      orderBy: [{ lobbyId: "asc" }, { sequence: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        lobbyId: true,
        sequence: true,
        status: true,
        availableAt: true,
        claimedAt: true,
        createdAt: true,
      },
    }),
  ]);

  const settings = Object.fromEntries(
    settingRows.map((row) => [row.key, row.value]),
  );
  let outboxClock = { databaseNowMs: nowMs, appNowMs: nowMs };
  if (leagueOutbox.length > 0 || inhouseOutboxes.length > 0) {
    const sampleStartedAtMs = Date.now();
    const databaseNowMs = (await databaseNow()).getTime();
    const sampleFinishedAtMs = Date.now();
    invariant(validTimestamp(databaseNowMs), "database clock is invalid");
    outboxClock = {
      databaseNowMs,
      appNowMs: Math.floor((sampleStartedAtMs + sampleFinishedAtMs) / 2),
    };
  }
  const globalAnnouncementMarkers = settingRows.filter(
    (row) =>
      (row.key.startsWith(RESULT_ANNOUNCED_PREFIX) ||
        row.key.startsWith(CHAMPION_ANNOUNCED_PREFIX)) &&
      (row.value.startsWith(ANNOUNCE_FAILED_PREFIX) ||
        row.value.startsWith(ANNOUNCEMENT_CLAIM_PREFIX)),
  );
  const boardNeedsSync = await inhouseBoardNeedsSync(
    settings[SETTING_KEYS.INHOUSE_BOARD],
    nowMs,
  );
  const configuredWebhook =
    normalizeDiscordWebhookUrl(settings[SETTING_KEYS.DISCORD_WEBHOOK_URL]) ??
    normalizeDiscordWebhookUrl(process.env.DISCORD_WEBHOOK_URL);
  const leagueWebhookConfigured = configuredWebhook !== null;
  return computeAutomationGateSnapshot(
    {
      runner,
      seasons,
      settings,
      leagueWebhookConfigured,
      leagueDeliveryAvailable:
        leagueWebhookConfigured && discordMutationsAllowed(),
      activeLobbies,
      queue,
      unsettledBet: unsettledBet !== null,
      repairableInhouseResult: repairableInhouseResult !== null,
      leagueOutbox,
      inhouseOutboxes,
      outboxClock,
      globalAnnouncementMarkers,
      boardNeedsSync,
    },
    nowMs,
  );
}

function isAutomationGateSnapshot(value: unknown): value is AutomationGateSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== AUTOMATION_GATE_VERSION ||
    typeof snapshot.computedAtMs !== "number" ||
    typeof snapshot.nextWakeAtMs !== "number" ||
    typeof snapshot.hardWakeAtMs !== "number" ||
    typeof snapshot.runnerHealthy !== "boolean" ||
    !validTimestamp(snapshot.computedAtMs) ||
    !validTimestamp(snapshot.nextWakeAtMs) ||
    !validTimestamp(snapshot.hardWakeAtMs) ||
    snapshot.hardWakeAtMs >
      snapshot.computedAtMs + AUTOMATION_GATE_HARD_HORIZON_MS
  ) {
    return false;
  }
  if (snapshot.nextWakeAtMs === Number.MAX_SAFE_INTEGER) {
    return snapshot.reason === null;
  }
  return (
    typeof snapshot.reason === "string" &&
    AUTOMATION_GATE_REASONS.includes(snapshot.reason as AutomationGateReason)
  );
}

export function automationGateDecisionFromSnapshot(
  snapshot: unknown,
  nowMs: number,
): AutomationGateDecision {
  if (!validTimestamp(nowMs) || !isAutomationGateSnapshot(snapshot)) {
    return { run: true };
  }
  // On a cache miss the zero-argument loader captures computedAt *after* the
  // request captured nowMs. Accept that bounded, ordinary ordering (and small
  // cross-instance clock skew); a materially future snapshot still fails open.
  if (snapshot.computedAtMs - nowMs > AUTOMATION_GATE_CLOCK_SKEW_MS) {
    return { run: true };
  }
  const decisionAtMs = Math.max(nowMs, snapshot.computedAtMs);
  if (
    decisionAtMs >= Math.min(snapshot.nextWakeAtMs, snapshot.hardWakeAtMs)
  ) {
    return { run: true, snapshot };
  }
  return { run: false, snapshot };
}

// Intentionally zero-argument: passing a tick timestamp to unstable_cache
// would create a distinct cache key on every request and defeat the gate.
const loadCachedAutomationGateSnapshot = unstable_cache(
  () => loadAutomationGateSnapshot(),
  [AUTOMATION_GATE_CACHE_KEY],
  {
    tags: [AUTOMATION_GATE_TAG],
    // Never renew the absolute hard wake in the background. A timer-based
    // stale-while-revalidate could let a health/admin read install a fresh
    // one-hour snapshot just before cron observes the old one as due. Only
    // an explicit mutation or a completed worker pass may rebuild this value.
    revalidate: false,
  },
);

export async function getAutomationGateDecision(
  nowMs = Date.now(),
): Promise<AutomationGateDecision> {
  if (!validTimestamp(nowMs)) return { run: true };
  const readStartedAtMs = Date.now();
  try {
    const snapshot = await loadCachedAutomationGateSnapshot();
    // A cache miss performs several reads. Re-account for that elapsed time so
    // a deadline crossed while the snapshot was loading runs on this tick,
    // rather than returning NOT_DUE for another scheduler minute. Expressing
    // the elapsed duration relative to the caller's clock also keeps explicit
    // test/monitor clocks deterministic.
    const elapsedMs = Math.max(0, Date.now() - readStartedAtMs);
    const decisionNowMs =
      nowMs <= Number.MAX_SAFE_INTEGER - elapsedMs
        ? nowMs + elapsedMs
        : Number.MAX_SAFE_INTEGER;
    return automationGateDecisionFromSnapshot(
      snapshot,
      decisionNowMs,
    );
  } catch {
    // A cache or database outage must never suppress maintenance.
    return { run: true };
  }
}
