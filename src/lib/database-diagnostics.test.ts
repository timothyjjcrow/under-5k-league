import { describe, expect, it } from "vitest";
import { createDatabaseDiagnostics, safePoolMetrics } from "./database-diagnostics";

describe("bounded database diagnostics", () => {
  it("separates pool exhaustion from unreachable databases without serializing errors", () => {
    const diagnostics = createDatabaseDiagnostics(["Game"], 0);
    diagnostics.record("Game", "findMany", 10_004, { code: "P2024", message: "SECRET_DATABASE_URL", meta: { query: "PRIVATE_QUERY" } });
    diagnostics.record("Game", "findMany", 5_000, { code: "P1001" });
    diagnostics.record("SECRET_MODEL", "PRIVATE_SQL", 100, { code: "SECRET_CODE" });
    const sample = diagnostics.drain(60_000)!;
    expect(sample).toMatchObject({ operationCount: 3, poolTimeouts: 1, unreachable: 1, otherFailures: 1 });
    expect(sample.operations[0]).toMatchObject({ operation: "Game.findMany", slow: 2, maxMs: 10_004 });
    expect(JSON.stringify(sample)).not.toMatch(/SECRET|PRIVATE/);
    expect(diagnostics.drain(120_000)).toBeNull();
  });

  it("bounds emission and metric cardinality under sustained load", () => {
    const models = Array.from({ length: 200 }, (_, i) => `Model${i}`);
    const diagnostics = createDatabaseDiagnostics(models, 0);
    for (const model of models) diagnostics.record(model, "findMany", 1, { code: "P2024" });
    diagnostics.refresh(false);
    diagnostics.refresh(true);
    expect(diagnostics.drain(59_999)).toBeNull();
    const sample = diagnostics.drain(60_000)!;
    expect(sample.operations).toHaveLength(12);
    expect(sample).toMatchObject({ operationCount: 128, droppedKeys: 72, poolTimeouts: 200, refreshes: 1, sharedRefreshes: 1 });
    diagnostics.record("Model0", "findMany", Number.NaN);
    expect(diagnostics.drain(60_001)).toBeNull();
    expect(diagnostics.drain(120_000)?.operationCount).toBe(1);
  });

  it("exports only approved pool numbers and distinguishes missing from zero", () => {
    const data = safePoolMetrics({
      gauges: [{ key: "prisma_pool_connections_busy", value: 0, labels: { password: "SECRET" } }],
      counters: [{ key: "prisma_client_queries_total", value: 12 }],
      histograms: [{ key: "prisma_client_queries_wait_histogram_ms", value: { count: 3, sum: 205, labels: "PRIVATE" } }],
      databaseUrl: "SECRET",
    });
    expect(data).toMatchObject({ queries: 12, queriesWaiting: null, connectionsBusy: 0, connectionWait: { count: 3, totalMs: 205 } });
    expect(JSON.stringify(data)).not.toMatch(/SECRET|PRIVATE|password|databaseUrl/);
    expect(safePoolMetrics({ gauges: [{ key: "prisma_pool_connections_busy", value: Infinity }] }).connectionsBusy).toBeNull();
  });
});
