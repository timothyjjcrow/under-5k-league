import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  sourceFile,
  sourceFiles,
  stripLineComments,
  type SourceFile,
} from "../../test/support/source-files";

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
// both rooms' files. It costs a millisecond and cannot flake.
//
// `vitest.config.mts` is `environment: "node"` with no jsdom, so reading the
// source is also the only way to assert anything about these components here.

/**
 * The two live rooms, each as the files it is made of. The draft room is one
 * file. The inhouse room is a SHELL (the poll loop, act(), the bell, the tab
 * title) plus one file per stage under src/components/inhouse/, and every
 * room guard below reads the shell and that folder TOGETHER as one room: a
 * `signal:` deleted from a stage file, or a second bell rung from one, is the
 * same regression it was when the room was a single file.
 */
type Room = { name: string; shell: string; files: SourceFile[] };

const ROOMS: readonly Room[] = [
  {
    name: "draft-room.tsx",
    shell: "src/components/draft-room.tsx",
    files: [sourceFile("src/components/draft-room.tsx")],
  },
  {
    name: "inhouse-room.tsx",
    shell: "src/components/inhouse-room.tsx",
    // The shell plus its stage views. A renamed folder or a typo'd pattern
    // fails here, loudly, instead of reading nothing.
    files: sourceFiles(
      [
        "src/components/inhouse-room.tsx",
        "src/components/inhouse/**/*.{ts,tsx}",
      ],
      10,
    ),
  },
];
const INHOUSE_ROOM = ROOMS[1];

/** Each of a room's files with whole-line comments dropped (see `code`). */
const roomCode = (room: Room) =>
  room.files.map((f) => stripLineComments(f.text));

/** A room's code as one string, for "the room does X somewhere" checks. */
const roomText = (room: Room) => roomCode(room).join("\n");

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

const appCode = (file: string) =>
  readFileSync(path.join(process.cwd(), "src/app", file), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

/**
 * Every component and page, comments dropped. The "re-inlined" guards below
 * are about a rule escaping its tested lib function into UI code, and that
 * can happen in ANY component — including a new file split out of a room — so
 * they scan all of these, not just the two room files.
 */
const UI_CODE = sourceFiles(
  ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
  120,
).map((f) => ({ path: f.path, code: stripLineComments(f.text) }));

/** UI files (comments dropped) that contain `literal`. */
const uiFilesWith = (literal: string) =>
  UI_CODE.filter((f) => f.code.includes(literal)).map((f) => f.path);

describe("live-room fetch deadlines", () => {
  for (const room of ROOMS) {
    it(`${room.name}: every fetch carries an AbortSignal`, () => {
      const calls = room.files.flatMap((f) =>
        fetchCalls(f.text).map((call) => ({ file: f.path, call })),
      );
      // Both rooms poll and act, so anything less means the parser missed one.
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const { file, call } of calls) {
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

  it("seeds the first heartbeat with the server-rendered result cursor", () => {
    const ping = code("result-sync-ping.tsx");
    const layout = appCode("layout.tsx");

    // The pure interleaving test only protects the comparison rule. This
    // contract guard proves the root Server Component actually supplies the
    // render-time causality boundary and the client uses it on its first tick.
    expect(layout).toContain("getPublicReadSignals()");
    expect(layout).toContain("resultCursorAtRender = publicReadSignals.resultChangedAt");
    expect(layout).toMatch(
      /<ResultSyncPing\s+initialCursor=\{[A-Za-z_$][\w$]*\}\s*\/>/,
    );
    expect(ping).toContain("initialCursor: string | null");
    expect(ping).toContain("let lastCursor: string | null = initialCursor");
  });
});

// The rooms and the ping are the loops this file was written for, but the
// freeze is a property of ANY client fetch whose caller waits on it. Every
// client component's fetch carries a deadline today; keep it that way, so a
// new poll loop (or a room split into several files) cannot slip past.
describe("client fetch deadlines everywhere", () => {
  const clientFetchers = sourceFiles("src/**/*.{ts,tsx}", 300)
    .filter(({ text }) => /^["']use client["']/m.test(text))
    .map(({ path: file, text }) => ({ file, calls: fetchCalls(text) }))
    .filter(({ calls }) => calls.length > 0);

  it("finds the client files that fetch (guard is not vacuous)", () => {
    const files = clientFetchers.map((f) => f.file);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const shell of [
      ...ROOMS.map((room) => room.shell),
      "src/components/result-sync-ping.tsx",
    ]) {
      expect(files).toContain(shell);
    }
  });

  it("every fetch in a client file carries an AbortSignal", () => {
    for (const { file, calls } of clientFetchers) {
      for (const call of calls) {
        expect(
          call.includes("signal:"),
          `A fetch in ${file} has no signal — a request that never answers ` +
            `latches whatever waits on it with no visible failure. Add ` +
            `signal: AbortSignal.timeout(...). Call was: ${call.slice(0, 120)}`,
        ).toBe(true);
      }
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
  for (const room of ROOMS) {
    it(`${room.name}: offline events immediately gate actions until a successful poll`, () => {
      const src = roomText(room);
      expect(src).toContain('window.addEventListener("offline", onOffline)');
      expect(src).toContain('window.addEventListener("online", onOnline)');
      expect(src).toContain('setConnectivity("resyncing")');
      expect(src).toMatch(
        /setConnectivity\(\s*navigator\.onLine === false \? "offline" : "online",?\s*\)/,
      );
      expect(src).toMatch(
        /const pending\s*=\s*[\s\S]{0,120}connectionUnavailable/,
      );
    });

    it(`${room.name}: unknown action outcomes stay locked through a newer successful poll`, () => {
      const src = roomText(room);
      expect(src).toContain("actionReconcileSeqRef");
      expect(src).toContain("setActionReconciling(true)");
      expect(src).toContain("setActionReconciling(false)");
      expect(src).toMatch(/const pending\s*=\s*[\s\S]{0,180}actionReconciling/);
      expect(src).toMatch(/actionSeq\s*!==\s*null\s*&&\s*seq\s*>\s*actionSeq/);
    });
  }

  it("result-sync-ping decides refresh/delay only through syncPingStep", () => {
    const src = code("result-sync-ping.tsx");
    expect(src).toContain("syncPingStep(");
    // The rule's subtle halves (first-response baseline, null keeps it) live
    // in the tested pure function; a re-inlined copy is a copy that drifts.
    expect(
      uiFilesWith("cursorAdvanced"),
      `UI code has re-inlined the sync ping's cursor rule — the decision ` +
        `must come from syncPingStep, where the parked-tab trigger is pinned.`,
    ).toEqual([]);
  });

  it("inhouse-room computes its cadence only through inhousePollCadence", () => {
    const src = roomText(INHOUSE_ROOM);
    expect(src).toContain("inhousePollCadence(");
    // The room legitimately names other INHOUSE constants (the lobby prefix,
    // the voice channels); the poll rates are the ones that must live in the
    // helper, where the 429 back-off and the hidden-tab keepalive are pinned.
    for (const rate of ["INHOUSE.POLL_IDLE_MS", "INHOUSE.POLL_KEEPALIVE_MS"]) {
      expect(
        uiFilesWith(rate),
        `${rate} is back in UI code — schedule() must take its delay ` +
          `from inhousePollCadence so the rules stay in one tested place.`,
      ).toEqual([]);
    }
  });

  it("inhouse-room cannot lose an action reconciliation behind an in-flight poll", () => {
    const src = roomText(INHOUSE_ROOM);
    expect(src).toContain("let rerunRequested = false");
    expect(src).toMatch(
      /bumpPollRef\.current\s*=\s*\(\)\s*=>\s*\{\s*rerunRequested\s*=\s*true;\s*schedule\(250\)/,
    );
    expect(src).toMatch(
      /if \(rerunRequested\)\s*\{\s*rerunRequested\s*=\s*false;\s*schedule\(0\);\s*return;/,
    );
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
        uiFilesWith(rate),
        `${rate} is back in UI code — the draft room's ladder used to read a ` +
          `\`live\` flag that is false on every failed poll, which quietly ` +
          `demoted a live auction to the waiting-room rate for the whole outage.`,
      ).toEqual([]);
    }
  });
});

describe("live rooms delegate their payload ordering", () => {
  // The gate that drops a poll which left before a mutation and landed after
  // it. No unit test can see WHERE the number is minted, and no browser spec
  // can produce the interleaving on purpose, so this is the only check that a
  // room still routes through the tested fold.
  for (const room of ROOMS) {
    it(`${room.name}: orders payloads through room-sequence`, () => {
      const src = roomText(room);
      expect(src).toContain("issueSequence(");
      expect(src).toContain("acceptSequence(");
      expect(
        uiFilesWith("appliedSeqRef"),
        `UI code has re-inlined a room's ordering gate. It must fold through ` +
          `acceptSequence, or the two rooms drift apart again with nothing ` +
          `able to notice.`,
      ).toEqual([]);
    });

    it(`${room.name}: mints its sequence BEFORE awaiting the fetch`, () => {
      // Ordering is by request START. Move a mint below its `await fetch(...)`
      // and every unit test still passes while the gate degrades into a no-op:
      // responses would arrive already numbered in arrival order, so nothing
      // would ever be rejected. Checked file by file: a mint only counts for
      // a fetch in the same file.
      let mintCount = 0;
      let awaitCount = 0;
      for (const { path: file, text: src } of room.files) {
        const mints = [...src.matchAll(/issueSequence\(/g)].map(
          (m) => m.index!,
        );
        const awaits = [...src.matchAll(/await fetch\(/g)].map(
          (m) => m.index!,
        );
        mintCount += mints.length;
        awaitCount += awaits.length;
        for (const at of awaits) {
          expect(
            mints.some((m) => m < at && at - m < 1500),
            `A fetch in ${file} has no issueSequence() just above it — the ` +
              `sequence must be taken before the request leaves.`,
          ).toBe(true);
        }
      }
      expect(mintCount).toBe(2); // the poll and the action path
      expect(awaitCount).toBeGreaterThanOrEqual(2);
    });
  }
});

describe("live rooms delegate their alert triggers", () => {
  it("inhouse-room computes the chime and the tab title through the lib", () => {
    const src = roomText(INHOUSE_ROOM);
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
        uiFilesWith(literal),
        `${literal} is back in UI code — inhouseTitleFlag owns the ` +
          `priority order, including which nags stop once the player acts.`,
      ).toEqual([]);
    }
  });

  it("draft-room computes its title flag through the lib, strip included", () => {
    const src = code("draft-room.tsx");
    expect(src).toContain("draftTitleFlag(");
    expect(src).toContain("stripDraftTitleFlag(");
    for (const literal of ["⏰ Your pick — ", "💸 Outbid — "]) {
      expect(
        uiFilesWith(literal),
        `"${literal}" is back in UI code. The draft room used to hold a ` +
          `hand-copied duplicate of these literals for its strip(), and a ` +
          `one-character drift would have stacked prefixes in the tab forever.`,
      ).toEqual([]);
    }
  });

  it("draft-room decides the outbid latch through outbidLatchAfter", () => {
    const src = code("draft-room.tsx");
    expect(src).toContain("outbidLatchAfter(");
    expect(
      uiFilesWith("wasOutbid("),
      `UI code calls wasOutbid directly again — the SET half without ` +
        `the CLEAR half is how the banner ends up naming a lot that has moved on.`,
    ).toEqual([]);
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
        uiFilesWith(kind),
        `${kind} is back in UI code — feed CONTENT belongs in ` +
          `draftFeedDiff, where a test can state what each line means.`,
      ).toEqual([]);
    }
  });

  for (const room of ROOMS) {
    it(`${room.name}: rings the bell from ONE place, and rings from one`, () => {
      // Both rooms now fold a transition into a list of alerts and ring once.
      // Scattered call sites double-strike the same AudioContext when two
      // moments coincide — and, worse, each one is a separate unwritten rule
      // about when the room should make a noise.
      //
      // EXACTLY two, not "at most": collapsing four call sites into one made
      // that line a single point of failure, and a room that rings from NO
      // place is invisible to everything else here — tsc is happy, the alerts
      // list is still computed and tested, and no browser spec can hear audio.
      //
      // Counted across ALL of the room's files: a stage view that rings on its
      // own is the scattered call site this guard exists to stop.
      const calls = roomCode(room).reduce(
        (n, src) => n + src.split("playChime()").length - 1,
        0,
      );
      expect(
        calls,
        `${room.name} has ${calls} playChime() call sites across its ` +
          `${room.files.length} file(s). Expected 2: the sound toggle's own ` +
          `confirmation, and the single ring for a transition.`,
      ).toBe(2);
    });

    it(`${room.name}: rings from the ALERTS it computed, not from one branch`, () => {
      // The other half of the same failure: narrowing the condition to a
      // single trigger (say, only the outbid latch) silences the alerts that
      // reach a player who is not a captain and has nothing else on screen
      // telling them to look — sold, on the block, your turn.
      // Case-insensitive: the draft room rings off a local `alerts`, the
      // inhouse room off `inhouseAlerts(prev, snap).length` inline. Matched
      // within one file, so two files can never stitch a false pass together.
      expect(
        roomCode(room).some((src) =>
          /alerts[\s\S]{0,120}playChime\(\)/i.test(src),
        ),
        `${room.name} rings without consulting its alerts list — the ring ` +
          `must be derived from the tested transition, not from one ` +
          `hand-picked branch.`,
      ).toBe(true);
    });
  }
});

// Both rooms used to stack one strip per condition (offline, connection lost,
// back online, checking after an interrupted action, sign-in expired, updates
// delayed), and two could show at once. They now render ONE line picked by
// the tested `roomStatus`; a strip re-inlined into a room would bring the
// stacking back without any test noticing.
describe("live rooms share one status line", () => {
  for (const room of ROOMS) {
    it(`${room.name}: renders its conditions through roomStatus + RoomStatusLine`, () => {
      const src = roomText(room);
      expect(src).toContain("roomStatus(");
      expect(src).toContain("<RoomStatusLine");
    });
  }

  it("no UI file hand-writes a status sentence", () => {
    for (const sentence of [
      "Connection lost — reconnecting",
      "Connection restored — checking",
      "after an interrupted action",
    ]) {
      expect(
        uiFilesWith(sentence),
        `UI code has re-inlined a room status strip ("${sentence}") — pick ` +
          `the line with roomStatus and render <RoomStatusLine>.`,
      ).toEqual([]);
    }
  });

  // The status line and the pause note come and go between polls (a lost bid
  // response, a 429, the admin resuming). Rendered above the lot card they
  // pushed the lot and its bid buttons down and back up under a captain's
  // thumb, so the live view renders them below the controls instead.
  it("draft-room: the live view's status line sits below the bid controls", () => {
    const src = code("draft-room.tsx");
    const live = src.indexOf("const lotStale");
    const zone = src.indexOf("ref={bannerRef}", live);
    const primer = src.indexOf("<AuctionPrimer", zone);
    expect(live).toBeGreaterThan(-1);
    expect(zone).toBeGreaterThan(live);
    expect(primer).toBeGreaterThan(zone);
    const aboveCard = src.slice(live, zone);
    expect(aboveCard).not.toContain("{roomAlerts}");
    expect(aboveCard).not.toContain("paused the auction");
    const card = src.slice(zone, primer);
    const controls = card.indexOf("<ExactBidControl");
    expect(controls).toBeGreaterThan(-1);
    expect(card.indexOf("{roomAlerts}")).toBeGreaterThan(controls);
    expect(card.indexOf("paused the auction")).toBeGreaterThan(controls);
  });
});

// Every room guard above reads the inhouse shell AND src/components/inhouse/
// as one room. That only holds while the stage views actually live there: a
// view moved to some other folder would take its fetches and bells out of
// sight while every guard kept passing. So the shell must import each stage
// it renders from that folder.
describe("the inhouse room is its shell plus the stage folder", () => {
  it("the shell renders every stage view from src/components/inhouse/", () => {
    const shell = code("inhouse-room.tsx");
    for (const view of [
      "QueueView",
      "ReadyCheckView",
      "VoteView",
      "DraftView",
      "ReadyView",
      "InProgressView",
    ]) {
      expect(shell).toContain(`<${view}`);
      expect(
        new RegExp(
          `import \\{[^}]*\\b${view}\\b[^}]*\\} from "@/components/inhouse/`,
        ).test(shell),
        `${view} is not imported from src/components/inhouse/ — the room ` +
          `guards read only the shell and that folder, so a stage view kept ` +
          `anywhere else escapes them.`,
      ).toBe(true);
    }
  });
});
