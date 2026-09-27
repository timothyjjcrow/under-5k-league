import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tailwind v4 puts every utility in a cascade layer, and an UNLAYERED rule
 * beats all layers. A bare `a { color: … }` written outside `@layer` therefore
 * overrides `text-black` on gold accent buttons, `text-info` on textLink(),
 * and every nav/footer link colour — the gold "Relive the season →" button
 * rendered near-white text on amber (about 1.6:1). This pins the reset inside
 * a layer so the utilities win again.
 */

type Block = { prelude: string; body: string; layered: boolean };

/** Leaf rule blocks of a stylesheet, each flagged with whether an enclosing
 *  at-rule is `@layer`. Small and naive on purpose: globals.css holds no
 *  strings containing braces. */
function leafBlocks(css: string): Block[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Block[] = [];
  const stack: { prelude: string; start: number; hasChild: boolean }[] = [];
  let segmentStart = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      if (stack.length) stack[stack.length - 1].hasChild = true;
      const prelude = src.slice(segmentStart, i).split(";").pop()!.trim();
      stack.push({ prelude, start: i + 1, hasChild: false });
      segmentStart = i + 1;
    } else if (ch === "}") {
      const top = stack.pop();
      if (top && !top.hasChild) {
        out.push({
          prelude: top.prelude,
          body: src.slice(top.start, i),
          layered: stack.some((s) => s.prelude.startsWith("@layer")),
        });
      }
      segmentStart = i + 1;
    }
  }
  return out;
}

/** True when any selector in the list targets a bare `a` element. */
function targetsBareLink(prelude: string): boolean {
  return prelude
    .split(",")
    .some((sel) => /(^|[\s>+~(])a(?=$|[\s:[.#>+~,)])/.test(sel.trim()));
}

describe("link colour reset", () => {
  const css = readFileSync(
    path.resolve(process.cwd(), "src/app/globals.css"),
    "utf8",
  );
  const linkColorRules = leafBlocks(css).filter(
    (b) => targetsBareLink(b.prelude) && /(^|[;\s])color\s*:/.test(b.body),
  );

  it("still resets link colour somewhere", () => {
    expect(linkColorRules.length).toBeGreaterThan(0);
  });

  it("never colours bare links outside a cascade layer", () => {
    const unlayered = linkColorRules.filter((b) => !b.layered);
    expect(unlayered.map((b) => b.prelude)).toEqual([]);
  });

  it("the parser sees an unlayered rule when there is one", () => {
    // Guards the guard: without this, a parser that marked everything
    // `layered` would pass the test above against the broken stylesheet.
    const broken = leafBlocks(`@import "x";\na {\n  color: inherit;\n}\n`);
    expect(broken).toEqual([
      { prelude: "a", body: "\n  color: inherit;\n", layered: false },
    ]);
    const fixed = leafBlocks(`@layer base {\n  a { color: inherit; }\n}`);
    expect(fixed[0]?.layered).toBe(true);
    expect(targetsBareLink(".nav a:hover")).toBe(true);
    expect(targetsBareLink(".card")).toBe(false);
    expect(targetsBareLink("abbr")).toBe(false);
  });
});
