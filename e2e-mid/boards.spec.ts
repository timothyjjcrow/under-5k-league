import { test, expect } from "@playwright/test";
import {
  expectNoCollapsedTruncation,
  expectNoHorizontalOverflow,
  expectNoOverlappingTargets,
  expectNoSqueezedText,
  expectTapTargets,
  trackPageErrors,
} from "./helpers";

// The stat roll-up pages — all recompute from every stored Game and all were
// previously untested in a browser. Each check: key cards render, the
// interactive bits respond, and nothing crashed client-side.

test("leaders renders boards with the show-all toggle", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/leaders");
  await expect(page.getByRole("heading", { name: "Leaders" })).toBeVisible();
  const toggle = page.getByRole("button", { name: /Show all/ }).first();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(
    page.getByRole("button", { name: /Show top 5/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Weekly honors", level: 2 }),
  ).toBeVisible();
  await expect(page.getByText(/is still in progress/i)).toBeVisible();
  // A 55th-percentile player should fill about 55% of the scale, even when
  // they lead this league. Relative-to-leader scaling would incorrectly fill it.
  const reportLeader = page.locator("#metric-report li").first();
  const percentile = Number.parseFloat(
    await reportLeader.locator(".font-display").innerText(),
  );
  const fill = await reportLeader
    .locator(".bar-fill")
    .evaluate((bar) => Number.parseFloat((bar as HTMLElement).style.width));
  expect(fill).toBeCloseTo(percentile, 0);
  assertNoErrors();
});

test("homepage league pulse shares the trusted honors and hero state", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");
  await page
    .locator("summary")
    .filter({ hasText: "Player & hero highlights" })
    .click();
  const pulse = page.getByRole("heading", {
    name: "League pulse",
    level: 2,
  });
  await expect(pulse).toBeVisible();
  const card = pulse.locator(
    "xpath=ancestor::div[contains(@class, 'rounded-')][1]",
  );
  await expect(card.getByText(/is still in progress/i)).toBeVisible();
  await expect(card.getByText(/most picked/i)).toBeVisible();
  await expect(card.locator('a[href="/meta"]')).toBeVisible();
  await expectNoHorizontalOverflow(page, "/ league pulse");
  assertNoErrors();
});

test("hero meta renders the contested and win-rate boards", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/meta");
  await expect(page.getByText("Most contested")).toBeVisible();
  // ("Untouched" only renders when unpicked heroes exist — data-dependent;
  // the win-rate board always accompanies games.)
  await expect(page.getByText("Winning the meta")).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Most contested heroes" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Most contested", level: 2 }),
  ).toBeVisible();
  assertNoErrors();
});

test("the record book renders all-time records", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/records");
  await expect(
    page.getByRole("heading", { name: "Record book" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Player records", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Game records", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /kill score/i }).first(),
  ).toBeVisible();
  assertNoErrors();
});

test("player comparison lists real careers, normalizes invalid links, and exposes table semantics", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/players/compare");
  const playerA = page.getByLabel("Player A");
  const playerB = page.getByLabel("Player B");
  const ids = await playerA
    .locator('option:not([value=""])')
    .evaluateAll((options) =>
      options.slice(0, 2).map((option) => (option as HTMLOptionElement).value),
    );
  expect(ids).toHaveLength(2);
  await playerA.selectOption(ids[0]);
  await playerB.selectOption(ids[1]);
  await page.getByRole("button", { name: "Compare" }).click();

  await expect(
    page.getByRole("heading", { name: "Career numbers", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: /Career comparison between/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Statistics" }),
  ).toBeVisible();

  await page.goto(`/players/compare?a=${ids[0]}&b=${ids[0]}`);
  await expect(page.getByText("That's the same player twice")).toBeVisible();
  await page.goto(`/players/compare?a=${ids[0]}`);
  await expect(
    page.getByText("Pick two players", { exact: true }),
  ).toBeVisible();

  await page.goto(`/players/compare?a=not-a-player&b=${ids[1]}`);
  await expect(
    page.getByText("Player unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Player A")).toHaveValue("");
  await expect(page.getByLabel("Player B")).toHaveValue(ids[1]);

  await page.goto(`/players/compare?a=${ids[0]}&a=${ids[1]}&b=${ids[1]}`);
  await expect(
    page.getByText("Player unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Player A")).toHaveValue("");

  await page.goto(`/players/compare?a=e2e-mid-no-history&b=${ids[1]}`);
  await expect(
    page.getByText("Player unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    /Compare players/i,
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    /\/players\/compare$/,
  );
  assertNoErrors();
});

test("league news is deterministic, shareable, and usable on a phone", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  const mediaUrl = "https://localhost:3212/e2e-news.gif";
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(mediaUrl, (route) =>
    route.fulfill({
      contentType: "image/gif",
      headers: { "cache-control": "no-store" },
      body: Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
        "base64",
      ),
    }),
  );
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/news");
  const headings = page.locator("#main article h2, #main [id] h2");
  await expect(
    page.getByRole("heading", { name: "League news", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Match night reminder", level: 2 }),
  ).toBeVisible();
  await expect(headings.first()).toHaveText("Match night reminder");
  await expect(page.locator("#e2e-mid-news-pinned")).toContainText("Pinned");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    /\/news$/,
  );
  const permalink = page
    .getByRole("link", {
      name: /Permalink to .*Match night reminder/i,
    })
    .first();
  const box = await permalink.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await permalink.click();
  await expect(page).toHaveURL(
    /\/news\?post=e2e-mid-news-pinned#e2e-mid-news-pinned$/,
  );
  await expect(
    page.getByRole("heading", { name: "Match night reminder", level: 2 }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "All announcements", exact: true })
    .click();
  await expect(
    page.getByRole("link", {
      name: /Media attached to .*Week schedule published.*open animation/i,
    }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/news");
  expect(await headings.count()).toBeGreaterThan(0);
  assertNoErrors();
});

test("failed news media degrades to its source link", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  const mediaUrl = "https://localhost:3212/e2e-news.gif";
  await page.route(mediaUrl, (route) => route.abort("failed"));
  await page.goto("/news");
  await expect(
    page.locator(`a[href="${mediaUrl}"]`, { hasText: mediaUrl }),
  ).toBeVisible();
  assertNoErrors();
});

test("public statistics metadata is route-specific and invalid archives are noindex not-found pages", async ({
  page,
}) => {
  for (const [path, description] of [
    ["/leaders", /season leaders/i],
    ["/meta", /heroes GGD2L players pick/i],
    ["/records", /all-time single-game/i],
    ["/recap", /awards, superlatives/i],
    ["/fantasy", /salary-capped fantasy five/i],
    ["/pickem", /Call every GGD2L match/i],
  ] as const) {
    await page.goto(path);
    await expect(
      page.locator('meta[property="og:description"]'),
    ).toHaveAttribute("content", description);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`${path.replace("/", "\\/")}$`),
    );
  }
  await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
    "content",
    "GGD2L",
  );
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute(
    "content",
    "website",
  );

  // Root loading.tsx starts the response stream before Prisma can resolve the
  // archive lookup. Next 16 therefore documents this as a 200 response with a
  // not-found UI and an injected noindex directive. Preserve the shared page
  // loading experience and verify the complete browser-visible contract.
  for (const path of ["/leaders", "/meta", "/recap", "/fantasy", "/pickem"]) {
    for (const query of [
      "season=definitely-missing",
      "season=one&season=two",
    ]) {
      const response = await page.goto(`${path}?${query}`);
      expect(response?.status()).toBe(200);
      await expect(
        page.getByRole("heading", { name: "Page not found" }),
      ).toBeVisible();
      await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
        "content",
        /noindex/i,
      );
    }
  }

  // Player history uses the same one-season selector, but a malformed key
  // previously fell back to "All seasons" instead of rejecting the URL.
  await page.goto("/players");
  const profileHref = await page
    .locator('#main a[href^="/players/"]:not([href="/players/compare"])')
    .first()
    .getAttribute("href");
  expect(profileHref).toBeTruthy();
  const profileResponse = await page.goto(
    `${profileHref}?season=one&season=two`,
  );
  expect(profileResponse?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
    "content",
    /noindex/i,
  );
});

test("public stat and content pages stay inside a 360px viewport", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  for (const path of [
    "/meta",
    "/records",
    "/players/compare",
    "/news",
    "/features",
  ]) {
    await page.goto(path);
    await expectNoHorizontalOverflow(page, path);
  }
  assertNoErrors();
});

test("team page renders roster, form, and the what-we-need card", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/teams");
  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
  // Into the first team's page via its standings-ordered card link.
  await page.locator('#main a[href^="/teams/"]').first().click();
  await expect(page).toHaveURL(/\/teams\/.+/);
  await expect(page.getByText("Roster").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Head-to-head", exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/teams/[id]");
  assertNoErrors();
});

// The /teams roster chip racks wrap on every phone, and each chip is a
// PlayerLink carrying its own py-0.5 — the combination that splits TAP_SAFE's
// pair through twMerge and leaves a chip occupying 26px while reserving 18px.
// Measured before the fix: 7 overlapping pairs at 375px, each a 2px band over
// ~120px of width, where the tap opened the player on the row above. No
// existing check could see it — the chips are comfortably over WCAG's 24px
// floor, and there is no wrapped text to measure a ratio on.
test("teams roster chips do not overlap on a phone", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/teams");
  const chip = page.locator('#main a[href^="/players/"]').first();
  await chip.waitFor({ state: "visible", timeout: 10_000 });
  // The racks are the point of this test; assert they rendered rather than
  // letting an empty page report a clean bill of health.
  await expect
    .poll(() => page.locator('#main a[href^="/players/"]').count())
    .toBeGreaterThan(4);
  // Page-wide: this covers both the wrapped roster chips and each team title's
  // neighboring captain link. PlayerLink's TAP_SAFE outdent makes insufficient
  // title/subtitle spacing a real ambiguous tap target, not a visual-only gap.
  await expectNoOverlappingTargets(page, "/teams rosters");
  await expectNoHorizontalOverflow(page, "/teams");
  assertNoErrors();
});

// /leaders shipped a 188px horizontal page scroll at 390px: its board grid was
// `grid gap-4 sm:grid-cols-2` with no base column, so below `sm` the implicit
// track was `auto` and sized itself to a leaderboard row's max-content (560px
// in a 390px viewport). Exactly the failure CLAUDE.md's grid-cols-1 rule
// exists to prevent, on a page that had no tripwire pointed at it.
test("leaders has no horizontal page overflow on a phone", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/leaders");
  await expect(page.getByRole("heading", { name: "Leaders" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/leaders");
  assertNoErrors();
});

// The pool is a column-aligned grid whose tracks change three times between
// 390px and 1440px — exactly the shape that leaks page width when a track is
// sized by its content instead of by `minmax(0,1fr)`.
test("players page has no horizontal page overflow on a phone", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/players");
  await expect(page.getByRole("heading", { name: "Players" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/players");
  assertNoErrors();
});

test("a player profile renders career stats and the report card", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/players");
  // Skip the "Compare players" action link — pick a real profile link.
  await page
    .locator('#main a[href^="/players/"]:not([href*="compare"])')
    .first()
    .click();
  await expect(page).toHaveURL(/\/players\/.+/);
  await expect(page.getByText("Seasons").first()).toBeVisible();
  assertNoErrors();
});

// This page shipped the flex collapse TWICE, in both of its flavours, and each
// needs a different probe.
//
// The hero (wrapping flavour): a `min-w-0` name column sharing a line with the
// non-shrinking team card. The column rendered 12px wide, the h1 went one
// character per line at 504px tall, and the Dotabuff/OpenDota links were
// squeezed to 57px and pushed ~940px down. A player reported it as "the
// Dotabuff link doesn't work"; it could not be reproduced on a desktop because
// the row is healthy from 640px up.
//
// The "Seasons" card (truncating flavour): a `min-w-0 flex-1` team link
// against three shrink-0 siblings, so the team name rendered 36px of its
// 119px at 375px and 0px at 320px — gone, with no ellipsis worth reading.
//
// 375px, not 390px: the Seasons row is only ~44% collapsed at 390 and would
// slip under the threshold. The team card triggers the hero half, so the walk
// below insists on a rostered profile rather than measuring an arbitrary one.
test("a player profile hero survives a phone", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/teams");
  await page.locator('#main a[href^="/teams/"]').first().click();
  await expect(page).toHaveURL(/\/teams\/.+/);
  // The roster streams in behind <Suspense>; collecting hrefs before it lands
  // yields only the shell's links (the captain, who in this fixture holds no
  // TeamMember row) and the walk below then finds nothing.
  await expect
    .poll(() => page.locator('#main a[href^="/players/"]').count())
    .toBeGreaterThan(2);

  // Walk the roster until a profile actually renders the team card. Taking the
  // first link is not enough: the fixture's team pages also link users who
  // hold no TeamMember row, whose profiles render no card and so do not
  // exercise the bug at all — which is precisely the way this test could pass
  // while measuring nothing.
  const hrefs = await page
    .locator('#main a[href^="/players/"]')
    .evaluateAll((els) => [
      ...new Set(
        els
          .map((e) => (e as HTMLAnchorElement).getAttribute("href") || "")
          .filter((h) => h && !h.includes("compare")),
      ),
    ]);
  let rostered = "";
  for (const href of hrefs) {
    await page.goto(href);
    // The hero streams too, so an immediate isVisible() is answered before the
    // card exists and every candidate reads as unrostered. Wait for the hero's
    // own h1 first, then give the team card its own short wait.
    await page
      .locator("#main h1")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    const hasTeamCard = await page
      .locator('#main a[href^="/teams/"]')
      .first()
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (hasTeamCard) {
      rostered = href;
      break;
    }
  }
  expect(
    rostered,
    "no rostered player profile reachable — the team card is the flex sibling that triggers the collapse, so without it this test measures nothing",
  ).not.toEqual("");

  await expectNoSqueezedText(page, "/players/[id]");
  await expectNoCollapsedTruncation(page, "/players/[id]");
  await expectNoOverlappingTargets(page, "/players/[id]");
  await expectNoHorizontalOverflow(page, "/players/[id]");
  await expectTapTargets(page, "/players/[id]");

  // Named assertion on the Seasons row, because the general check above only
  // catches this defect at widths where it happens to be severe enough: the
  // team name renders 18% of itself at 360px but 43% at 375px, and a
  // generic ratio loose enough to catch 43% would fire on ordinary truncation
  // elsewhere. This one is scoped to the element that broke, so it can be
  // strict without any false-positive surface.
  const seasonName = await page.evaluate(() => {
    const sl = document.querySelector('#main a[href^="/seasons/"]');
    const span = sl?.parentElement?.querySelector<HTMLElement>(
      'a[href^="/teams/"] span.truncate',
    );
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { shown: Math.round(r.width), needs: span.scrollWidth };
  });
  expect(
    seasonName,
    "Seasons card team name not found — this assertion would otherwise measure nothing",
  ).not.toBeNull();
  expect(
    seasonName!.shown / seasonName!.needs,
    `Seasons row team name collapsed: ${seasonName!.shown}px of ${seasonName!.needs}px`,
  ).toBeGreaterThan(0.6);
  assertNoErrors();
});

// The pages carrying the most links per pixel — leaderboards, the pool, the
// cross-table — are where a 16px text link hides most easily.
for (const [label, path] of [
  ["/leaders", "/leaders"],
  ["/players", "/players"],
  ["/schedule", "/schedule"],
  ["/", "/"],
] as const) {
  test(`${label} tap targets clear WCAG 2.5.8`, async ({ page }) => {
    const assertNoErrors = trackPageErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await page.waitForTimeout(1200);
    await expectTapTargets(page, label);
    assertNoErrors();
  });
}
