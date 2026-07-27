import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A source-level guard, deliberately.
//
// Both live rooms freeze the same way without a fetch deadline: the poll loop
// latches `inFlight` and the action handler latches `pending`, and BOTH are
// released only in the awaited call's `finally`. A request that connects and
// never answers therefore settles nothing — the poll loop stops ticking on
// stale state with `disconnected` FALSE, or every control in the room stays
// disabled — until the player reloads. Neither path fails loudly; that is the
// whole problem with it.
//
// `e2e/zz3-room-poll-resilience.spec.ts` proves the mechanism end-to-end (it
// hangs a route and watches the room recover), but a browser test can only
// reach the call sites that are on screen in the state that spec can reach.
// The regression to catch is someone deleting a `signal:` line from ANY of
// them, so the check that actually covers the invariant is a static one over
// both files. It costs a millisecond and cannot flake.
//
// `vitest.config.mts` is `environment: "node"` with no jsdom, so reading the
// source is also the only way to assert anything about these components here.

const ROOMS = ["draft-room.tsx", "inhouse-room.tsx"] as const;

/** Every `fetch(...)` call in `src`, returned as its full argument text. */
function fetchCalls(src: string): string[] {
  const calls: string[] = [];
  const needle = "fetch(";
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) break;
    from = at + needle.length;
    // Skip identifiers that merely END in "fetch(" (prefetch(, refetch(…).
    const before = src[at - 1] ?? " ";
    if (/[A-Za-z0-9_$.]/.test(before)) continue;
    // Walk forward balancing parens to the end of the call.
    let depth = 1;
    let i = from;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") depth -= 1;
      i += 1;
    }
    calls.push(src.slice(from, i - 1));
  }
  return calls;
}

describe("live-room fetch deadlines", () => {
  for (const file of ROOMS) {
    it(`${file}: every fetch carries an AbortSignal`, () => {
      const src = readFileSync(
        path.join(process.cwd(), "src/components", file),
        "utf8",
      );
      const calls = fetchCalls(src);
      // Both rooms poll and act, so anything less means the parser missed one.
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const call of calls) {
        expect(
          call.includes("signal:"),
          `A fetch in ${file} has no signal — a request that never answers ` +
            `freezes this room with no visible failure. Add ` +
            `signal: AbortSignal.timeout(...). Call was: ${call.slice(0, 120)}`,
        ).toBe(true);
      }
    });
  }
});
