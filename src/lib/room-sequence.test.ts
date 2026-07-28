import { describe, expect, it } from "vitest";
import {
  COLD_START_ATTEMPTS,
  ROOM_SEQUENCE_START,
  acceptSequence,
  isColdStart,
  issueSequence,
} from "./room-sequence";

// The gate that decides whether a settled response is allowed to paint. It was
// copy-pasted into both rooms and asserted by nothing: no unit test (the vitest
// env is `node`, so neither .tsx can be rendered) and no browser spec, because
// the interleaving it exists for is timing-dependent — an accidental one would
// flake, not fail. Every `it` below is an ordering a real draft night produces.

/** Drive a scripted sequence of request starts and settlements. */
function room() {
  let s = ROOM_SEQUENCE_START;
  return {
    /** A request leaves. */
    issue() {
      const { seq, next } = issueSequence(s);
      s = next;
      return seq;
    },
    /** A response settles; true = it painted. */
    settle(seq: number) {
      const { accept, next } = acceptSequence(s, seq);
      s = next;
      return accept;
    },
    get state() {
      return s;
    },
  };
}

describe("issueSequence", () => {
  it("hands out strictly increasing numbers from 1", () => {
    // The first number ever issued must beat the initial `applied` of 0, or the
    // very first payload would be dropped and the room would never paint.
    const r = room();
    expect([r.issue(), r.issue(), r.issue()]).toEqual([1, 2, 3]);
  });

  it("does not disturb what has already been applied", () => {
    const r = room();
    const a = r.issue();
    r.settle(a);
    r.issue();
    expect(r.state.applied).toBe(a);
  });

  it("never wraps or resets", () => {
    // A modulo would be worse than the hazard it addresses: a wrapped low
    // number would be rejected forever, wedging the room permanently.
    let s = { issued: Number.MAX_SAFE_INTEGER - 2, applied: 0 };
    for (let i = 0; i < 2; i++) s = issueSequence(s).next;
    expect(s.issued).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("acceptSequence", () => {
  it("drops a poll that left before the mutation and landed after it", () => {
    // THE bug. /api/inhouse answers a mutation with syncBoard:false, so the
    // pick response returns while the poll behind it is still blocked on the
    // Discord board edit. Applying that older payload put the drafted player
    // back in the pool, re-fired the chime and the "(!) Your pick" title, and
    // sent the captain re-clicking into an error toast.
    const r = room();
    const poll = r.issue();
    const pick = r.issue();
    expect(r.settle(pick)).toBe(true);
    expect(r.settle(poll)).toBe(false);
  });

  it("applies responses that settle in the order they were issued", () => {
    const r = room();
    const a = r.issue();
    const b = r.issue();
    expect(r.settle(a)).toBe(true);
    expect(r.settle(b)).toBe(true);
  });

  it("drops an older-issued payload even when it is factually NEWER", () => {
    // The accepted cost of ordering by request start: the poll may have been
    // handled after the mutation server-side and carry another captain's bid
    // too. The loss is bounded by one poll interval because the loop always
    // re-fetches — it can never strand.
    const r = room();
    const poll = r.issue(); // left first…
    const act = r.issue();
    r.settle(act);
    expect(r.settle(poll)).toBe(false); // …so it loses, fresher or not
  });

  it("cannot be wedged by requests that mint a number and never paint", () => {
    // A 429, a non-ok response, an aborted fetch, the draft's terminal 404, a
    // rejected bid: five paths burn a number and reach no apply. The gap is
    // harmless because `applied` only moves forward, so the next request is
    // issued strictly above it.
    const r = room();
    r.issue(); // 429
    r.issue(); // aborted by the poll deadline
    const c = r.issue();
    expect(r.settle(c)).toBe(true);
    const d = r.issue();
    expect(r.settle(d)).toBe(true);
  });

  it("keeps `applied` monotonic across any interleaving", () => {
    // The property the whole design rests on: no request can ever be born
    // already-stale, so a dropped response can never stall the next one.
    const r = room();
    const inFlight: number[] = [];
    let applied = 0;
    // Deterministic pseudo-random script (no Math.random — reproducible runs).
    let x = 7;
    for (let i = 0; i < 300; i++) {
      x = (x * 48271) % 2147483647;
      if (x % 3 === 0 && inFlight.length) {
        // Settle an arbitrary in-flight request, not necessarily the oldest.
        const [seq] = inFlight.splice(x % inFlight.length, 1);
        r.settle(seq);
      } else {
        // A request BORN now must outrank everything already painted — that is
        // what guarantees a dropped response can never stall the next one.
        // (An OLDER request still in flight may well be below `applied`; it is
        // supposed to lose.)
        const born = r.issue();
        expect(born).toBeGreaterThan(applied);
        inFlight.push(born);
      }
      expect(r.state.applied).toBeGreaterThanOrEqual(applied);
      expect(r.state.issued).toBeGreaterThanOrEqual(r.state.applied);
      applied = r.state.applied;
    }
  });

  it("re-applies an EQUAL sequence rather than dropping it", () => {
    // Unreachable today (every request mints its own number and no call site
    // applies one response twice) — stated so the `<` in the comparison is a
    // decision on record rather than an accident someone 'tidies' either way.
    const r = room();
    const a = r.issue();
    expect(r.settle(a)).toBe(true);
    expect(r.settle(a)).toBe(true);
  });

  it("leaves the state untouched when it rejects", () => {
    const r = room();
    const stale = r.issue();
    const fresh = r.issue();
    r.settle(fresh);
    const before = r.state;
    r.settle(stale);
    expect(r.state).toEqual(before);
  });

  it("starts from a shared frozen-by-convention value", () => {
    // Both rooms seed their ref from this one object, so nothing may mutate it.
    const r = room();
    r.issue();
    expect(ROOM_SEQUENCE_START).toEqual({ issued: 0, applied: 0 });
  });
});

describe("isColdStart", () => {
  it("is true before anything has been sent", () => {
    // A tab that is HIDDEN at load knows nothing about its viewer yet —
    // `hasStake` is learned from a payload — so it must fetch rather than
    // skip, or a queued captain gets no keepalive and no chime until they
    // happen to look at the tab.
    expect(isColdStart(ROOM_SEQUENCE_START)).toBe(true);
  });

  it("survives a first request that never lands", () => {
    // One attempt is not enough: a single 429 from a shared household IP —
    // the case this endpoint's speed bump exists for — would otherwise spend
    // the whole allowance and strand the tab.
    const r = room();
    r.issue();
    expect(isColdStart(r.state)).toBe(true);
  });

  it("gives up after a few tries rather than retrying forever", () => {
    // The other failure mode: an offline hidden tab must not sit in a
    // background fetch loop for the rest of the session.
    const r = room();
    for (let i = 0; i < COLD_START_ATTEMPTS; i++) r.issue();
    expect(isColdStart(r.state)).toBe(false);
  });

  it("ends the moment a payload actually paints", () => {
    const r = room();
    const seq = r.issue();
    r.settle(seq);
    expect(isColdStart(r.state)).toBe(false);
  });
});
