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

/**
 * Tap targets must clear WCAG 2.5.8 Target Size (Minimum), AA — 24x24 CSS px —
 * with the spec's own exceptions applied rather than ignored, because applying
 * them is the difference between a real defect and a link in a sentence:
 *
 *   INLINE   the target sits in a run of other text (explicitly exempt);
 *   SPACING  an undersized target with no other target within 24px conforms.
 *
 * A link that is the SOLE control of a list row is NOT inline prose, whatever
 * else that row contains — it is the row's control, and that is the case this
 * check exists for. A first audit found 208 failures across 533 targets; the
 * fix was `TAP_SAFE` on the shared primitives (see ui.tsx), not 200 call sites.
 */
export async function expectTapTargets(page: Page, label: string) {
  const bad = await page.evaluate(() => {
    const SEL =
      'a[href], button, [role="button"], summary, select, input:not([type="hidden"]), textarea';
    const els = [...document.querySelectorAll(`#main ${SEL}`)];
    const rects = els.map((e) => e.getBoundingClientRect());
    const out: string[] = [];
    els.forEach((el, i) => {
      const r = rects[i];
      if (r.width < 1 || r.height < 1) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden") return;
      // A CLOSED <details> LAYS ITS CONTENTS OUT — non-zero box, display:block,
      // visibility:visible — but does not paint or hit-test them. Trusting the
      // rect alone counted every control inside every collapsed disclosure as
      // real, which on /admin was 439 phantom findings out of 442.
      if (el.closest("details:not([open])")) return;
      if (
        typeof el.checkVisibility === "function" &&
        !el.checkVisibility({
          contentVisibilityAuto: true,
          opacityProperty: true,
          visibilityProperty: true,
        })
      )
        return;
      // Scrolled out of a clipping ancestor. getBoundingClientRect reports the
      // UNCLIPPED position, so a row below the fold of a `max-h-80
      // overflow-y-auto` list (admin's captain picker) claims coordinates
      // hundreds of pixels down the page, on top of whatever really lives
      // there. Intersect with every scroll clip before believing the rect.
      for (let p = el.parentElement; p; p = p.parentElement) {
        const po = getComputedStyle(p).overflow;
        if (po === "visible") continue;
        const pr = p.getBoundingClientRect();
        const iw = Math.min(r.right, pr.right) - Math.max(r.left, pr.left);
        const ih = Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top);
        if (iw < 2 || ih < 2) return;
      }
      const own = (el.textContent || "").trim();
      if (!own) return;
      // No length exemption. The first cut of this skipped one-character
      // labels as "data, not layout" — and the live league turned out to have
      // a player called "x" whose link was an 8px target, i.e. the exemption
      // was hiding the only real failure left. `min-w-6` on PlayerLink is the
      // fix; the guard's job is to keep saying so.
      const parentText = (el.parentElement?.textContent || "").trim();
      const inProse =
        cs.display.startsWith("inline") && parentText.length > own.length + 3;
      const row = el.closest("li, tr");
      const soleRowAction = row ? row.querySelectorAll(SEL).length === 1 : false;
      if (inProse && !soleRowAction) return;
      let crowded = false;
      for (let j = 0; j < els.length; j++) {
        if (j === i) continue;
        const o = rects[j];
        if (o.width < 1 || o.height < 1) continue;
        if (els[j].contains(el) || el.contains(els[j])) continue;
        const dx = Math.max(o.left - r.right, r.left - o.right, 0);
        const dy = Math.max(o.top - r.bottom, r.top - o.bottom, 0);
        if (Math.hypot(dx, dy) < 24) {
          crowded = true;
          break;
        }
      }
      if (Math.min(r.width, r.height) < 24 && crowded) {
        out.push(
          `${Math.round(r.height)}x${Math.round(r.width)}px <${el.tagName.toLowerCase()}> "${own.slice(0, 28)}"`,
        );
      }
    });
    return out.slice(0, 8);
  });
  expect(bad, `${label} has tap targets under WCAG 2.5.8 (24px)`).toEqual([]);
}
