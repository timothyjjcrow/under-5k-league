import { describe, expect, it } from "vitest";
import {
  filesContaining,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";
import { MATCH_ANCHOR } from "./match-anchors";

// Every link to a match-page card reads its id from MATCH_ANCHOR. A literal
// "#match-tools" skipped the constant, so a rename would have left that link
// landing at the top of the page, and it pointed "Line up cover" at Captain
// tools while every other "find a standin" link went to the Standins card.
describe("match-page anchors", () => {
  it("are never spelled out as literals outside match-anchors.ts", () => {
    const files = sourceFiles("src/**/*.{ts,tsx}", 100).filter(
      (f) => f.path !== "src/lib/match-anchors.ts",
    );
    const ids = Object.values(MATCH_ANCHOR).join("|");
    // Inside a string or template (after a quote, a `}` or a path slash);
    // prose in comments that names an anchor is fine.
    const literal = new RegExp(`[}"'\`/]#(?:${ids})\\b`);
    const offenders = filesContaining(
      files.map((f) => ({ ...f, text: stripLineComments(f.text) })),
      literal,
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
