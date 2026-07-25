import { expect, type Page } from "@playwright/test";

/**
 * Tripwire for the exact failure class this suite exists to catch: a client
 * component that renders server-side but CRASHES in the browser (hydration
 * mismatch, undefined access in an effect). Attach before navigating; call
 * the returned assert at the end of the test.
 */
export function trackPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return () =>
    expect(errors, "uncaught client-side errors on the page").toEqual([]);
}

/**
 * The page body must never scroll horizontally (CLAUDE.md mobile rules) — wide
 * content scrolls inside its own container instead. On failure, name the
 * offending elements (skipping ones safely clipped by their own overflow
 * container) so the regression is diagnosable straight from CI output.
 *
 * Shared rather than inlined per-spec: the two pages that broke in the
 * 2026-07-24 audit (/admin's roster-move selects and /matches/[id]'s standin
 * selects, both sized by their widest player-name <option>) were exactly the
 * ones this check had never been pointed at.
 */
export async function expectNoHorizontalOverflow(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const docW = document.documentElement.clientWidth;
    const overflowPx = document.documentElement.scrollWidth - docW;
    const clipped = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll" || o === "hidden") return true;
      }
      return false;
    };
    const desc = (el: Element) => {
      const head = el.querySelector("h1,h2,h3")?.textContent?.slice(0, 30);
      const name = el.getAttribute("name");
      return `${el.tagName.toLowerCase()}[${String(el.className).slice(0, 60)}]${
        name ? ` name=${name}` : ""
      }${head ? ` «${head}»` : ""} scrollW=${el.scrollWidth}`;
    };
    const offenders: string[] = [];
    if (overflowPx > 1) {
      for (const el of document.querySelectorAll("*")) {
        if (
          el.getBoundingClientRect().right > docW + 1 &&
          !clipped(el) &&
          offenders.length < 6
        ) {
          offenders.push(desc(el));
        }
      }
      // Rects miss some culprits (transforms, margins) — also walk the chain
      // of elements whose own layout scrollWidth exceeds the viewport.
      const walk = (el: Element, depth: number) => {
        for (const c of el.children) {
          if (
            c.scrollWidth > docW + 1 &&
            getComputedStyle(c).overflowX === "visible" &&
            offenders.length < 12
          ) {
            offenders.push(`chain@${depth}: ${desc(c)}`);
            walk(c, depth + 1);
          }
        }
      };
      walk(document.body, 0);
    }
    return { overflow: overflowPx, offenders };
  });
  expect(offenders, `${label} scrolls horizontally by ${overflow}px`).toEqual(
    [],
  );
  expect(overflow, `${label} horizontal overflow`).toBeLessThanOrEqual(1);
}
