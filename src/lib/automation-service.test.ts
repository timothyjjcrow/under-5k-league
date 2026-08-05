import type { AutomationRunState } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_LEASE_MS,
  AUTOMATION_RUN_KEY,
  AUTOMATION_SUMMARY_MAX_BYTES,
  AUTOMATION_WORK_BUDGET_MS,
  acquireAutomationLease,
  finalizeAutomationLease,
  runAutomation,
  type AutomationWorkerOutcome,
} from "./automation-service";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const OUTCOME: AutomationWorkerOutcome = {
  imported: 0,
  inhouse: false,
  draft: false,
  playoff: false,
  watch: false,
  cursor: null,
  issues: [],
  skipped: [],
};

type AutomationDb = NonNullable<Parameters<typeof runAutomation>[0]["db"]>;

function makeState(
  overrides: Partial<AutomationRunState> = {},
): AutomationRunState {
  const createdAt = new Date(NOW - 60_000);
  return {
    key: AUTOMATION_RUN_KEY,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastAttemptAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastStatus: "NEVER",
    lastSource: null,
    lastDurationMs: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastSummary: "{}",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function matchesWhere(
  state: AutomationRunState,
  rawWhere: unknown,
): boolean {
  const where = rawWhere as Record<string, unknown>;
  const record = state as unknown as Record<string, unknown>;
  for (const [key, filter] of Object.entries(where)) {
    if (key === "OR") {
      const clauses = filter as unknown[];
      if (!clauses.some((clause) => matchesWhere(state, clause))) return false;
      continue;
    }
    const current = record[key];
    if (filter === null || typeof filter !== "object" || filter instanceof Date) {
      if (current !== filter) return false;
      continue;
    }
    const comparison = filter as Record<string, unknown>;
    if ("not" in comparison && current === comparison.not) return false;
    if (
      "lt" in comparison &&
      (!(current instanceof Date) ||
        !(comparison.lt instanceof Date) ||
        current.getTime() >= comparison.lt.getTime())
    ) {
      return false;
    }
  }
  return true;
}

function applyData(state: AutomationRunState, rawData: unknown): void {
  const data = rawData as Record<string, unknown>;
  const record = state as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (
      key === "consecutiveFailures" &&
      value &&
      typeof value === "object" &&
      "increment" in value
    ) {
      state.consecutiveFailures += Number(
        (value as { increment: unknown }).increment,
      );
    } else {
      record[key] = value;
    }
  }
  state.updatedAt = new Date();
}

function fakeDb(initial: AutomationRunState | null = null) {
  const memory: { state: AutomationRunState | null } = { state: initial };
  const updateMany = vi.fn(async (args: { where: unknown; data: unknown }) => {
    if (!memory.state || !matchesWhere(memory.state, args.where)) {
      return { count: 0 };
    }
    applyData(memory.state, args.data);
    return { count: 1 };
  });
  const create = vi.fn(async (args: { data: unknown }) => {
    if (memory.state) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    const data = args.data as Partial<AutomationRunState> & { key: string };
    memory.state = makeState(data);
    return memory.state;
  });
  const findUnique = vi.fn(async () => memory.state);
  const db = {
    automationRunState: { updateMany, create, findUnique },
  } as unknown as AutomationDb;
  return { db, memory, updateMany, create, findUnique };
}

describe("automation ownership and health", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("pins the release lease and work budgets", () => {
    expect(AUTOMATION_LEASE_MS).toBe(90_000);
    expect(AUTOMATION_WORK_BUDGET_MS).toBe(45_000);
  });

  it("elects one winner while a concurrent invocation sees the active lease", async () => {
    const store = fakeDb();
    let releaseWorker!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const worker = vi.fn(async () => {
      markStarted();
      await held;
      return OUTCOME;
    });

    const winner = runAutomation({
      source: "CRON",
      db: store.db,
      worker,
      token: "winner-token",
      now: () => NOW,
    });
    await started;
    const rival = await runAutomation({
      source: "CRON",
      db: store.db,
      worker,
      token: "rival-token",
      now: () => NOW,
    });

    expect(rival).toMatchObject({ kind: "lease-held", status: "RUNNING" });
    expect(worker).toHaveBeenCalledTimes(1);
    releaseWorker();
    await expect(winner).resolves.toMatchObject({
      kind: "completed",
      status: "SUCCEEDED",
    });
  });

  it("does not start work while an unexpired lease is active", async () => {
    const store = fakeDb(
      makeState({
        leaseToken: "active-token",
        leaseOwner: "CRON",
        leaseExpiresAt: new Date(NOW + 30_000),
        lastStatus: "RUNNING",
      }),
    );
    const worker = vi.fn(async () => OUTCOME);

    const result = await runAutomation({
      source: "ADMIN",
      db: store.db,
      worker,
      now: () => NOW,
    });

    expect(result).toMatchObject({
      kind: "lease-held",
      retryAfterSeconds: 30,
    });
    expect(worker).not.toHaveBeenCalled();
  });

  it("recovers an expired RUNNING lease and records the abandoned attempt", async () => {
    const store = fakeDb(
      makeState({
        leaseToken: "dead-token",
        leaseOwner: "CRON",
        leaseExpiresAt: new Date(NOW - 1),
        lastStatus: "RUNNING",
        consecutiveFailures: 2,
      }),
    );

    const result = await runAutomation({
      source: "ADMIN",
      db: store.db,
      worker: async () => OUTCOME,
      token: "recovery-token",
      now: () => NOW,
    });

    expect(result).toMatchObject({
      kind: "completed",
      status: "SUCCEEDED",
      recoveredExpiredLease: true,
    });
    expect(store.memory.state).toMatchObject({
      lastStatus: "SUCCEEDED",
      lastSource: "ADMIN",
      consecutiveFailures: 0,
      leaseToken: null,
      leaseOwner: null,
    });
    expect(store.memory.state?.lastFailureAt?.getTime()).toBe(NOW);
    expect(store.memory.state?.lastSummary).toContain(
      '"recoveredExpiredLease":true',
    );
  });

  it("fences an expired worker from finalizing a replacement owner's lease", async () => {
    const store = fakeDb();
    const first = await acquireAutomationLease({
      source: "CRON",
      nowMs: NOW,
      token: "first-token",
      db: store.db,
    });
    expect(first.kind).toBe("acquired");
    const replacement = await acquireAutomationLease({
      source: "ADMIN",
      nowMs: NOW + AUTOMATION_LEASE_MS + 1,
      token: "replacement-token",
      db: store.db,
    });
    expect(replacement.kind).toBe("acquired");
    if (first.kind !== "acquired" || replacement.kind !== "acquired") return;

    const staleFinalized = await finalizeAutomationLease({
      lease: first,
      status: "FAILED",
      startedAtMs: NOW,
      finishedAtMs: NOW + AUTOMATION_LEASE_MS + 2,
      summary: "{}",
      errorCode: "AUTOMATION_FAILED",
      db: store.db,
    });

    expect(staleFinalized).toBe(false);
    expect(store.memory.state?.leaseToken).toBe("replacement-token");
    expect(store.memory.state?.leaseOwner).toBe("ADMIN");
  });

  it("persists a sanitized failure and releases the owned lease", async () => {
    const store = fakeDb();
    const result = await runAutomation({
      source: "CRON",
      db: store.db,
      token: "failure-token",
      now: () => NOW,
      worker: async () => {
        throw new Error("CRON_SECRET=do-not-persist");
      },
    });

    expect(result).toMatchObject({
      kind: "completed",
      status: "FAILED",
      errorCode: "AUTOMATION_FAILED",
    });
    expect(store.memory.state).toMatchObject({
      lastStatus: "FAILED",
      consecutiveFailures: 1,
      lastErrorCode: "AUTOMATION_FAILED",
      leaseToken: null,
      leaseOwner: null,
    });
    expect(store.memory.state?.lastSummary).not.toContain("do-not-persist");
  });

  it("does not persist or return an arbitrary secret-shaped exception code", async () => {
    const store = fakeDb();
    const secretCode = "SECRETLOOKINGTOKEN";
    const result = await runAutomation({
      source: "CRON",
      db: store.db,
      token: "secret-code-token",
      now: () => NOW,
      worker: async () => {
        throw Object.assign(new Error("provider failed"), { code: secretCode });
      },
    });

    expect(result).toMatchObject({
      kind: "completed",
      status: "FAILED",
      errorCode: "AUTOMATION_FAILED",
    });
    expect(JSON.stringify(result)).not.toContain(secretCode);
    expect(JSON.stringify(store.memory.state)).not.toContain(secretCode);
  });

  it("persists bounded safe issue codes as degraded health", async () => {
    const store = fakeDb();
    const result = await runAutomation({
      source: "CRON",
      db: store.db,
      token: "degraded-token",
      now: () => NOW,
      worker: async () => ({
        ...OUTCOME,
        issues: ["LEAGUE_SYNC_FAILED", "SECRETLOOKINGTOKEN", "secret-value?"],
        skipped: ["DRAFT_OFF_PHASE"],
      }),
    });

    expect(result.status).toBe("DEGRADED");
    expect(store.memory.state).toMatchObject({
      lastStatus: "DEGRADED",
      consecutiveFailures: 1,
      lastErrorCode: "WORKER_DEGRADED",
    });
    expect(store.memory.state?.lastSummary).toContain("LEAGUE_SYNC_FAILED");
    expect(store.memory.state?.lastSummary).not.toContain(
      "SECRETLOOKINGTOKEN",
    );
    expect(store.memory.state?.lastSummary).not.toContain("secret-value");
    expect(
      Buffer.byteLength(store.memory.state?.lastSummary ?? "", "utf8"),
    ).toBeLessThanOrEqual(AUTOMATION_SUMMARY_MAX_BYTES);
  });

  it("reports budget-deferred work as degraded even before the hard timer fires", async () => {
    const store = fakeDb();
    const result = await runAutomation({
      source: "CRON",
      db: store.db,
      token: "deferred-token",
      now: () => NOW,
      worker: async () => ({
        ...OUTCOME,
        skipped: ["NOTIFICATIONS_BUDGET_EXHAUSTED"],
      }),
    });

    expect(result).toMatchObject({
      status: "DEGRADED",
      errorCode: "WORKER_DEGRADED",
    });
    expect(store.memory.state).toMatchObject({
      lastStatus: "DEGRADED",
      consecutiveFailures: 1,
      lastErrorCode: "WORKER_DEGRADED",
    });
  });
});
