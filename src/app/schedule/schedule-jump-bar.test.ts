import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the schedule jump bar", () => {
  // The schedule's folds open themselves when the hash names them, and the
  // browser scrolls to the hash. A bar that also followed it re-scrolled
  // the page after load and fonts, and a re-scroll between the press and
  // release of a click swallowed it: the tiebreaker folds stayed shut.
  it("leaves the hash to the page and opens only the section it lands on", () => {
    const page = read("src/app/schedule/page.tsx");
    expect(page).toMatch(
      /<SectionNav\s+items=\{jumpItems\}\s+label="Schedule sections"\s+followHash=\{false\}\s+openNested="marked"\s*\/>/,
    );
    expect(page.match(/<SectionNav\b/g)).toHaveLength(1);
  });

  it("stops every hash-driven reveal when a page turns followHash off", () => {
    const nav = read("src/components/section-nav.tsx");
    expect(nav).toContain("followHash = true,");
    const resolve = nav.slice(nav.indexOf("const resolveHash = () => {"));
    expect(resolve.slice(0, resolve.indexOf("\n    };"))).toMatch(
      /^const resolveHash = \(\) => \{\s+if \(!followHash\) return;/,
    );
    // Every after-load reveal is registered only while following the hash.
    const start = nav.indexOf("if (followHash) {");
    const registration = nav.slice(start, nav.indexOf("\n    }", start));
    for (const call of [
      'if (document.readyState === "complete") revealAfterPaint();',
      'window.addEventListener("load", revealAfterPaint, { once: true });',
      "void document.fonts.ready.then(revealAfterPaint);",
    ]) {
      expect(registration).toContain(call);
      expect(nav.split(call)).toHaveLength(2);
    }
    expect(nav).toContain("[items, openNested, followHash]");
  });
});
