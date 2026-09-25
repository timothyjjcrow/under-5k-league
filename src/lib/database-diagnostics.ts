import { prismaErrorCode } from "./operational-code";

const ACTIONS = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany",
  "count", "aggregate", "groupBy", "executeRaw", "queryRaw", "runCommandRaw",
]);
const WINDOW_MS = 60_000;
const MAX_KEYS = 128;
const MAX_COUNT = 1_000_000;
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
type Operation = { count: number; totalMs: number; maxMs: number; slow: number; failures: number };

/** Aggregate operation metadata only. Arguments, SQL, error messages, URLs and
 * identities are deliberately not accepted by this interface. Per-process
 * windows are bounded; they are diagnostic samples, not a fleet-wide total. */
export function createDatabaseDiagnostics(models: readonly string[], now = Date.now()) {
  const allowedModels = new Set(models);
  let startedAt = now;
  let operations = new Map<string, Operation>();
  let poolTimeouts = 0;
  let unreachable = 0;
  let otherFailures = 0;
  let refreshes = 0;
  let sharedRefreshes = 0;
  let droppedKeys = 0;
  let maxSnapshotBytes = 0;
  let oversizedSnapshots = 0;
  let providers: Record<string, { count: number; failed: number; totalMs: number }> = {};
  const increment = (value: number) => Math.min(MAX_COUNT, value + 1);

  const snapshot = (at: number) => ({
    windowMs: Math.max(0, at - startedAt),
    operationCount: [...operations.values()].reduce((sum, row) => sum + row.count, 0),
    poolTimeouts, unreachable, otherFailures, refreshes, sharedRefreshes, droppedKeys,
    maxSnapshotBytes, oversizedSnapshots, providers: { ...providers },
    operations: [...operations].sort((a, b) => b[1].totalMs - a[1].totalMs)
      .slice(0, 12).map(([operation, row]) => ({ operation, ...row, totalMs: Math.round(row.totalMs), maxMs: Math.round(row.maxMs) })),
  });
  return {
    allowModels(names: readonly string[]) {
      for (const name of names) allowedModels.add(name);
    },
    record(model: string | undefined, action: string, elapsedMs: number, error?: unknown) {
      const safeModel = model && allowedModels.has(model) ? model : "database";
      const safeAction = ACTIONS.has(action) ? action : "operation";
      const key = `${safeModel}.${safeAction}`;
      // Cardinality limits detail, never the critical failure counters.
      if (error !== undefined) {
        const code = prismaErrorCode(error);
        if (code === "P2024") poolTimeouts = increment(poolTimeouts);
        else if (code === "P1001") unreachable = increment(unreachable);
        else otherFailures = increment(otherFailures);
      }
      if (!operations.has(key) && operations.size >= MAX_KEYS) {
        droppedKeys = increment(droppedKeys);
        return;
      }
      const row = operations.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, slow: 0, failures: 0 };
      const duration = Math.min(300_000, finite(elapsedMs) ?? 0);
      row.count = increment(row.count);
      row.totalMs = Math.min(Number.MAX_SAFE_INTEGER, row.totalMs + duration);
      row.maxMs = Math.max(row.maxMs, duration);
      if (duration >= 1_000) row.slow = increment(row.slow);
      if (error !== undefined) {
        row.failures = increment(row.failures);
      }
      operations.set(key, row);
    },
    refresh(shared: boolean) {
      if (shared) sharedRefreshes = increment(sharedRefreshes);
      else refreshes = increment(refreshes);
    },
    snapshotSize(bytes: number) {
      const size = finite(bytes) ?? 0;
      maxSnapshotBytes = Math.max(maxSnapshotBytes, size);
      // Match public-game-cache-policy's envelope budget.
      if (size > 1_900_000) oversizedSnapshots = increment(oversizedSnapshots);
    },
    provider(kind: "match" | "recent" | "league", elapsedMs: number, success: boolean) {
      if (!["match", "recent", "league"].includes(kind)) return;
      const row = providers[kind] ?? { count: 0, failed: 0, totalMs: 0 };
      providers = { ...providers, [kind]: {
        count: increment(row.count),
        failed: success ? row.failed : increment(row.failed),
        totalMs: Math.min(Number.MAX_SAFE_INTEGER, row.totalMs + Math.min(300_000, finite(elapsedMs) ?? 0)),
      } };
    },
    snapshot,
    drain(at: number) {
      if (at - startedAt < WINDOW_MS || operations.size === 0) return null;
      const value = snapshot(at);
      startedAt = at;
      operations = new Map();
      poolTimeouts = unreachable = otherFailures = refreshes = sharedRefreshes = droppedKeys = 0;
      maxSnapshotBytes = oversizedSnapshots = 0;
      providers = {};
      return value;
    },
  };
}

/** Prisma 5's engine metrics contain labels/descriptions. Return only a fixed
 * allowlist of numeric counters and pool histograms; never forward raw data. */
export function safePoolMetrics(input: unknown) {
  const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const metric = (group: string, key: string): unknown => {
    const rows = data[group];
    if (!Array.isArray(rows)) return undefined;
    const row = rows.find((row: unknown) => row && typeof row === "object" && (row as { key?: unknown }).key === key);
    return row?.value;
  };
  const histogram = (key: string) => {
    const value = metric("histograms", key);
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return { count: finite(row.count), totalMs: finite(row.sum) };
  };
  return {
    queries: finite(metric("counters", "prisma_client_queries_total")),
    databaseStatements: finite(metric("counters", "prisma_datasource_queries_total")),
    queriesWaiting: finite(metric("gauges", "prisma_client_queries_wait")),
    connectionsOpen: finite(metric("gauges", "prisma_pool_connections_open")),
    connectionsBusy: finite(metric("gauges", "prisma_pool_connections_busy")),
    connectionWait: histogram("prisma_client_queries_wait_histogram_ms"),
    queryDuration: histogram("prisma_client_queries_duration_histogram_ms"),
  };
}
