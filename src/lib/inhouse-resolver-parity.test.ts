import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SOURCE-LEVEL PARITY GUARD for the inhouse resolver chain, which lives
// in TWO places on purpose:
//
//   - getInhouseState (inhouse-service.ts) — the room's own poll path
//   - syncInhouse (result-sync-service.ts) — the authenticated one-minute
//     automation worker, which reaches a lobby NOBODY is polling
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
// on the same poll; syncInhouse runs the bet sweep ABOVE its empty-queue
// early return, because "no lobby, empty queue" is the state a pot gets
// stranded in). Do not extend this test to compare order.
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
    end: "const [queue, lobbyRow]",
  },
  {
    label: "syncInhouse (result-sync-service.ts)",
    file: "result-sync-service.ts",
    start: "async function syncInhouse",
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
  "resolveUnsettledBets",
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
});
