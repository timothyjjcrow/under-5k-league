import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// SOURCE-LEVEL GUARDS for the two live rooms, deliberately.
//
// Everything here protects an invariant that no unit test and no browser spec
// can see: a deleted line, a re-inlined rule, a call moved to the wrong side of
// an await. `vitest.config.mts` is `environment: "node"` with no jsdom, so
// reading the source is also the only way to assert anything about a .tsx
// component in this project at all.
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

const read = (file: string) =>
  readFileSync(path.join(process.cwd(), "src/components", file), "utf8");

/**
 * The file with whole-line comments dropped. The literals these guards look
 * for are also QUOTED in the comments that explain the bugs they prevent —
 * "re-fired the chime and the '(!) Your pick' title" is exactly the sentence
 * worth keeping — and a guard that forbade writing about the thing it protects
 * would just get the explanation deleted.
 */
const code = (file: string) =>
  read(file)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("live-room fetch deadlines", () => {
  for (const file of ROOMS) {
    it(`${file}: every fetch carries an AbortSignal`, () => {
      const src = read(file);
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

// The sitewide result-sync ping is the one client poll loop OUTSIDE the two
// rooms, and it froze the same way: its fetch had no deadline, so a request
// that connected and never answered latched `inFlight` forever and that tab
// never synced again — silently, since the ping renders nothing at all.
describe("result-sync ping fetch deadline", () => {
  it("result-sync-ping.tsx: every fetch carries an AbortSignal", () => {
    const src = read("result-sync-ping.tsx");
    const calls = fetchCalls(src);
    // Anti-vacuous: a ping that stops fetching entirely must fail here too.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(
        call.includes("signal:"),
        `The /api/sync fetch in result-sync-ping.tsx has no signal — a hung ` +
          `request freezes the tab's sync loop with no visible failure. Add ` +
          `signal: AbortSignal.timeout(...). Call was: ${call.slice(0, 120)}`,
      ).toBe(true);
    }
  });
});

// Same kind of guard, for the same reason: these rules are unit-tested now,
// but a test of a pure function proves nothing if the room stops calling it.
// The failure mode this repo has actually hit is a policy re-inlined into a
// component and then drifting from its twin — avgKnownMmr had three copies, and
// one of them made a side render 620 MMR weaker the instant one view replaced
// another.

describe("live rooms delegate their poll policy", () => {
  it("result-sync-ping decides refresh/delay only through syncPingStep", () => {
    const src = code("result-sync-ping.tsx");
    expect(src).toContain("syncPingStep(");
    // The rule's subtle halves (first-response baseline, null keeps it) live
    // in the tested pure function; a re-inlined copy is a copy that drifts.
    expect(
      src.includes("cursorAdvanced"),
      `result-sync-ping.tsx has re-inlined its cursor rule — the decision ` +
        `must come from syncPingStep, where the parked-tab trigger is pinned.`,
    ).toBe(false);
  });

  it("inhouse-room computes its cadence only through inhousePollCadence", () => {
    const src = code("inhouse-room.tsx");
    expect(src).toContain("inhousePollCadence(");
    // The room legitimately names other INHOUSE constants (the lobby prefix,
    // the voice channels); the poll rates are the ones that must live in the
    // helper, where the 429 back-off and the hidden-tab keepalive are pinned.
    for (const rate of ["INHOUSE.POLL_IDLE_MS", "INHOUSE.POLL_KEEPALIVE_MS"]) {
      expect(
        src.includes(rate),
        `${rate} is back in inhouse-room.tsx — schedule() must take its delay ` +
          `from inhousePollCadence so the rules stay in one tested place.`,
      ).toBe(false);
    }
  });

  it("draft-room computes its cadence only through draftPollCadence", () => {
    const src = code("draft-room.tsx");
    expect(src).toContain("draftPollCadence(");
    for (const rate of [
      "DRAFT_ROOM.POLL_IDLE_MS",
      "DRAFT_ROOM.POLL_KEEPALIVE_MS",
      "DRAFT_ROOM.POLL_RATE_LIMITED_MS",
    ]) {
      expect(
        src.includes(rate),
        `${rate} is back in draft-room.tsx — its ladder used to read a \`live\` ` +
          `flag that is false on every failed poll, which quietly demoted a ` +
          `live auction to the waiting-room rate for the whole outage.`,
      ).toBe(false);
    }
  });
});

describe("live rooms delegate their payload ordering", () => {
  // The gate that drops a poll which left before a mutation and landed after
  // it. No unit test can see WHERE the number is minted, and no browser spec
  // can produce the interleaving on purpose, so this is the only check that a
  // room still routes through the tested fold.
  for (const file of ROOMS) {
    it(`${file}: orders payloads through room-sequence`, () => {
      const src = code(file);
      expect(src).toContain("issueSequence(");
      expect(src).toContain("acceptSequence(");
      expect(
        src.includes("appliedSeqRef"),
        `${file} has re-inlined its ordering gate. It must fold through ` +
          `acceptSequence, or the two rooms drift apart again with nothing ` +
          `able to notice.`,
      ).toBe(false);
    });

    it(`${file}: mints its sequence BEFORE awaiting the fetch`, () => {
      // Ordering is by request START. Move a mint below its `await fetch(...)`
      // and every unit test still passes while the gate degrades into a no-op:
      // responses would arrive already numbered in arrival order, so nothing
      // would ever be rejected.
      const src = read(file);
      const mints = [...src.matchAll(/issueSequence\(/g)].map((m) => m.index!);
      const awaits = [...src.matchAll(/await fetch\(/g)].map((m) => m.index!);
      expect(mints).toHaveLength(2); // the poll and the action path
      expect(awaits.length).toBeGreaterThanOrEqual(2);
      for (const at of awaits) {
        expect(
          mints.some((m) => m < at && at - m < 1500),
          `A fetch in ${file} has no issueSequence() just above it — the ` +
            `sequence must be taken before the request leaves.`,
        ).toBe(true);
      }
    });
  }
});

describe("live rooms delegate their alert triggers", () => {
  it("inhouse-room computes the chime and the tab title through the lib", () => {
    const src = code("inhouse-room.tsx");
    expect(src).toContain("inhouseAlerts(");
    expect(src).toContain("inhouseTitleFlag(");
    // The flag strings must live with the rules that choose them; a copy in
    // the component is a copy that drifts.
    for (const literal of [
      '"(!) Your pick"',
      '"(!) Accept your match"',
      '"(!) Lobby up',
      '"(!) Teams locked"',
    ]) {
      expect(
        src.includes(literal),
        `${literal} is back in inhouse-room.tsx — inhouseTitleFlag owns the ` +
          `priority order, including which nags stop once the player acts.`,
      ).toBe(false);
    }
  });

  it("draft-room computes its title flag through the lib, strip included", () => {
    const src = code("draft-room.tsx");
    expect(src).toContain("draftTitleFlag(");
    expect(src).toContain("stripDraftTitleFlag(");
    for (const literal of ["⏰ Your pick — ", "💸 Outbid — "]) {
      expect(
        src.includes(literal),
        `"${literal}" is back in draft-room.tsx. The room used to hold a ` +
          `hand-copied duplicate of these literals for its strip(), and a ` +
          `one-character drift would have stacked prefixes in the tab forever.`,
      ).toBe(false);
    }
  });

  it("draft-room decides the outbid latch through outbidLatchAfter", () => {
    const src = code("draft-room.tsx");
    expect(src).toContain("outbidLatchAfter(");
    expect(
      src.includes("wasOutbid("),
      `draft-room.tsx calls wasOutbid directly again — the SET half without ` +
        `the CLEAR half is how the banner ends up naming a lot that has moved on.`,
    ).toBe(false);
  });

  it("draft-room builds no feed line of its own", () => {
    const src = code("draft-room.tsx");
    expect(src).toContain("draftFeedDiff(");
    expect(src).toContain("seedDraftFeed(");
    // Constructing a line means deciding what a sale, a nomination or a bid
    // IS — the part with the silent failure modes (a captain read as a sale, a
    // bid line credited to the wrong team, the same nomination logged on every
    // poll). The room may render lines; it may not author them.
    for (const kind of ['kind: "sold"', 'kind: "nominate"', 'kind: "bid"']) {
      expect(
        src.includes(kind),
        `${kind} is back in draft-room.tsx — feed CONTENT belongs in ` +
          `draftFeedDiff, where a test can state what each line means.`,
      ).toBe(false);
    }
  });

  for (const file of ROOMS) {
    it(`${file}: rings the bell from ONE place, and rings from one`, () => {
      // Both rooms now fold a transition into a list of alerts and ring once.
      // Scattered call sites double-strike the same AudioContext when two
      // moments coincide — and, worse, each one is a separate unwritten rule
      // about when the room should make a noise.
      //
      // EXACTLY two, not "at most": collapsing four call sites into one made
      // that line a single point of failure, and a room that rings from NO
      // place is invisible to everything else here — tsc is happy, the alerts
      // list is still computed and tested, and no browser spec can hear audio.
      const calls = code(file).split("playChime()").length - 1;
      expect(
        calls,
        `${file} has ${calls} playChime() call sites. Expected 2: the sound ` +
          `toggle's own confirmation, and the single ring for a transition.`,
      ).toBe(2);
    });

    it(`${file}: rings from the ALERTS it computed, not from one branch`, () => {
      // The other half of the same failure: narrowing the condition to a
      // single trigger (say, only the outbid latch) silences the alerts that
      // reach a player who is not a captain and has nothing else on screen
      // telling them to look — sold, on the block, your turn.
      const src = code(file);
      // Case-insensitive: the draft room rings off a local `alerts`, the
      // inhouse room off `inhouseAlerts(prev, snap).length` inline.
      expect(
        /alerts[\s\S]{0,120}playChime\(\)/i.test(src),
        `${file} rings without consulting its alerts list — the ring must be ` +
          `derived from the tested transition, not from one hand-picked branch.`,
      ).toBe(true);
    });
  }
});
