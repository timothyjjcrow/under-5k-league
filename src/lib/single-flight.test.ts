import { expect, it, vi } from "vitest";
import { createSingleFlight } from "./single-flight";

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("bounds pending keys while completing overflow work and sharing existing keys", async () => {
  const refresh = vi.fn();
  const singleFlight = createSingleFlight<string>(refresh, 1);
  const first = deferred();
  const load = vi.fn(() => first.promise);
  const firstRead = singleFlight("first", load);
  const shared = singleFlight("first", load);
  const overflow = vi.fn(async () => "complete overflow result");
  const overflowReads = [singleFlight("overflow", overflow), singleFlight("overflow", overflow)];
  expect(shared).toBe(firstRead);
  expect(await Promise.all(overflowReads)).toEqual([
    "complete overflow result", "complete overflow result",
  ]);
  expect(overflow).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(1);
  expect(refresh.mock.calls.map(([shared]) => shared)).toEqual([false, true, false, false]);
  first.resolve("complete first result");
  expect(await firstRead).toBe("complete first result");
  const next = deferred();
  const nextRead = singleFlight("overflow", () => next.promise);
  expect(singleFlight("overflow", overflow)).toBe(nextRead);
  next.resolve("new tracked result");
  expect(await nextRead).toBe("new tracked result");
});

it("releases rejected tracked work and propagates untracked failures", async () => {
  const singleFlight = createSingleFlight<string>(undefined, 1);
  const failed = deferred();
  const first = singleFlight("first", () => failed.promise);
  await expect(singleFlight("overflow", async () => { throw new Error("overflow failure"); }))
    .rejects.toThrow("overflow failure");
  failed.reject(new Error("tracked failure"));
  await expect(first).rejects.toThrow("tracked failure");
  const retry = deferred();
  const retryRead = singleFlight("retry", () => retry.promise);
  expect(singleFlight("retry", async () => "wrong")).toBe(retryRead);
  retry.resolve("recovered");
  expect(await retryRead).toBe("recovered");
});
