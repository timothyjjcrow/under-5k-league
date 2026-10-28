import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REASON_RESOLVER } from "./inhouse-room-due";

// SOURCE-LEVEL PARITY GUARD for the inhouse resolver chain, which lives
// in TWO places on purpose:
//
//   - getInhouseState (inhouse-service.ts) — the room's own poll path
//   - syncInhouseLobbies (result-sync-service.ts, the 5v5 half of the
//     worker's syncInhouse) — the authenticated one-minute automation
//     worker, which reaches a lobby NOBODY is polling
//
// A resolver added to one chain but not the other fails SILENTLY: tsc is
// happy, the resolver's own unit tests pass, and the forgotten chain just
// never advances the state that resolver owns. That is exactly the class
// behind the documented resolveAbandonedLobby outage — READY and IN_PROGRESS
// have no clock, so a dead lobby held the single active slot (and refused its
// own ten players at joinQueue) until an admin happened to visit /inhouse.
// No behavioural test catches "one caller of a lazy sweep is missing";
// each caller individually looks complete.
//
// PARITY OF SET ONLY. The ORDER deliberately differs between the chains, and
// each ordering carries a load-bearing comment at its call site
// (getInhouseState runs the abandon sweep first so the freed slot can re-form
// on the same poll; syncInhouse skips the whole chain behind its "no lobby,
// empty queue" early return). Do not extend this test to compare order.
//
// KNOWN LIMITATION: the extractor only sees calls named resolve*/maybe*.
// A resolver under another naming shape (syncInhouseBoard,
// touchQueueHeartbeat) escapes the regex in BOTH chains and is not covered
// here. The explicit EXPECTED list below is the mitigation: any change to a
// regex-visible chain forces a conscious edit of this file, at which point
// the reviewer is looking at this comment.

const CHAINS = [
  {
    label: "getInhouseState (inhouse-service.ts)",
    file: "inhouse-service.ts",
    // From the function declaration down to its first state read — the chain
    // is everything awaited before the queue/lobby snapshot is taken.
    start: "export async function getInhouseState",
    end: "const rows = await loadInhouseRoomRows(",
  },
  {
    label: "syncInhouseLobbies (result-sync-service.ts)",
    file: "result-sync-service.ts",
    // The 5v5 half of the worker's syncInhouse (the 1v1 half is worker-only,
    // below).
    start: "async function syncInhouseLobbies(",
    end: "const [stillActive, present]",
  },
] as const;

/** Every resolver the chain must run. Sorted; compared as a SET. */
const EXPECTED = [
  "maybeAutoDetectResult",
  "maybeFormLobby",
  "resolveAbandonedLobby",
  "resolveCaptainVote",
  "resolveReadyCheck",
  "resolveStalledPick",
].sort();

const readSource = (file: string) => readFileSync(join(__dirname, file), "utf8");

/**
 * The slice with whole-line comments dropped before extraction. The chain
 * comments QUOTE resolver names ("so maybeFormLobby can form the next game…")
 * — that prose is exactly worth keeping, and a guard that miscounted because
 * someone wrote `await resolveX(...)` in an explanation would either lie or
 * get the explanation deleted.
 */
const stripComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

function chainSlice(chain: (typeof CHAINS)[number]): string {
  const src = readSource(chain.file);
  const start = src.indexOf(chain.start);
  const end = src.indexOf(chain.end);
  if (start === -1 || end === -1 || end < start) return "";
  return stripComments(src.slice(start, end));
}

/** The awaited resolve…/maybe… call names in the slice, as a sorted set. */
function resolverSet(slice: string): string[] {
  const names = [...slice.matchAll(/await ((?:resolve|maybe)[A-Z]\w*)\(/g)].map(
    (m) => m[1],
  );
  return [...new Set(names)].sort();
}

describe("inhouse resolver-chain parity", () => {
  it("finds both chains it is supposed to be guarding", () => {
    // If a function is renamed or the local past the chain is refactored, a
    // sliced guard would pass by finding nothing at all — which is how a
    // guard rots into decoration. Every anchor must still be present, and
    // the extractor must still bite on at least one known member.
    for (const chain of CHAINS) {
      const src = readSource(chain.file);
      expect(
        src.indexOf(chain.start),
        `start anchor ${JSON.stringify(chain.start)} not found in ${chain.file} — ` +
          `re-anchor this guard before trusting anything below.`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        src.indexOf(chain.end),
        `end anchor ${JSON.stringify(chain.end)} not found in ${chain.file} — ` +
          `re-anchor this guard before trusting anything below.`,
      ).toBeGreaterThan(src.indexOf(chain.start));
      expect(
        resolverSet(chainSlice(chain)),
        `${chain.label}: the extractor found no resolvers between its anchors.`,
      ).toContain("maybeFormLobby");
    }
  });

  it("both chains await the same resolver set", () => {
    const [a, b] = CHAINS.map((c) => ({ label: c.label, set: resolverSet(chainSlice(c)) }));
    expect(
      a.set,
      `The two resolver chains have drifted apart. A resolver missing from ` +
        `one of them fails silently — the resolveAbandonedLobby class. ` +
        `${a.label} runs [${a.set.join(", ")}]; ${b.label} runs ` +
        `[${b.set.join(", ")}]. Add the resolver to BOTH chains (each ` +
        `ordering has its own load-bearing comment) and to EXPECTED here.`,
    ).toEqual(b.set);
  });

  it("the shared set is exactly the expected resolver list", () => {
    // Without this, deleting a resolver from BOTH chains at once would still
    // pass the parity check above. The list also forces every addition
    // through this file, where the naming-convention limitation is written.
    for (const chain of CHAINS) {
      expect(
        resolverSet(chainSlice(chain)),
        `${chain.label} no longer runs the expected resolver set. If this is ` +
          `a deliberate add/remove, update BOTH chains and EXPECTED together.`,
      ).toEqual(EXPECTED);
    }
  });

  it("the room poll's due check can wake every resolver the room runs", () => {
    // A signed-in poll runs the chain only when inhouseRoomDue names a reason
    // (inhouse-room-state.ts). A resolver with no reason there would only
    // ever run from the one-minute worker. maybeAutoDetectResult is the one
    // exception: room polls pass detectResults: false.
    const woken = [...new Set(Object.values(REASON_RESOLVER))].sort();
    expect(woken).toEqual(
      EXPECTED.filter((name) => name !== "maybeAutoDetectResult"),
    );
  });
});

// WORKER-ONLY STEPS. The 1v1 mid duels (inhouse-duel-service.ts) have no
// room-poll chain at all: their queue expiry, pairing sweep, bot reads,
// OpenDota scan and give-up clocks run only from the worker's syncInhouse,
// through runDuelWorkerSteps (docs/features/inhouse-duels.md). That is an
// explicit list, not a loosening of the 5v5 parity above: each name must be
// called from the worker and must never appear in the room's chain or the
// room poll's modules, where it would run on a viewer's request.
const WORKER_ONLY = [
  "runDuelWorkerSteps",
  "maybeAutoDetectDuelResults",
  "giveUpOnDuels",
  "expireDuelQueue",
  "pairDuelQueue",
] as const;

describe("worker-only inhouse steps (the 1v1 duels)", () => {
  const worker = stripComments(readSource("result-sync-service.ts"));
  const fnBody = (src: string, name: string) => {
    const start = src.indexOf(`async function ${name}(`);
    if (start === -1) return "";
    const rest = src.slice(start + 1);
    const next = rest.search(/\n(export |async function |function )/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  it("the worker's syncInhouse runs the 5v5 half, then the 1v1 steps behind their probe", () => {
    const sync = fnBody(worker, "syncInhouse");
    expect(sync.length).toBeGreaterThan(0);
    const games = sync.indexOf("await syncInhouseLobbies(options)");
    const duels = sync.indexOf("await syncInhouseDuels(options)");
    expect(games).toBeGreaterThan(-1);
    expect(duels).toBeGreaterThan(games);
    const steps = fnBody(worker, "syncInhouseDuels");
    const probe = steps.indexOf("await duelWorkPending()");
    expect(probe).toBeGreaterThan(-1);
    expect(steps.indexOf("await runDuelWorkerSteps(")).toBeGreaterThan(probe);
    // Its own catch: a 1v1 failure never fails the 5v5 pass.
    expect(steps).toMatch(/\} catch \(error\) \{\s*logStepFailure\("inhouse-duels", error\);/);
  });

  it("runDuelWorkerSteps runs every worker-only step", () => {
    const duel = stripComments(readSource("inhouse-duel-service.ts"));
    const steps = fnBody(duel, "runDuelWorkerSteps");
    expect(steps.length).toBeGreaterThan(0);
    for (const name of WORKER_ONLY.filter((n) => n !== "runDuelWorkerSteps")) {
      expect(steps, name).toContain(`await ${name}(`);
    }
  });

  it("no worker-only step runs in the room's chain or a room poll module", () => {
    const roomChain = chainSlice(CHAINS[0]);
    const pollModules = [
      "inhouse-room-state.ts",
      "inhouse-room-due.ts",
      "inhouse-room-wake.ts",
      "inhouse-room-cache.ts",
    ].map((file) => ({ file, text: stripComments(readSource(file)) }));
    const route = stripComments(
      readFileSync(join(__dirname, "../app/api/inhouse/route.ts"), "utf8"),
    );
    for (const name of WORKER_ONLY) {
      expect(roomChain, `getInhouseState runs ${name}`).not.toContain(name);
      for (const m of pollModules) {
        expect(m.text, `${m.file} runs ${name}`).not.toContain(name);
      }
      expect(route, `the room's route runs ${name}`).not.toContain(name);
    }
    // And the 5v5 chain's set is untouched by them (the parity above).
    expect(resolverSet(roomChain)).toEqual(EXPECTED);
  });
});
