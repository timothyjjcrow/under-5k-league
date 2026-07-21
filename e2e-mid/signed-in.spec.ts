import { test, expect } from "@playwright/test";
import { trackPageErrors } from "./helpers";

// Signed-in mid-season surfaces: fantasy (locked once games imported — the
// fixture has games, so assert the locked state renders) and pick'em.

test.beforeEach(async ({ page }) => {
  await page.goto("/api/auth/dev?name=Mid%20Season%20Viewer");
});

test("fantasy renders standings for a signed-in viewer (league locked)", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/fantasy");
  await expect(
    page.getByRole("heading", { name: "Fantasy", exact: true }),
  ).toBeVisible();
  // Imported games lock the league — the page must say so instead of
  // offering a dead picker.
  await expect(page.getByText(/locked/i).first()).toBeVisible();
  assertNoErrors();
});

test("pick'em renders the oracle board and match cards", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/pickem");
  await expect(page.getByRole("heading", { name: "Pick'em" })).toBeVisible();
  assertNoErrors();
});

test("mobile schedule has no horizontal page overflow", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/schedule");
  await expect(page.getByText("Week 1").first()).toBeVisible();
  // The page body must never scroll horizontally (CLAUDE.md mobile rules) —
  // wide content scrolls inside its own container instead. When it fails,
  // name the offending elements (skipping ones safely clipped by their own
  // overflow container) so the regression is diagnosable from CI output.
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
      return `${el.tagName.toLowerCase()}[${String(el.className).slice(0, 60)}]${head ? ` «${head}»` : ""} scrollW=${el.scrollWidth}`;
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
  expect(offenders, `page scrolls horizontally by ${overflow}px`).toEqual([]);
  expect(overflow).toBeLessThanOrEqual(1);
  assertNoErrors();
});
