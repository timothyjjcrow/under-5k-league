import { afterEach, describe, expect, it, vi } from "vitest";
import { createPoolMetricsReader } from "./pool-diagnostics";

describe("pool sampling cannot delay queries indefinitely", () => {
  afterEach(() => vi.useRealTimers());
  it("bounds a hung engine and shares its one outstanding read across retries", async () => {
    vi.useFakeTimers();
    let finish!: (data: unknown) => void;
    const read = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const sample = createPoolMetricsReader(read);
    const first = sample();
    const second = sample();
    await vi.advanceTimersByTimeAsync(250);
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    const retry = sample();
    await vi.advanceTimersByTimeAsync(250);
    expect(await retry).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    finish({ counters: [{ key: "prisma_client_queries_total", value: 1 }] });
    await vi.advanceTimersByTimeAsync(0);
    const recovered = sample();
    await vi.advanceTimersByTimeAsync(0);
    finish({ counters: [{ key: "prisma_client_queries_total", value: 2 }] });
    expect((await recovered)?.queries).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("contains engine failures and clears the sample for recovery", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("PRIVATE_URL"))
      .mockResolvedValueOnce({ gauges: [{ key: "prisma_client_queries_wait", value: 0 }] });
    const sample = createPoolMetricsReader(read);
    expect(await sample()).toBeNull();
    expect((await sample())?.queriesWaiting).toBe(0);
  });
});
