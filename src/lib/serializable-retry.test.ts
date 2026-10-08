import { afterEach, describe, expect, it, vi } from "vitest";
import {
  retrySerializable,
  serializableRetryDelayMs,
  waitBeforeSerializableRetry,
} from "./serializable-retry";

// Shaped like Prisma's PrismaClientKnownRequestError: an Error carrying
// `code` and optional `meta`.
function prismaError(code: string, meta?: Record<string, unknown>) {
  return Object.assign(new Error(`Prisma ${code}`), { code, meta });
}

describe("serializableRetryDelayMs", () => {
  it("waits between half and all of a window that doubles with each retry", () => {
    const retries = [1, 2, 3, 4, 5];
    expect(retries.map((r) => serializableRetryDelayMs(r, 0))).toEqual([
      5, 10, 20, 40, 80,
    ]);
    expect(retries.map((r) => serializableRetryDelayMs(r, 0.5))).toEqual([
      8, 15, 30, 60, 120,
    ]);
    expect(retries.map((r) => serializableRetryDelayMs(r, 1))).toEqual([
      10, 20, 40, 80, 160,
    ]);
  });

  it("caps the window, so a long retry budget never sleeps for seconds", () => {
    expect(serializableRetryDelayMs(6, 1)).toBe(250);
    expect(serializableRetryDelayMs(30, 0)).toBe(125);
    expect(serializableRetryDelayMs(30, 1)).toBe(250);
  });

  it("clamps a jitter outside [0, 1]", () => {
    expect(serializableRetryDelayMs(1, -3)).toBe(5);
    expect(serializableRetryDelayMs(1, 7)).toBe(10);
  });
});

describe("waitBeforeSerializableRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits the retry's jittered delay, for loops that can't use retrySerializable", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let waited = false;
    const third = waitBeforeSerializableRetry(3).then(() => {
      waited = true;
    });
    await vi.advanceTimersByTimeAsync(19);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // 20 ms: the third retry's floor
    await third;
    expect(waited).toBe(true);
  });
});

describe("retrySerializable", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the first try's result without waiting", async () => {
    const run = vi.fn().mockResolvedValue("saved");
    await expect(retrySerializable(run)).resolves.toBe("saved");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("waits out the winner's commit before each retry, never retrying at once", async () => {
    // The CI flake: a retry that starts while the winner is still committing
    // reads its rows as in flight and is cancelled against it again.
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const run = vi
      .fn()
      .mockRejectedValueOnce(prismaError("P2034"))
      .mockRejectedValueOnce(prismaError("P2034"))
      .mockResolvedValueOnce("locked");
    const result = retrySerializable(run);

    await vi.advanceTimersByTimeAsync(4);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 5 ms: the first retry's floor
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // 10 ms more: the second's floor
    expect(run).toHaveBeenCalledTimes(3);
    await expect(result).resolves.toBe("locked");
  });

  it("retries a raw query's conflict (P2010 carrying SQLSTATE 40001)", async () => {
    vi.useFakeTimers();
    const run = vi
      .fn()
      .mockRejectedValueOnce(prismaError("P2010", { code: "40001" }))
      .mockResolvedValueOnce("saved");
    const result = retrySerializable(run);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("saved");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last conflict once every try is spent", async () => {
    vi.useFakeTimers();
    const conflict = prismaError("P2034");
    const run = vi.fn().mockRejectedValue(conflict);
    const settled = expect(
      retrySerializable(run, { attempts: 4 }),
    ).rejects.toBe(conflict);
    await vi.runAllTimersAsync();
    await settled;
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("makes three tries by default", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValue(prismaError("P2034"));
    const settled = expect(retrySerializable(run)).rejects.toMatchObject({
      code: "P2034",
    });
    await vi.runAllTimersAsync();
    await settled;
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("never retries any other failure", async () => {
    const refusal = new Error("That proposal is gone");
    const run = vi.fn().mockRejectedValue(refusal);
    await expect(retrySerializable(run)).rejects.toBe(refusal);
    expect(run).toHaveBeenCalledTimes(1);
    const duplicate = prismaError("P2002");
    const insert = vi.fn().mockRejectedValue(duplicate);
    await expect(retrySerializable(insert)).rejects.toBe(duplicate);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
