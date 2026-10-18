import { afterEach, describe, expect, it, vi } from "vitest";
import { requestSignal } from "./request-signal";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("requestSignal", () => {
  it("aborts once the timeout passes, and not before", () => {
    vi.useFakeTimers();
    const { signal } = requestSignal(1_000);
    vi.advanceTimersByTime(999);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
  });

  it("aborts as soon as any cancel signal does", () => {
    const mount = new AbortController();
    const action = new AbortController();
    const { signal } = requestSignal(60_000, mount.signal, undefined, action.signal);
    expect(signal.aborted).toBe(false);
    action.abort();
    expect(signal.aborted).toBe(true);
  });

  it("starts aborted when a cancel already has", () => {
    const gone = new AbortController();
    gone.abort();
    expect(requestSignal(60_000, gone.signal).signal.aborted).toBe(true);
  });

  it("done() stops the timer and unhooks every cancel", () => {
    vi.useFakeTimers();
    const mount = new AbortController();
    const remove = vi.spyOn(mount.signal, "removeEventListener");
    const { signal, done } = requestSignal(1_000, mount.signal);
    done();
    vi.advanceTimersByTime(5_000);
    mount.abort();
    expect(signal.aborted).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  // Safari before 17.4 has no AbortSignal.any (and calling it throws): the
  // panel's every read failed on it.
  it("works where AbortSignal.any and AbortSignal.timeout don't exist", () => {
    vi.stubGlobal(
      "AbortSignal",
      Object.assign(function AbortSignal() {}, { any: undefined, timeout: undefined }),
    );
    const cancel = new AbortController();
    const { signal } = requestSignal(60_000, cancel.signal);
    cancel.abort();
    expect(signal.aborted).toBe(true);
  });
});
