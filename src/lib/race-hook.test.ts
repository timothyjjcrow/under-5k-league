import { afterEach, describe, expect, it, vi } from "vitest";
import { onceAt, raceHook, setRaceHook } from "./race-hook";

// The seam is what every fault-injected claim test now leans on, so its own
// three guarantees need pinning: it is INERT in production, it is INERT with
// nothing installed, and `onceAt` fires exactly once for exactly its label.
// A seam that quietly stopped firing would not fail anything — the tests built
// on it would simply stop testing what they claim to (the vacuous-pass problem
// their `fired` flags exist for, one level down).

afterEach(() => {
  // Restore NODE_ENV BEFORE clearing: setRaceHook refuses to run at all under a
  // stubbed env, so the other order leaves the stub in place and every later
  // test in the file dies on a hook it was never allowed to install.
  vi.unstubAllEnvs();
  setRaceHook(null);
});

describe("setRaceHook", () => {
  it("refuses to arm outside NODE_ENV=test", () => {
    // The whole safety argument for shipping this file is that no running app
    // can install a hook that pauses a transaction mid-flight.
    vi.stubEnv("NODE_ENV", "production");
    expect(() => setRaceHook(() => {})).toThrow(/test-only/);
    vi.stubEnv("NODE_ENV", "development");
    expect(() => setRaceHook(() => {})).toThrow(/test-only/);
  });

  it("refuses even to CLEAR outside NODE_ENV=test", () => {
    // Not a nicety: if clearing were allowed the check would read as
    // "null is safe", inviting a production caller to prove it by passing one.
    vi.stubEnv("NODE_ENV", "production");
    expect(() => setRaceHook(null)).toThrow(/test-only/);
  });
});

describe("raceHook", () => {
  it("is a no-op with no hook installed", async () => {
    await expect(raceHook("anything")).resolves.toBeUndefined();
  });

  it("passes the label through and AWAITS an async hook", async () => {
    // Awaiting is the entire point: the rival must COMMIT before the caller's
    // guarded write runs. A fire-and-forget seam would produce the ordering it
    // was built to eliminate.
    const order: string[] = [];
    const seen: string[] = [];
    setRaceHook(async (label) => {
      seen.push(label);
      await new Promise((r) => setTimeout(r, 5));
      order.push("hook");
    });
    await raceHook("svc.beforeClaim");
    order.push("after");
    expect(seen).toEqual(["svc.beforeClaim"]);
    expect(order).toEqual(["hook", "after"]);
  });

  it("stops firing once cleared", async () => {
    let calls = 0;
    setRaceHook(() => {
      calls += 1;
    });
    await raceHook("a");
    setRaceHook(null);
    await raceHook("a");
    expect(calls).toBe(1);
  });
});

describe("onceAt", () => {
  it("fires exactly once for its label, however often the seam is reached", async () => {
    // Hooked call sites are usually reached again (a retry loop, the next
    // pick). A second rival landing there would confuse the assertion the test
    // is actually making.
    let calls = 0;
    setRaceHook(
      onceAt("svc.beforeClaim", async () => {
        calls += 1;
      }),
    );
    await raceHook("svc.beforeClaim");
    await raceHook("svc.beforeClaim");
    await raceHook("svc.beforeClaim");
    expect(calls).toBe(1);
  });

  it("ignores every other label", async () => {
    // Services carry several seams; a hook that fired on a neighbour's label
    // would commit its rival at the wrong instant entirely.
    let calls = 0;
    setRaceHook(
      onceAt("svc.beforeClaim", async () => {
        calls += 1;
      }),
    );
    await raceHook("svc.beforeOtherClaim");
    await raceHook("otherSvc.beforeClaim");
    expect(calls).toBe(0);
    await raceHook("svc.beforeClaim");
    expect(calls).toBe(1);
  });

  it("only disarms once the run it started has been AWAITED", async () => {
    // `fired` is set before the await, so two seams reached concurrently
    // cannot both start the rival — the second sees the latch, not a
    // half-finished run.
    let running = 0;
    let overlaps = 0;
    const hook = onceAt("svc.beforeClaim", async () => {
      running += 1;
      if (running > 1) overlaps += 1;
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
    });
    setRaceHook(hook);
    await Promise.all([raceHook("svc.beforeClaim"), raceHook("svc.beforeClaim")]);
    expect(overlaps).toBe(0);
  });
});
