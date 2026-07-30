import { test, expect } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  expectNoSqueezedText,
  trackPageErrors,
} from "./helpers";

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

// /me's identity card was broken in two ways that a single measurement misses,
// which is why this test asserts both. `Avatar` sets width/height but bakes in
// no shrink floor (callers pass one), so as a flex child beside the name block
// and the button column it was crushed to a 19px-wide sliver of its 56px box —
// measured still squashed at 430px, i.e. on every phone made. And the 17-digit
// SteamID64 is one unbreakable token, which pushed the row past the card
// itself: 58px of overflow at 320px, 18px at 360px, 3px at 375px, and 0 by
// 390px.
//
// 360px, not 390px, for exactly that reason: the first cut of this test ran at
// 390px, where the overflow is genuinely zero, and passed against a complete
// revert of the fix. The squash assertion is the width-independent half.
test("mobile /me identity card fits its card", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 844 });
  await page.goto("/me");
  await expect(
    page.getByRole("heading", { name: "Your profile" }),
  ).toBeVisible();
  // Wait for the identity card itself, not just the page heading — the first
  // cut of this test measured before it rendered, got "element missing", and
  // reported that as zero overflow. It passed against a full revert of the fix.
  const steamLink = page.locator('#main a[href*="steamcommunity.com"]').first();
  await steamLink.waitFor({ state: "visible", timeout: 10_000 });

  await expectNoSqueezedText(page, "/me");
  await expectNoHorizontalOverflow(page, "/me");

  // The card body must not scroll either. The page-level check above cannot
  // see this: <Card> is rounded, so it clips, and expectNoHorizontalOverflow
  // deliberately excuses anything inside a clipping ancestor.
  const card = await page.evaluate(() => {
    const steam = document.querySelector<HTMLAnchorElement>(
      '#main a[href*="steamcommunity.com"]',
    );
    const body = steam?.closest("div.flex");
    if (!body) return null;
    const av = body.firstElementChild!.getBoundingClientRect();
    return {
      overflow: body.scrollWidth - body.clientWidth,
      avatar: [Math.round(av.width), Math.round(av.height)] as [number, number],
    };
  });
  // A null here would sail straight past both assertions below.
  expect(
    card,
    "/me identity card not found — this test would otherwise pass by measuring nothing",
  ).not.toBeNull();
  expect(
    card!.overflow,
    "/me identity card overflows its own card",
  ).toBeLessThanOrEqual(1);
  // The Avatar is a fixed square. Anything else means a flex sibling is
  // crushing it, which stays true well past the width where overflow stops.
  expect(
    Math.abs(card!.avatar[0] - card!.avatar[1]),
    `/me avatar squashed by a flex sibling — rendered ${card!.avatar[0]}x${card!.avatar[1]}`,
  ).toBeLessThanOrEqual(1);
  assertNoErrors();
});

test("mobile schedule has no horizontal page overflow", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/schedule");
  await expect(page.getByText("Week 1").first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "/schedule");
  assertNoErrors();
});

// The admin panel and the match page render <select>s whose options are player
// names — a select sizes to its widest option and, as a flex item, refuses to
// shrink. One 32-char Steam name (Steam's own cap) used to push /admin 116px
// and /matches/[id] 64px wider than a 375px phone. Neither page had a mobile
// tripwire, which is how it shipped.
//
// Measured at 360px, not 375: it is the common narrow-Android width, and the
// 15px of headroom is what makes these catch on a developer's machine. At 375
// the /admin row that overflowed only tripped on CI, whose Linux fonts render a
// few px wider than macOS's — a tripwire you can only reproduce in CI is one you
// cannot act on.
test("mobile admin panel has no horizontal page overflow", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/api/auth/dev?name=Overflow%20Admin&admin=1");
  await page.goto("/admin");
  // exact: the page also has a "Recent admin activity" heading, and a loose
  // match resolves to both under strict mode.
  await expect(
    page.getByRole("heading", { name: "Admin", exact: true }),
  ).toBeVisible();
  // The Discord card loads behind its own <Suspense> (it makes several calls
  // to Discord, and awaiting them inline blocked the whole page). A streamed
  // section that throws renders nothing and leaves the rest of the page
  // looking fine — so assert it actually arrives, not just that /admin does.
  await expect(
    page.getByRole("heading", { name: "Discord notifications" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/admin");
  assertNoErrors();
});

test("mobile match page has no horizontal page overflow", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/schedule");
  await page.getByRole("link", { name: "details →" }).first().click();
  await expect(page).toHaveURL(/\/matches\//);
  await expectNoHorizontalOverflow(page, "/matches/[id]");
  assertNoErrors();
});
