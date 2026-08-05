import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { POSTSEASON_DB_URL } from "../playwright.postseason.config";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
} from "../e2e-mid/helpers";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

async function expireFixtureCache(page: Page) {
  const cache = await page.request.post("/api/test/cache");
  expect(cache.ok()).toBe(true);
}

async function reseed(
  page: Page,
  mode: "playoffs" | "complete",
  archive = false,
) {
  const env = {
    ...process.env,
    DATABASE_URL: POSTSEASON_DB_URL,
    FIXTURE_MODE: mode,
  };
  execFileSync(npx, ["tsx", "e2e-postseason/seed.ts"], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
  execFileSync(npx, ["tsx", "e2e-postseason/seed-side-games.ts"], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
  if (archive) {
    execFileSync(npx, ["tsx", "e2e-postseason/archive.ts"], {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    });
  }
  await expireFixtureCache(page);
}

async function removeImportedGames(page: Page) {
  execFileSync(npx, ["tsx", "e2e-postseason/remove-games.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: POSTSEASON_DB_URL,
    },
    stdio: "pipe",
  });
  await expireFixtureCache(page);
}

async function corruptChampion(page: Page) {
  execFileSync(npx, ["tsx", "e2e-postseason/corrupt-champion.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: POSTSEASON_DB_URL,
    },
    stdio: "pipe",
  });
  await expireFixtureCache(page);
}

async function championName(page: Page): Promise<string> {
  const label = page.getByText("Season 9 (fixture) Champion", { exact: true });
  await expect(label).toBeVisible();
  const name = (
    await label.locator("..").locator('a[href^="/teams/"]').textContent()
  )?.trim();
  expect(name).toBeTruthy();
  return name!;
}

async function expectStatValue(
  page: Page,
  label: string,
  expected: number | string,
) {
  const stat = page.getByText(label, { exact: true }).locator("..");
  await expect(stat.locator(":scope > div").nth(1)).toHaveText(
    String(expected),
  );
}

test("mid-playoffs renders the real bracket and supports tracing a run", async ({
  page,
}) => {
  await reseed(page, "playoffs");
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Season 9 (fixture)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Playoffs", exact: true }).first(),
  ).toBeVisible();
  const bracket = page.getByRole("region", { name: "Playoff bracket" });
  await expect(bracket).toBeVisible();
  await expect(
    bracket.getByRole("heading", { name: "Quarterfinals", level: 3 }),
  ).toHaveCount(2);
  await expect(
    bracket.getByRole("heading", { name: "Semifinals", level: 3 }),
  ).toHaveCount(2);
  await expect(
    bracket.getByRole("heading", { name: "Grand final", level: 3 }),
  ).toBeVisible();
  await expect(
    bracket.getByRole("img", { name: "The trophy awaits" }),
  ).toBeVisible();
  await expect(bracket.getByText("TBD", { exact: true })).toHaveCount(2);
  await expect(
    bracket.getByRole("link", { name: /final at .*best of 3/i }),
  ).toHaveCount(5);
  await expect(
    bracket.getByRole("link", { name: /best of 3.*View match details/i }),
  ).toHaveCount(6);

  const traceButtons = bracket.locator('button[title^="Trace "]');
  await expect(traceButtons.first()).toBeVisible();
  const title = await traceButtons.first().getAttribute("title");
  expect(title).toBeTruthy();
  const sameTeam = bracket.getByTitle(title!, { exact: true });
  const occurrenceCount = await sameTeam.count();
  expect(occurrenceCount).toBeGreaterThan(1);
  await traceButtons.first().click();
  for (let index = 0; index < occurrenceCount; index++) {
    await expect(sameTeam.nth(index)).toHaveAttribute("aria-pressed", "true");
  }

  assertNoErrors();
});

test("postseason admin controls expose only safe phase and bracket recovery", async ({
  page,
}) => {
  await reseed(page, "playoffs");
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/api/auth/dev?name=Postseason%20Admin&admin=1");
  await page.goto("/admin");

  await expect(
    page.getByRole("heading", { name: "Admin", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Playoffs", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Regular season", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Complete", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByText(/Use Return to regular season so the existing bracket/i)
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reset playoffs", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Regenerate schedule", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/A regular-season result or imported game already exists/i),
  ).toBeVisible();
  await expect(
    page.getByText(/already advanced a later playoff round/i).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Return to regular season",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Create next season" }),
  ).toHaveCount(0);
  await page.locator("#adm-new-season > summary").click();
  await expect(page.getByText("Handoff locked", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Need to cancel this unfinished season?", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/admin postseason controls");

  assertNoErrors();
});

test("the playoff bracket scrolls inside itself at 360px, not across the page", async ({
  page,
}) => {
  await reseed(page, "playoffs");
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/schedule");

  const scroller = page.getByRole("region", { name: "Playoff bracket" });
  await expect(scroller).toBeVisible();
  const dimensions = await scroller.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  await expectNoHorizontalOverflow(page, "/schedule postseason bracket");

  await scroller.focus();
  const beforeArrow = await scroller.evaluate((element) => element.scrollLeft);
  await scroller.press("ArrowRight");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(beforeArrow);

  const trace = scroller.locator('button[title^="Trace "]').first();
  await trace.click();
  await expect(trace).toHaveAttribute("aria-pressed", "true");
  assertNoErrors();
});

test("complete-season public pages agree on the champion and recap", async ({
  page,
}) => {
  await reseed(page, "complete");
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");

  const champion = await championName(page);
  await expect(
    page.getByRole("link", { name: "Season results", exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Won the grand final")).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Champion crowned" }),
  ).toBeVisible();

  await page.goto("/schedule");
  await expect(
    page.getByText("Season 9 (fixture) Champion", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(champion, { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Champion crowned" }),
  ).toBeVisible();

  await page.goto("/recap");
  await expect(
    page.getByRole("heading", { name: "Season Recap" }),
  ).toBeVisible();
  await expect(
    page.getByText("Season 9 (fixture) Champion", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(champion, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Season awards")).toBeVisible();
  await expect(
    page.getByText("Completed series", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Imported games", { exact: true })).toBeVisible();
  await expectStatValue(page, "Completed series", 35);
  await expectStatValue(page, "Imported games", 74);

  await page.goto("/fantasy");
  await expect(
    page.getByRole("heading", { name: "Fantasy", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/season complete — these are the final fives/i),
  ).toBeVisible();
  await expect(page.getByText("Fantasy opens after the draft")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /save fantasy|update fantasy/i }),
  ).toHaveCount(0);

  await page.goto("/pickem");
  await expect(
    page.getByRole("heading", { name: "Pick'em", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Pick'em closed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Upcoming matches/ }),
  ).toHaveCount(0);
  await expect(page.locator("button[aria-pressed]")).toHaveCount(0);

  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto(
    "/api/auth/dev?name=Side%20Game%20Viewer&steamId=76561190000992001&redirect=/fantasy",
  );
  await expect(
    page.getByRole("heading", { name: "Fantasy standings" }),
  ).toBeVisible();
  await expect(
    page.locator("#main").getByRole("link", {
      name: "Side Game Viewer",
      exact: true,
    }),
  ).toBeVisible();
  const finalFive = page.getByText("View fantasy five", { exact: true });
  await expect(finalFive).toBeVisible();
  await finalFive.click();
  await expectNoHorizontalOverflow(page, "/fantasy completed side game");

  await page.goto("/pickem");
  await expect(
    page.getByRole("heading", { name: "Oracle board" }),
  ).toBeVisible();
  await expect(
    page.locator("#main").getByRole("link", {
      name: "Side Game Viewer",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your graded picks" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Your void picks/ }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/pickem completed side game");

  assertNoErrors();
});

test("feature tour calls COMPLETE league history, not active playoffs", async ({
  page,
}) => {
  await reseed(page, "complete");
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/features");

  const playoffs = page.getByRole("region", {
    name: "Win — or your season is over",
  });
  const history = page.getByRole("region", {
    name: "A champion joins league history",
  });
  await expect(playoffs.getByText("Happening now")).toHaveCount(0);
  await expect(history.getByText("Happening now")).toBeVisible();
  await expect(page.getByText("Five phases. One champion.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open this feature" }),
  ).toHaveCount(2);
  const obsessions = page.getByRole("region", { name: "Pick your obsession" });
  await expect(obsessions.getByRole("link", { name: "Pick'em" })).toBeVisible();
  await expect(obsessions.getByRole("link", { name: "Fantasy" })).toBeVisible();

  assertNoErrors();
});

test("complete champion and recap remain usable at 360px", async ({ page }) => {
  await reseed(page, "complete");
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });

  for (const path of ["/", "/schedule", "/recap"] as const) {
    await page.goto(path);
    await expect(
      page.getByText("Season 9 (fixture) Champion", { exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page, `${path} completed postseason`);
  }

  assertNoErrors();
});

test("admin can enter a real offseason, browse it, and open the next season", async ({
  page,
}) => {
  await reseed(page, "complete");
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto(
    "/api/auth/dev?name=Handoff%20Admin&steamId=76561190000993001&admin=1&redirect=/admin",
  );

  await expect(
    page.getByText("Season handoff", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Archive and enter offseason" }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Archive and enter offseason" })
    .click();
  await expect(page.getByText(/league is in the offseason/i)).toBeVisible();

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "League offseason" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review Season 9 (fixture) →" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/ offseason home");

  for (const [path, heading] of [
    ["/players", "Players"],
    ["/teams", "Teams"],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("League offseason", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Season history" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page, `${path} offseason`);
  }

  await page.goto("/seasons");
  await expect(page.getByText("Current", { exact: true })).toHaveCount(0);
  await expect(
    page.locator('a[href^="/seasons/"]', {
      hasText: "Season 9 (fixture)",
    }),
  ).toContainText("Complete");
  await expect(
    page.getByRole("button", { name: "↩ Reactivate for corrections" }),
  ).toBeEnabled();

  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Open a new season" }),
  ).toBeVisible();
  await page.getByLabel("Season name").fill("Season 10 (audit)");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Create season" }).click();
  await expect(page.getByText(/Created Season 10 \(audit\)/)).toBeVisible();
  await expect(page.getByText(/Season 10 \(audit\) — phase control/)).toBeVisible();

  await page.goto("/seasons");
  await expect(
    page.getByText("Reactivation is available from the offseason", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "↩ Enter offseason to reactivate" }),
  ).toBeDisabled();
  await expectNoHorizontalOverflow(page, "/seasons active reactivation lock");

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Season 10 (audit)" }),
  ).toBeVisible();
  await expect(
    page.locator("#main").getByText("Signups open", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/ next-season signups");
  assertNoErrors();
});

test("a conflicting stored champion is never presented as the title holder", async ({
  page,
}) => {
  await reseed(page, "complete");
  await corruptChampion(page);
  const assertNoErrors = trackPageErrors(page);

  await page.goto("/");
  await expect(
    page.getByText("Champion needs review", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: "Champion crowned" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("img", { name: "The trophy awaits" }),
  ).toBeVisible();

  await page.goto("/schedule");
  await expect(
    page.getByText("Champion state needs review", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: "Champion crowned" })).toHaveCount(
    0,
  );

  await page.goto("/recap");
  await expect(
    page.getByText("Champion state needs review", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Season 9 (fixture) Champion", { exact: true }),
  ).toHaveCount(0);

  assertNoErrors();
});

test("a champion recap remains complete without imported Dota games", async ({
  page,
}) => {
  await reseed(page, "complete");
  await removeImportedGames(page);
  const assertNoErrors = trackPageErrors(page);

  await page.goto("/recap");
  await expect(
    page.getByText("Season 9 (fixture) Champion", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Playoff bracket" }),
  ).toBeVisible();
  await expect(
    page.getByText("Completed series", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Imported games", { exact: true })).toBeVisible();
  await expectStatValue(page, "Completed series", 35);
  await expectStatValue(page, "Imported games", 0);
  await expect(page.getByText("No imported game stats")).toBeVisible();
  await expect(
    page.getByText(/Player awards need imported Dota games/),
  ).toBeVisible();

  assertNoErrors();
});

test("an archived champion season keeps its bracket, standings, and recap", async ({
  page,
}) => {
  await reseed(page, "complete", true);
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/seasons");

  const currentCard = page.locator('a[href^="/seasons/"]', {
    hasText: "Season 10 (fixture)",
  });
  await expect(currentCard).toContainText("Current");
  const archivedLink = page.locator('a[href^="/seasons/"]', {
    hasText: "Season 9 (fixture)",
  });
  await expect(archivedLink).toContainText("Complete");
  const archivedSeasonId = (await archivedLink.getAttribute("href"))
    ?.split("/")
    .pop();
  expect(archivedSeasonId).toBeTruthy();
  const champion = (await archivedLink.locator("b").textContent())?.trim();
  expect(champion).toBeTruthy();

  await archivedLink.click();
  await expect(page.getByText("Season archive", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Season 9 (fixture) Champion", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(champion!, { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Final standings" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Playoffs" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Playoff bracket" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Regular season results" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/seasons/[id] archived postseason");

  for (const [path, heading] of [
    [`/leaders?season=${archivedSeasonId}`, "Leaders"],
    [`/meta?season=${archivedSeasonId}`, "Hero meta"],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: heading, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText(/Season 9 \(fixture\).*archived/).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Season archive →" }),
    ).toHaveAttribute("href", `/seasons/${archivedSeasonId}`);
    const statsNav = page.getByRole("navigation", { name: "Statistics" });
    await expect(
      statsNav.getByRole("link", { name: "Leaders" }),
    ).toHaveAttribute("href", `/leaders?season=${archivedSeasonId}`);
    await expect(
      statsNav.getByRole("link", { name: "Hero meta" }),
    ).toHaveAttribute("href", `/meta?season=${archivedSeasonId}`);
    await expectNoHorizontalOverflow(page, `${path} archived stats`);
  }

  await page.goto(`/seasons/${archivedSeasonId}`);
  await page.getByRole("link", { name: "Season recap →" }).click();
  await expect(page).toHaveURL(/\/recap\?season=/);
  await expect(
    page.getByRole("heading", { name: "Season Recap" }),
  ).toBeVisible();
  await expect(
    page.getByText("Season 9 (fixture) Champion", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(champion!, { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Playoff bracket" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/recap archived postseason");

  await page.goto(
    "/api/auth/dev?name=Side%20Game%20Viewer&steamId=76561190000992001&redirect=/",
  );

  for (const [path, heading] of [
    [`/fantasy?season=${archivedSeasonId}`, "Fantasy"],
    [`/pickem?season=${archivedSeasonId}`, "Pick'em"],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await expect(page.locator("button[aria-pressed]")).toHaveCount(0);
    await expect(
      page.locator("#main").getByRole("link", {
        name: "Side Game Viewer",
        exact: true,
      }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page, `${path} archived side game`);
  }

  await page.goto(`/pickem?season=${archivedSeasonId}`);
  await expect(
    page.getByRole("heading", { name: "Your graded picks" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Your void picks/ }),
  ).toBeVisible();

  assertNoErrors();
});
