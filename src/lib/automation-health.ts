export const AUTOMATION_EXPECTED_CADENCE_MS = 60_000;
// A one-minute scheduler can legitimately slip during a deploy or cold start.
// Four missed ticks is actionable without making the card flap on routine
// platform jitter.
export const AUTOMATION_STALE_AFTER_MS = 4 * AUTOMATION_EXPECTED_CADENCE_MS;

export type AutomationIdleWindow = {
  nextWakeAtMs: number;
  hardWakeAtMs: number;
};

export type AutomationHealthRecord = {
  lastStatus: string;
  leaseExpiresAt: Date | null;
  lastAttemptAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastSuccessAt: Date | null;
  lastSource: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastSummary: string;
};

export type AutomationHealthKind =
  | "UNAVAILABLE"
  | "NEVER"
  | "RUNNING"
  | "HEALTHY"
  | "DEGRADED";

export type AutomationHealthView = {
  kind: AutomationHealthKind;
  label: string;
  headline: string;
  description: string;
  sourceLabel: string;
  durationLabel: string;
  consecutiveFailures: number;
  leaseActive: boolean;
  leaseExpired: boolean;
  leaseExpiresAt: Date | null;
  canRunNow: boolean;
  disabledReason: string | null;
  signals: string[];
};

export type AutomationProbeStatus =
  | "healthy"
  | "running"
  | "never-run"
  | "stale"
  | "failed"
  | "degraded"
  | "lease-expired"
  | "unavailable";

export type AutomationProbeRecord = Pick<
  AutomationHealthRecord,
  | "lastStatus"
  | "leaseExpiresAt"
  | "lastSuccessAt"
  | "consecutiveFailures"
>;

export type AutomationProbeView = {
  ok: boolean;
  status: AutomationProbeStatus;
};

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SIGNAL_COUNT = 999;
const MAX_CODES = 12;
// Only codes emitted by our bounded automation/result-sync boundary are shown.
// Merely matching an uppercase shape is enough for safe persistence, but not
// enough for operator display: an upstream library could misuse `error.code`
// for a credential-looking value.
const OPERATOR_CODES = new Set([
  "AUTOMATION_FAILED",
  "WORK_BUDGET_EXHAUSTED",
  "WORKER_DEGRADED",
  "REQUEST_ABORTED",
  "LEAGUE_SYNC_FAILED",
  "INHOUSE_SYNC_FAILED",
  "DRAFT_SYNC_FAILED",
  "PLAYOFF_SYNC_FAILED",
  "REMINDER_FAILED",
  "NOTIFICATION_RETRY_FAILED",
  "LEAGUE_NOTIFICATION_DELIVERY_FAILED",
  "CURSOR_READ_FAILED",
  "LEAGUE_BUDGET_EXHAUSTED",
  "INHOUSE_BUDGET_EXHAUSTED",
  "DRAFT_BUDGET_EXHAUSTED",
  "PLAYOFF_BUDGET_EXHAUSTED",
  "REMINDER_BUDGET_EXHAUSTED",
  "NOTIFICATIONS_BUDGET_EXHAUSTED",
  "CURSOR_BUDGET_EXHAUSTED",
]);

function safeCode(value: unknown): string | null {
  if (typeof value !== "string" || !SAFE_CODE.test(value)) return null;
  return OPERATOR_CODES.has(value) || /^P\d{4}$/.test(value) ? value : null;
}

function safeCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(safeCode).filter((v): v is string => !!v))].slice(
    0,
    MAX_CODES,
  );
}

function safeCount(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fallback;
  }
  return Math.min(MAX_SIGNAL_COUNT, value);
}

function parsedSummary(value: string): {
  issueCount: number;
  issueCodes: string[];
  skippedCount: number;
  skippedCodes: string[];
  recoveredExpiredLease: boolean;
} {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    const record = parsed as Record<string, unknown>;
    const issueCodes = safeCodes(record.issues);
    const skippedCodes = safeCodes(record.skipped);
    return {
      issueCount: safeCount(record.issueCount, issueCodes.length),
      issueCodes,
      skippedCount: safeCount(record.skippedCount, skippedCodes.length),
      skippedCodes,
      recoveredExpiredLease: record.recoveredExpiredLease === true,
    };
  } catch {
    return {
      issueCount: 0,
      issueCodes: [],
      skippedCount: 0,
      skippedCodes: [],
      recoveredExpiredLease: false,
    };
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function codeList(codes: string[]): string {
  return codes.length > 0 ? ` (${codes.join(", ")})` : "";
}

function sourceLabel(source: string | null): string {
  if (source === "CRON") return "Scheduled cron";
  if (source === "ADMIN") return "Admin manual run";
  return "Not recorded";
}

function recentTimestamp(value: Date | null, nowMs: number): boolean {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return false;
  }
  const ageMs = nowMs - value.getTime();
  return (
    ageMs >= -AUTOMATION_EXPECTED_CADENCE_MS &&
    ageMs <= AUTOMATION_STALE_AFTER_MS
  );
}

function validIdleWindow(
  idleWindow: AutomationIdleWindow | null | undefined,
  nowMs: number,
): idleWindow is AutomationIdleWindow {
  return (
    idleWindow !== null &&
    idleWindow !== undefined &&
    Number.isFinite(idleWindow.nextWakeAtMs) &&
    Number.isSafeInteger(idleWindow.nextWakeAtMs) &&
    Number.isFinite(idleWindow.hardWakeAtMs) &&
    Number.isSafeInteger(idleWindow.hardWakeAtMs) &&
    idleWindow.nextWakeAtMs > nowMs &&
    idleWindow.hardWakeAtMs > nowMs &&
    idleWindow.nextWakeAtMs <= idleWindow.hardWakeAtMs
  );
}

/**
 * Minimal public monitoring contract. It intentionally exposes no timestamps,
 * lease owner/token, summaries, error codes, or backlog details. An active run
 * remains healthy only when a previous successful pass is still fresh; this
 * avoids a false alarm during every normal one-minute maintenance invocation
 * without allowing a first or already-unhealthy run to mask the problem.
 */
export function automationProbeView(
  state: AutomationProbeRecord | null | undefined,
  nowMs: number,
  idleWindow?: AutomationIdleWindow | null,
): AutomationProbeView {
  if (state === undefined) return { ok: false, status: "unavailable" };
  if (state === null || state.lastStatus === "NEVER") {
    return { ok: false, status: "never-run" };
  }

  const leaseActive =
    state.lastStatus === "RUNNING" &&
    state.leaseExpiresAt instanceof Date &&
    Number.isFinite(state.leaseExpiresAt.getTime()) &&
    state.leaseExpiresAt.getTime() > nowMs;
  if (state.lastStatus === "RUNNING" && !leaseActive) {
    return { ok: false, status: "lease-expired" };
  }

  const freshSuccess = recentTimestamp(state.lastSuccessAt, nowMs);
  const cleanHistory = state.consecutiveFailures === 0;
  if (leaseActive) {
    return {
      ok: freshSuccess && cleanHistory,
      status: "running",
    };
  }
  if (state.lastStatus === "FAILED") return { ok: false, status: "failed" };
  if (state.lastStatus === "DEGRADED" || !cleanHistory) {
    return { ok: false, status: "degraded" };
  }
  if (state.lastStatus !== "SUCCEEDED") {
    return { ok: false, status: "degraded" };
  }
  if (!freshSuccess && !validIdleWindow(idleWindow, nowMs)) {
    return { ok: false, status: "stale" };
  }
  return { ok: true, status: "healthy" };
}

export function formatAutomationDuration(durationMs: number | null): string {
  if (
    durationMs === null ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0
  ) {
    return "Not recorded";
  }
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function baseView(
  kind: AutomationHealthKind,
  label: string,
  headline: string,
  description: string,
): AutomationHealthView {
  return {
    kind,
    label,
    headline,
    description,
    sourceLabel: "Not recorded",
    durationLabel: "Not recorded",
    consecutiveFailures: 0,
    leaseActive: false,
    leaseExpired: false,
    leaseExpiresAt: null,
    canRunNow: false,
    disabledReason: null,
    signals: [],
  };
}

/**
 * Convert the persisted runner row into a small, secret-safe operator model.
 * `undefined` means the row could not be queried; `null` means it does not yet
 * exist. Raw summary text, lease tokens/owners, and unknown source strings are
 * deliberately never returned to the UI.
 */
export function automationHealthView(
  state: AutomationHealthRecord | null | undefined,
  nowMs: number,
  idleWindow?: AutomationIdleWindow | null,
): AutomationHealthView {
  if (state === undefined) {
    return {
      ...baseView(
        "UNAVAILABLE",
        "Unavailable",
        "Automation health is unavailable",
        "The persisted runner state could not be read. Check database readiness before starting maintenance.",
      ),
      disabledReason:
        "Run maintenance is disabled until the automation state and database readiness can be read safely.",
    };
  }

  if (
    state === null ||
    (state.lastStatus === "NEVER" && state.lastAttemptAt === null)
  ) {
    return {
      ...baseView(
        "NEVER",
        "Never run",
        "No maintenance run has been recorded",
        "The runner is ready to establish its first persisted status. Confirm the production scheduler is configured before launch.",
      ),
      canRunNow: true,
    };
  }

  const summary = parsedSummary(state.lastSummary);
  const consecutiveFailures = safeCount(state.consecutiveFailures);
  const leaseExpiresAt =
    state.leaseExpiresAt instanceof Date &&
    Number.isFinite(state.leaseExpiresAt.getTime())
      ? state.leaseExpiresAt
      : null;
  // This matches the database election rule: RUNNING with a future expiry is
  // owned, even if other metadata is incomplete. Enabling the button in that
  // case would only create a losing request and imply that it could override.
  const leaseActive =
    state.lastStatus === "RUNNING" &&
    leaseExpiresAt !== null &&
    leaseExpiresAt.getTime() > nowMs;
  const leaseExpired = state.lastStatus === "RUNNING" && !leaseActive;
  const signals: string[] = [];

  if (consecutiveFailures > 0) {
    signals.push(
      `${consecutiveFailures} consecutive non-healthy ${plural(consecutiveFailures, "run")}`,
    );
  }
  if (summary.issueCount > 0) {
    signals.push(
      `${summary.issueCount} ${plural(summary.issueCount, "issue")} reported by the latest run${codeList(summary.issueCodes)}`,
    );
  }
  if (summary.skippedCount > 0) {
    signals.push(
      `${summary.skippedCount} maintenance ${plural(summary.skippedCount, "step")} deferred${codeList(summary.skippedCodes)}`,
    );
  }
  if (summary.recoveredExpiredLease) {
    signals.push("The latest run recovered an expired worker lease");
  }
  const errorCode = safeCode(state.lastErrorCode);
  if (errorCode) signals.push(`Latest error code: ${errorCode}`);

  const shared = {
    sourceLabel: sourceLabel(state.lastSource),
    durationLabel: formatAutomationDuration(state.lastDurationMs),
    consecutiveFailures,
    leaseActive,
    leaseExpired,
    leaseExpiresAt,
    signals,
  };

  if (leaseActive) {
    return {
      ...baseView(
        "RUNNING",
        "Running",
        "Maintenance is running",
        "A runner currently owns the database lease. A manual run cannot overlap or override it.",
      ),
      ...shared,
      disabledReason:
        "Run maintenance is disabled while the current database lease is active; this control never overrides its owner.",
    };
  }

  if (leaseExpired) {
    signals.unshift(
      "The previous run did not finalize before its lease expired",
    );
    return {
      ...baseView(
        "DEGRADED",
        "Degraded",
        "The previous runner lost its lease",
        "The lease is no longer active. The next scheduled or manual run can recover it without bypassing ownership.",
      ),
      ...shared,
      leaseExpired: true,
      signals,
      canRunNow: true,
    };
  }

  const finishedAtMs = state.lastFinishedAt?.getTime();
  const completionAgeMs =
    typeof finishedAtMs === "number" && Number.isFinite(finishedAtMs)
      ? nowMs - finishedAtMs
      : null;
  const completionOverdue =
    completionAgeMs === null ||
    completionAgeMs > AUTOMATION_STALE_AFTER_MS ||
    completionAgeMs < -AUTOMATION_EXPECTED_CADENCE_MS;
  const idleWindowApplies =
    state.lastStatus === "SUCCEEDED" &&
    state.consecutiveFailures === 0 &&
    validIdleWindow(idleWindow, nowMs);

  if (
    state.lastStatus === "SUCCEEDED" &&
    consecutiveFailures === 0 &&
    (!completionOverdue || idleWindowApplies)
  ) {
    return {
      ...baseView(
        "HEALTHY",
        "Healthy",
        idleWindowApplies
          ? "The automation worker is caught up"
          : "The automation runner is healthy",
        idleWindowApplies
          ? "No maintenance work is due: the worker is caught up and will run again by the next wake."
          : "The latest pass completed successfully within the expected scheduler window.",
      ),
      ...shared,
      canRunNow: true,
    };
  }

  if (state.lastStatus === "SUCCEEDED" && completionOverdue) {
    signals.unshift(
      "No completed run has been recorded within the four-minute health window",
    );
  } else if (!["FAILED", "DEGRADED", "SUCCEEDED"].includes(state.lastStatus)) {
    signals.unshift("The persisted runner status is not recognized");
  }

  const failureDescription =
    state.lastStatus === "FAILED"
      ? "The latest pass failed. Review the safe failure and backlog signals, then retry after the dependency has recovered."
      : state.lastStatus === "DEGRADED"
        ? "The latest pass finished with incomplete or deferred work. Review the signals before relying on the next scheduled pass."
        : "The last successful completion is overdue for the expected one-minute schedule.";

  return {
    ...baseView(
      "DEGRADED",
      "Degraded",
      "Automation needs attention",
      failureDescription,
    ),
    ...shared,
    signals,
    canRunNow: true,
  };
}
