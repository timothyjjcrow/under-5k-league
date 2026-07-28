import { describe, expect, it } from "vitest";
import { POLL_HEALTH_OK, pollHealthAfter } from "./poll-health";
import { ROOM_POLL_FAIL_THRESHOLD } from "./constants";

// The disconnect gate is the room's last line of honesty: at the threshold
// every control disables and an aria-live strip says the connection is gone.
// Before it existed, both rooms swallowed poll failures — captains watched a
// frozen auction that still looked live while the server sold their player.
// Nothing asserted the rule until this file (the rooms themselves can't be
// rendered here: `environment: node`, no jsdom).

/** Fold a whole sequence of outcomes, the way a poll loop would. */
const run = (outcomes: Array<"ok" | "fail">, threshold?: number) =>
  outcomes.reduce(
    (h, o) => pollHealthAfter(h, o, threshold),
    POLL_HEALTH_OK,
  );

describe("pollHealthAfter", () => {
  it("starts connected", () => {
    expect(POLL_HEALTH_OK).toEqual({ fails: 0, disconnected: false });
  });

  it("tolerates failures below the threshold", () => {
    // A blip on mobile data is normal. Disabling the room for one would be its
    // own outage — on a 45-second ready check, a costly one.
    const h = run(["fail", "fail"]);
    expect(h.fails).toBe(2);
    expect(h.disconnected).toBe(false);
  });

  it("disconnects on the threshold-th consecutive failure", () => {
    expect(run(Array(ROOM_POLL_FAIL_THRESHOLD).fill("fail")).disconnected).toBe(
      true,
    );
  });

  it("STAYS disconnected while failures continue", () => {
    // The flag must never un-set itself by counting past the threshold.
    const h = run(Array(ROOM_POLL_FAIL_THRESHOLD + 7).fill("fail"));
    expect(h.disconnected).toBe(true);
    expect(h.fails).toBe(ROOM_POLL_FAIL_THRESHOLD + 7);
  });

  it("counts CONSECUTIVE failures, not total ones", () => {
    // A flaky-but-alive connection is still a working connection; alternating
    // ok/fail must never lock the room. This is the whole subtlety.
    const h = run(["fail", "fail", "ok", "fail", "fail", "ok", "fail", "fail"]);
    expect(h.fails).toBe(2);
    expect(h.disconnected).toBe(false);
  });

  it("a single success clears a long outage", () => {
    // Recovery is immediate and total — a room that had to recover twice is
    // not more fragile than one recovering for the first time.
    const h = run([...Array(10).fill("fail"), "ok"]);
    expect(h).toEqual(POLL_HEALTH_OK);
  });

  it("reconnects, then needs a FULL fresh run to disconnect again", () => {
    const recovered = run([...Array(5).fill("fail"), "ok"]);
    const oneMore = pollHealthAfter(recovered, "fail");
    expect(oneMore.disconnected).toBe(false);
    expect(
      run([
        ...Array(5).fill("fail"),
        "ok",
        ...Array(ROOM_POLL_FAIL_THRESHOLD).fill("fail"),
      ]).disconnected,
    ).toBe(true);
  });

  it("honours a custom threshold", () => {
    expect(run(["fail"], 1).disconnected).toBe(true);
    expect(run(["fail", "fail", "fail", "fail"], 5).disconnected).toBe(false);
    expect(run(["fail", "fail", "fail", "fail", "fail"], 5).disconnected).toBe(
      true,
    );
  });

  it("never mutates the state handed to it", () => {
    // The hook keeps this in a ref and compares the derived boolean; a reducer
    // that mutated in place would defeat that.
    const start = { fails: 1, disconnected: false };
    pollHealthAfter(start, "fail");
    expect(start).toEqual({ fails: 1, disconnected: false });
  });
});
