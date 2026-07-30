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
 * A flex child carrying `min-w-0` has a min-content contribution of ZERO, so a
 * row holding one can never overflow — which means `flex-wrap` NEVER FIRES and
 * a non-shrinking sibling keeps its full width while the min-w-0 child absorbs
 * the entire shortfall. The player profile hero shipped exactly that: at 375px
 * the name column rendered 12px wide and `[overflow-wrap:anywhere]` on the h1
 * turned the player's name into ONE CHARACTER PER LINE — a 504px-tall h1 inside
 * a 908px hero card, with the Dotabuff/OpenDota links squeezed to 57px and
 * wrapped, ~940px down.
 *
 * It needs its own check because THE OTHER TWO TRIPWIRES BOTH PASS ON IT, and
 * that is the whole point of adding it:
 *   - expectNoHorizontalOverflow  — nothing overflowed. The text wrapped
 *     instead of spilling, so the page measured exactly 375px wide.
 *   - expectTapTargets            — the links measured 57x48. min(w,h) = 48,
 *     comfortably over the 24px floor. A squeezed target is not a small one.
 * The defect is only visible as a RATIO: characters of text against lines used.
 *
 * Thresholds are deliberately far from the observed failure (1.07 chars/line)
 * so ordinary narrow columns are never flagged — a real word broken across two
 * or three lines in a tight cell is fine and common.
 */
export async function expectNoSqueezedText(page: Page, label: string) {
  const squeezed = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll("main *")) {
      // Only leaves: an ancestor's textContent is its children's, and would
      // report the whole card as one blob of text.
      if (el.children.length > 0) continue;
      const text = (el.textContent || "").trim();
      if (text.length < 8) continue;
      if (el.closest("details:not([open])")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      // Genuinely vertical text is a deliberate choice, not this bug.
      if (cs.writingMode && cs.writingMode !== "horizontal-tb") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const lh =
        parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
      const lines = Math.round(r.height / lh);
      if (lines < 4) continue;
      const perLine = text.length / lines;
      if (perLine >= 2.5) continue;
      out.push(
        `<${el.tagName.toLowerCase()}> "${text.slice(0, 24)}" — ${lines} lines ` +
          `for ${text.length} chars (${perLine.toFixed(1)}/line) in ${Math.round(r.width)}px`,
      );
      if (out.length >= 6) break;
    }
    return out;
  });
  expect(
    squeezed,
    `${label} has text squeezed into a collapsed column (a flex sibling is not wrapping)`,
  ).toEqual([]);
}

/**
 * The TRUNCATING flavour of the flex collapse, and the reason it needs its own
 * check: expectNoSqueezedText measures lines against characters, and a
 * `truncate` element is always exactly one line however narrow it gets. There
 * is no ratio to see — the text just quietly disappears into an ellipsis.
 *
 * The player profile's "Seasons" card shipped it: a `min-w-0 flex-1` team link
 * against three `shrink-0` siblings, so the row never wrapped and the name got
 * the remainder — 0px at 320, 21px at 360, 36px at 375, against 119px of team
 * name. Healthy from ~500px, i.e. invisible on a desktop.
 *
 * 35% is deliberately far below ordinary truncation (a name clipped from 119px
 * to 100px is 84% and completely normal). It only fires on a box that has been
 * squeezed to uselessness. The 60px content floor keeps short labels, which
 * can legitimately lose a character or two, out of it.
 */
export async function expectNoCollapsedTruncation(page: Page, label: string) {
  const collapsed = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll("main *")) {
      const cs = getComputedStyle(el);
      if (cs.textOverflow !== "ellipsis" || cs.overflowX === "visible") continue;
      if (el.closest("details:not([open])")) continue;
      const text = (el.textContent || "").trim();
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const needs = el.scrollWidth;
      if (needs < 60) continue;
      const shown = r.width / needs;
      if (shown >= 0.35) continue;
      out.push(
        `"${text.slice(0, 22)}" renders ${Math.round(r.width)}px of ${needs}px (${Math.round(shown * 100)}%)`,
      );
      if (out.length >= 6) break;
    }
    return out;
  });
  expect(
    collapsed,
    `${label} truncates text into a collapsed flex column (a shrink-0 sibling is not yielding)`,
  ).toEqual([]);
}

/**
 * Two tap targets may TOUCH; they must never OVERLAP. An overlapping pair is
 * worse than an undersized one — the tap goes wherever paint order decides,
 * and on a roster chip that means opening the wrong player's profile.
 *
 * This is its own check because neither of the others can see it:
 * expectTapTargets only asks whether a box is big enough, and a 26px chip
 * passes; expectNoSqueezedText measures wrapped text, and these are one line.
 * The failure it exists for is `TAP_SAFE`'s pair being split by twMerge (see
 * ui.tsx) — an element that reserves 8px LESS than it occupies, so every row
 * of a wrapping rack overlaps the row above.
 *
 * Same three visibility disciplines as expectTapTargets, for the same reason:
 * a closed <details> still lays its contents out, and a clipping ancestor does
 * not move a rect, so without them this reports ghosts.
 */
export async function expectNoOverlappingTargets(
  page: Page,
  label: string,
  /**
   * Optional root to scope the scan to. Page-wide is the goal, but `CardHeader`
   * currently overlaps its own title link with a TAP_SAFE PlayerLink in its
   * subtitle by 2px (its subtitle is `mt-0.5`, i.e. 2px against TAP_SAFE's 4px
   * outdent), which is a defect in a 22-call-site primitive and its own
   * decision. Scope to the region under test rather than deleting the check.
   */
  within?: string,
) {
  const overlaps = await page.evaluate((root: string | undefined) => {
    const SEL = 'a[href], button, [role="button"], summary';
    const scope = root ? `${root} ${SEL}` : `main ${SEL}`;
    const live = [...document.querySelectorAll(scope)].filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      if (el.closest("details:not([open])")) return false;
      if (
        typeof el.checkVisibility === "function" &&
        !el.checkVisibility({
          contentVisibilityAuto: true,
          opacityProperty: true,
          visibilityProperty: true,
        })
      )
        return false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflow === "visible") continue;
        const pr = p.getBoundingClientRect();
        if (
          Math.min(r.right, pr.right) - Math.max(r.left, pr.left) < 2 ||
          Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top) < 2
        )
          return false;
      }
      return true;
    });
    const out: string[] = [];
    for (let i = 0; i < live.length && out.length < 6; i++) {
      for (let j = i + 1; j < live.length && out.length < 6; j++) {
        // Nesting is legitimate — an <a> wrapping a <button> overlaps by design.
        if (live[i].contains(live[j]) || live[j].contains(live[i])) continue;
        const a = live[i].getBoundingClientRect();
        const b = live[j].getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        // >0.5px on both axes: sub-pixel rounding on adjacent boxes is not an
        // overlap, and "may touch" has to stay legal.
        if (w > 0.5 && h > 0.5) {
          const t = (el: Element) => (el.textContent || "").trim().slice(0, 18);
          out.push(
            `"${t(live[i])}" x "${t(live[j])}" overlap ${Math.round(w)}x${Math.round(h)}px`,
          );
        }
      }
    }
    return out;
  }, within);
  expect(
    overlaps,
    `${label} has tap targets whose hit boxes overlap — the tap lands on whichever painted last`,
  ).toEqual([]);
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
