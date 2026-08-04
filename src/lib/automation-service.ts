import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import {
  runResultSync,
  type ResultSyncOutcome,
} from "./result-sync-service";
import { raceHook } from "./race-hook";

export const AUTOMATION_RUN_KEY = "league-maintenance";
export const AUTOMATION_LEASE_MS = 90_000;
export const AUTOMATION_WORK_BUDGET_MS = 45_000;
export const AUTOMATION_SUMMARY_MAX_BYTES = 2_048;

export type AutomationSource = "CRON" | "ADMIN";
export type AutomationFinalStatus = "SUCCEEDED" | "DEGRADED" | "FAILED";

type AutomationDb = Pick<typeof prisma, "automationRunState">;

export type AutomationWorkerOutcome = ResultSyncOutcome & {
  /** Stable machine codes only. A non-empty list makes the run degraded. */
  issues?: readonly string[];
  /** Work intentionally not started because the run budget was exhausted. */
  skipped?: readonly string[];
};

export type AutomationWorker = (options: {
  deadlineMs: number;
  signal: AbortSignal;
}) => Promise<AutomationWorkerOutcome>;

export type AutomationLease = {
  kind: "acquired";
  token: string;
  owner: AutomationSource;
  leaseExpiresAt: Date;
  recoveredExpiredLease: boolean;
};

export type AutomationLeaseHeld = {
  kind: "lease-held";
  leaseExpiresAt: Date | null;
};

export type AutomationRunResult =
  | {
      kind: "lease-held";
      status: "RUNNING";
      leaseExpiresAt: Date | null;
      retryAfterSeconds: number;
    }
  | {
      kind: "completed" | "fenced";
      status: AutomationFinalStatus;
      durationMs: number;
      recoveredExpiredLease: boolean;
      errorCode: string | null;
      summary: string;
      /** League games committed by this pass; callers own cache invalidation. */
      imported: number;
    };

type RunOptions = {
  source: AutomationSource;
  signal?: AbortSignal;
  /** Focused test seams; production callers use the defaults. */
  db?: AutomationDb;
  worker?: AutomationWorker;
  now?: () => number;
  token?: string;
};

type AcquireOptions = {
  source: AutomationSource;
  nowMs?: number;
  token?: string;
  db?: AutomationDb;
};

type FinalizeOptions = {
  lease: AutomationLease;
  status: AutomationFinalStatus;
  startedAtMs: number;
  finishedAtMs?: number;
  summary: string;
  errorCode?: string | null;
  db?: AutomationDb;
};

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_CODES = 12;

function safeCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : null;
}

function safeCodes(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map(safeCode).filter((v): v is string => !!v))].slice(
    0,
    MAX_CODES,
  );
}

function boundedJson(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= AUTOMATION_SUMMARY_MAX_BYTES) {
    return serialized;
  }
  return JSON.stringify({ truncated: true });
}

function runningSummary(
  source: AutomationSource,
  recoveredExpiredLease: boolean,
): string {
  return boundedJson({ source, recoveredExpiredLease });
}

function outcomeSummary(
  source: AutomationSource,
  outcome: AutomationWorkerOutcome,
  recoveredExpiredLease: boolean,
): string {
  const cursor =
    typeof outcome.cursor === "string" &&
    outcome.cursor.length <= 64 &&
    Number.isFinite(Date.parse(outcome.cursor))
      ? outcome.cursor
      : null;
  const issues = safeCodes(outcome.issues);
  const skipped = safeCodes(outcome.skipped);
  return boundedJson({
    source,
    recoveredExpiredLease,
    imported:
      Number.isSafeInteger(outcome.imported) && outcome.imported >= 0
        ? outcome.imported
        : 0,
    inhouse: outcome.inhouse === true,
    draft: outcome.draft === true,
    playoff: outcome.playoff === true,
    watch: outcome.watch === true,
    cursor,
    issueCount: outcome.issues?.length ?? 0,
    issues,
    skippedCount: outcome.skipped?.length ?? 0,
    skipped,
  });
}

function failureSummary(
  source: AutomationSource,
  recoveredExpiredLease: boolean,
  errorCode: string,
): string {
  return boundedJson({ source, recoveredExpiredLease, errorCode });
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = safeCode((error as { code?: unknown }).code);
    if (code) return code;
  }
  return "AUTOMATION_FAILED";
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function leaseRetrySeconds(leaseExpiresAt: Date | null, nowMs: number): number {
  if (!leaseExpiresAt) return 1;
  return Math.max(1, Math.ceil((leaseExpiresAt.getTime() - nowMs) / 1_000));
}

/**
 * Atomically elect one runner across every application instance. A stale
 * RUNNING row is claimed separately so the abandoned execution is counted as
 * a failure before the replacement starts.
 */
export async function acquireAutomationLease(
  options: AcquireOptions,
): Promise<AutomationLease | AutomationLeaseHeld> {
  if (options.source !== "CRON" && options.source !== "ADMIN") {
    throw new Error("Unsupported automation source");
  }
  const db = options.db ?? prisma;
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const proposedToken = options.token ?? randomUUID();
  const token = /^[A-Za-z0-9-]{1,128}$/.test(proposedToken)
    ? proposedToken
    : randomUUID();
  const leaseExpiresAt = new Date(nowMs + AUTOMATION_LEASE_MS);
  const staleLease = {
    OR: [
      { leaseExpiresAt: null },
      { leaseExpiresAt: { lt: now } },
    ],
  };
  const commonData = {
    leaseToken: token,
    leaseOwner: options.source,
    leaseExpiresAt,
    lastAttemptAt: now,
    lastStartedAt: now,
    lastStatus: "RUNNING",
    lastSource: options.source,
    lastErrorCode: null,
  } as const;

  const recovered = await db.automationRunState.updateMany({
    where: {
      key: AUTOMATION_RUN_KEY,
      lastStatus: "RUNNING",
      ...staleLease,
    },
    data: {
      ...commonData,
      lastFailureAt: now,
      consecutiveFailures: { increment: 1 },
      lastSummary: runningSummary(options.source, true),
    },
  });
  if (recovered.count === 1) {
    return {
      kind: "acquired",
      token,
      owner: options.source,
      leaseExpiresAt,
      recoveredExpiredLease: true,
    };
  }

  // Test seam for the only two-statement election gap: a delayed contender
  // can change an idle row to RUNNING after the recovery probe above. The
  // normal claim below must re-assert non-RUNNING, even if that contender's
  // lease is already expired by this caller's clock, so its abandoned attempt
  // is counted by the recovery path rather than silently overwritten.
  await raceHook("automation.acquire.afterRecoveryProbe");

  const claimed = await db.automationRunState.updateMany({
    where: {
      key: AUTOMATION_RUN_KEY,
      lastStatus: { not: "RUNNING" },
      ...staleLease,
    },
    data: {
      ...commonData,
      lastSummary: runningSummary(options.source, false),
    },
  });
  if (claimed.count === 1) {
    return {
      kind: "acquired",
      token,
      owner: options.source,
      leaseExpiresAt,
      recoveredExpiredLease: false,
    };
  }

  try {
    await db.automationRunState.create({
      data: {
        key: AUTOMATION_RUN_KEY,
        ...commonData,
        lastSummary: runningSummary(options.source, false),
      },
    });
    return {
      kind: "acquired",
      token,
      owner: options.source,
      leaseExpiresAt,
      recoveredExpiredLease: false,
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  const current = await db.automationRunState.findUnique({
    where: { key: AUTOMATION_RUN_KEY },
    select: { leaseExpiresAt: true },
  });
  return { kind: "lease-held", leaseExpiresAt: current?.leaseExpiresAt ?? null };
}

/**
 * Finish only the lease this process owns. Token + owner are both predicates,
 * so a timed-out worker cannot clear or overwrite a replacement run.
 */
export async function finalizeAutomationLease(
  options: FinalizeOptions,
): Promise<boolean> {
  const db = options.db ?? prisma;
  const finishedAtMs = options.finishedAtMs ?? Date.now();
  const finishedAt = new Date(finishedAtMs);
  const durationMs = Math.max(
    0,
    Math.min(2_147_483_647, Math.round(finishedAtMs - options.startedAtMs)),
  );
  const commonData = {
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastFinishedAt: finishedAt,
    lastStatus: options.status,
    lastDurationMs: durationMs,
    lastErrorCode: options.errorCode ?? null,
    lastSummary:
      Buffer.byteLength(options.summary, "utf8") <= AUTOMATION_SUMMARY_MAX_BYTES
        ? options.summary
        : boundedJson({ truncated: true }),
  } as const;
  const data =
    options.status === "SUCCEEDED"
      ? {
          ...commonData,
          lastSuccessAt: finishedAt,
          consecutiveFailures: 0,
        }
      : {
          ...commonData,
          lastFailureAt: finishedAt,
          consecutiveFailures: { increment: 1 },
        };

  const finalized = await db.automationRunState.updateMany({
    where: {
      key: AUTOMATION_RUN_KEY,
      leaseToken: options.lease.token,
      leaseOwner: options.lease.owner,
    },
    data,
  });
  return finalized.count === 1;
}

/** Run one bounded maintenance pass under the database-global lease. */
export async function runAutomation(
  options: RunOptions,
): Promise<AutomationRunResult> {
  const db = options.db ?? prisma;
  const clock = options.now ?? Date.now;
  const startedAtMs = clock();
  const lease = await acquireAutomationLease({
    source: options.source,
    nowMs: startedAtMs,
    token: options.token,
    db,
  });
  if (lease.kind === "lease-held") {
    return {
      kind: "lease-held",
      status: "RUNNING",
      leaseExpiresAt: lease.leaseExpiresAt,
      retryAfterSeconds: leaseRetrySeconds(lease.leaseExpiresAt, clock()),
    };
  }

  const deadlineMs = startedAtMs + AUTOMATION_WORK_BUDGET_MS;
  const controller = new AbortController();
  let budgetExpired = false;
  const expireBudget = () => {
    budgetExpired = true;
    controller.abort(new Error("automation work budget exhausted"));
  };
  const timeout = setTimeout(expireBudget, AUTOMATION_WORK_BUDGET_MS);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  const worker: AutomationWorker = options.worker ?? runResultSync;
  try {
    const outcome = await worker({ deadlineMs, signal: controller.signal });
    const finishedAtMs = clock();
    if (finishedAtMs >= deadlineMs) budgetExpired = true;
    const degraded =
      budgetExpired ||
      (outcome.issues?.length ?? 0) > 0 ||
      (outcome.skipped?.length ?? 0) > 0;
    const status: AutomationFinalStatus = degraded ? "DEGRADED" : "SUCCEEDED";
    const code = budgetExpired
      ? "WORK_BUDGET_EXHAUSTED"
      : degraded
        ? "WORKER_DEGRADED"
        : null;
    const summary = outcomeSummary(
      options.source,
      outcome,
      lease.recoveredExpiredLease,
    );
    const finalized = await finalizeAutomationLease({
      lease,
      status,
      startedAtMs,
      finishedAtMs,
      summary,
      errorCode: code,
      db,
    });
    return {
      kind: finalized ? "completed" : "fenced",
      status,
      durationMs: Math.max(0, Math.round(finishedAtMs - startedAtMs)),
      recoveredExpiredLease: lease.recoveredExpiredLease,
      errorCode: code,
      summary,
      imported:
        Number.isSafeInteger(outcome.imported) && outcome.imported >= 0
          ? outcome.imported
          : 0,
    };
  } catch (error) {
    const finishedAtMs = clock();
    const callerAborted = options.signal?.aborted === true && !budgetExpired;
    const status: AutomationFinalStatus = budgetExpired ? "DEGRADED" : "FAILED";
    const code = budgetExpired
      ? "WORK_BUDGET_EXHAUSTED"
      : callerAborted
        ? "REQUEST_ABORTED"
        : errorCode(error);
    const summary = failureSummary(
      options.source,
      lease.recoveredExpiredLease,
      code,
    );
    const finalized = await finalizeAutomationLease({
      lease,
      status,
      startedAtMs,
      finishedAtMs,
      summary,
      errorCode: code,
      db,
    });
    return {
      kind: finalized ? "completed" : "fenced",
      status,
      durationMs: Math.max(0, Math.round(finishedAtMs - startedAtMs)),
      recoveredExpiredLease: lease.recoveredExpiredLease,
      errorCode: code,
      summary,
      imported: 0,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
