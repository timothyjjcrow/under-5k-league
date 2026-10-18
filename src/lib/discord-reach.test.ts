import { describe, expect, it } from "vitest";
import { withReachabilityNote } from "./discord-reach";
import { sourceFiles } from "../../test/support/source-files";

describe("withReachabilityNote", () => {
  const note =
    " Heads up: Gone hasn't linked Discord, so the announcement won't notify them — contact them directly.";

  it("ends the toast's sentence before the note starts its own", () => {
    expect(withReachabilityNote("Standin assigned", note)).toBe(
      "Standin assigned. Heads up: Gone hasn't linked Discord, so the announcement won't notify them — contact them directly.",
    );
    expect(
      withReachabilityNote(
        "Standin assigned — heads up: a 4900 MMR standin is covering a 2000 MMR player",
        note,
      ),
    ).toMatch(/2000 MMR player\. Heads up: Gone/);
  });

  it("keeps a toast that already ends its sentence", () => {
    expect(withReachabilityNote("Done!", note)).toMatch(/^Done! Heads up:/);
    expect(withReachabilityNote("Signed. ", note)).toMatch(/^Signed\. Heads up:/);
  });

  it("leaves the toast untouched when there is nothing to add", () => {
    expect(withReachabilityNote("Standin assigned", "")).toBe(
      "Standin assigned",
    );
    expect(withReachabilityNote("Standin assigned", "  ")).toBe(
      "Standin assigned",
    );
  });
});

describe("every toast with a reachability note joins it through withReachabilityNote", () => {
  // `message + (await reachabilityNote(id))` ran two sentences together:
  // "Standin assigned Heads up: …". Each call must go through the joiner.
  const files = sourceFiles("src/app/actions/*.ts", 10);
  const count = (text: string, pattern: RegExp) =>
    [...text.matchAll(pattern)].length;

  it("finds the call sites it guards", () => {
    const calls = files.reduce(
      (sum, f) => sum + count(f.text, /\breachabilityNote\(/g),
      0,
    );
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it.each(files.map((f) => [f.path, f.text] as const))(
    "%s wraps each reachabilityNote in withReachabilityNote",
    (_path, text) => {
      expect(count(text, /\bwithReachabilityNote\(/g)).toBe(
        count(text, /\breachabilityNote\(/g),
      );
    },
  );
});
