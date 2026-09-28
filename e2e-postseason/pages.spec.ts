import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { POSTSEASON_DB_URL } from "../playwright.postseason.config";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
} from "../e2e-mid/helpers";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

for (const archived of [false, true]) {
  test(`How it works points to what's next ${archived ? "when the next season opens" : "after the final"}`, async ({
    page,
  }) => {
    const assertNoErrors = trackPageErrors(page);
    await reseed(page, "complete", archived);
    await page.goto("/how-it-works");
    const main = page.locator("#main");
    if (archived) {
      // The next season is in signups: its one button is the header's join
      // link ("Season 10 (fixture)" is too long to name).
      await expect(
        main.getByRole("link", { name: "Join the season" }),
      ).toHaveAttribute("href", "/login?next=/me");
    } else {
      // A finished season has nothing to sign up for until the next one.
      await expect(main.getByRole("link", { name: /^Join the season/ })).toHaveCount(0);
      await expect(
        main.getByRole("link", { name: "Sign up as a standin" }),
      ).toHaveCount(0);
    }
    await expect(page.locator('main a[href="/draft"]')).toHaveCount(0);
    assertNoErrors();
  });
}

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
  // The schedule keeps one name in every phase; the page's own heading is
  // what says "Playoffs".
  const primaryNav = page.getByRole("navigation", { name: "Primary" }).first();
  await expect(
    primaryNav.getByRole("link", { name: "Schedule", exact: true }),
  ).toBeVisible();
  await expect(
    primaryNav.getByRole("link", { name: "Playoffs", exact: true }),
  ).toHaveCount(0);
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
  // Mid-playoffs the phase card has no forward button (Complete is automatic),
  // and every other phase move sits in the folded "Fix the phase" section,
  // which stays shut because nothing needs fixing.
  const fixPhase = page.locator("summary", { hasText: "Fix the phase" });
  await expect(fixPhase.locator("xpath=..")).not.toHaveAttribute("open", "");
  await fixPhase.click();
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
    page.getByRole("button", { name: "Regenerate schedule", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/A regular-season result or imported game already exists/i),
  ).toBeVisible();
  // The Playoffs card lists the series still to play; the decided ones and
  // the two bracket repairs are folded away beneath them.
  const playoffs = page.locator("#playoffs");
  await expect(
    playoffs.getByRole("heading", { name: /Series to play/ }),
  ).toBeVisible();
  const decided = playoffs.locator("summary", { hasText: "Decided series" });
  await expect(decided.locator("xpath=..")).not.toHaveAttribute("open", "");
  await decided.click();
  await expect(
    playoffs.getByText(/already advanced a later playoff round/i).first(),
  ).toBeVisible();
  const fixBracket = playoffs.locator("summary", {
    hasText: "Fix the bracket",
  });
  await expect(fixBracket.locator("xpath=..")).not.toHaveAttribute("open", "");
  await fixBracket.click();
  await expect(
    page.getByRole("button", { name: "Reset playoffs", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: "Return to regular season",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Open signups" }),
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

  // Phones lead with the round list; the drawn bracket (wider than a phone
  // once it has wings) is folded underneath it until asked for.
  const section = page.locator("#playoff-bracket");
  const scroller = page.getByRole("region", { name: "Playoff bracket" });
  await expect(scroller).toBeHidden();
  await expect(
    section.getByRole("button", { name: /^Quarterfinals/ }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/schedule postseason round list");
  await section.locator("summary").filter({ hasText: "Full bracket" }).click();
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

// Mid-semifinals: all four quarterfinals played, one semifinal played, the
// other still to come. Each /teams card says where its team stands, teams
// still alive lead, and an eliminated team's own page says it is out.
const PLAYOFF_STATUS =
  /^(Through to the (grand final|semifinals)|(Quarterfinal|Semifinal|Grand final) vs .+|Out in the (quarterfinal|semifinal|grand final) \(lost .+\)|Champion|Runner-up \(lost the grand final .+\)|Missed the playoffs)$/;

async function playoffStatusLines(page: Page): Promise<string[]> {
  // allTextContents() does not wait. After goto the rosters can still sit in
  // React's hidden streaming container (<div hidden id="S:…">) until the
  // Suspense reveal runs, where the role query finds no region at all. Wait
  // for the region to be revealed; the boundary swaps in whole, so every
  // card's status line is there once it is.
  const rosters = page.getByRole("region", { name: "Team rosters" });
  await expect(rosters).toBeVisible();
  const texts = await rosters.locator("p").allTextContents();
  return texts.map((text) => text.trim()).filter((text) => PLAYOFF_STATUS.test(text));
}

test("teams say where each one stands in the playoffs", async ({ page }) => {
  await reseed(page, "playoffs");
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/teams");

  const statuses = await playoffStatusLines(page);
  expect(statuses).toHaveLength(8);
  // Alive first (the grand finalist and both teams in the open semifinal),
  // then the semifinal loser, then the four quarterfinal losers.
  expect(statuses[0]).toBe("Through to the grand final");
  expect(statuses.slice(1, 3).every((text) => /^Semifinal vs /.test(text))).toBe(true);
  expect(statuses[3]).toMatch(/^Out in the semifinal \(lost 0–2 to .+\)$/);
  for (const text of statuses.slice(4)) {
    expect(text).toMatch(/^Out in the quarterfinal \(lost 1–2 to .+\)$/);
  }
  const rosters = page.getByRole("region", { name: "Team rosters" });
  // Each card's summary line leads with its seed ("Seed 2 · Regular season
  // 5W 0D 2L · 15 pts").
  await expect(rosters.getByText(/^Seed [1-8]$/)).toHaveCount(8);
  await expectNoHorizontalOverflow(page, "/teams playoffs");

  // The last card is a quarterfinal loser; its page says so and shows its seed.
  await rosters.locator('a[href^="/teams/"]').last().click();
  await expect(page).toHaveURL(/\/teams\/[^/]+$/);
  await expect(
    page.locator("#main p", { hasText: /^Out in the quarterfinal \(lost 1–2 to / }),
  ).toBeVisible();
  await expect(page.getByText(/^Seed #[5-8]$/)).toBeVisible();
  // It met its quarterfinal opponent in the round robin too, so that one
  // opponent, and only that one, is in its Head-to-head card.
  await expect(
    page.getByRole("heading", { name: "Head-to-head", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#team-rivals li")).toHaveCount(1);
  await expectNoHorizontalOverflow(page, "/teams/[id] eliminated");
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
    page
      .getByRole("navigation", { name: "Primary" })
      .first()
      .getByRole("link", { name: "Schedule", exact: true }),
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

  // The recap lives on the season's own page; /recap redirects there.
  await page.goto("/recap");
  await expect(page).toHaveURL(/\/seasons\/[^/?#]+$/);
  const seasonPage = new URL(page.url()).pathname;
  await expect(
    page.getByRole("heading", {
      name: "Season 9 (fixture)",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Season 9 (fixture) Champion", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(champion, { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Season awards" }),
  ).toBeVisible();
  await expect(
    page.getByText("Completed series", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Imported games", { exact: true })).toBeVisible();
  await expectStatValue(page, "Completed series", 35);
  await expectStatValue(page, "Imported games", 74);

  // A finished season's boards point at that page too.
  await page.goto("/leaders");
  await expect(
    page.locator("#main").getByRole("link", {
      name: "Season recap",
      exact: true,
    }),
  ).toHaveAttribute("href", seasonPage);

  await page.goto("/fantasy");
  await expect(
    page.getByRole("heading", { name: "Fantasy", exact: true }),
  ).toBeVisible();
  // A signed-out visitor gets the final standings, with no lineup section.
  await expect(
    page.getByText(/Season complete: these are the final standings/),
  ).toBeVisible();
  await expect(
    page.getByText(/season complete — these are the final fives/i),
  ).toHaveCount(0);
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
  // The manager still gets their own five, below the standings.
  await expect(
    page.getByText(/season complete — these are the final fives/i),
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
  // One "Your picks" list: the graded call and the void one, each marked.
  const yourPicks = page.locator("section").filter({
    has: page.getByRole("heading", { name: /^Your picks/ }),
  });
  await expect(
    yourPicks.getByRole("img", { name: "Correct pick" }),
  ).toBeVisible();
  await expect(yourPicks.getByRole("img", { name: "Void pick" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Your (graded|void|locked) picks/ }),
  ).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "/pickem completed side game");

  // The finished match itself tells the picker how the call went. The
  // seeded viewer is the only one who picked it, and picked the winner.
  await yourPicks
    .getByRole("img", { name: "Correct pick" })
    .locator("xpath=..")
    .getByRole("link")
    .first()
    .click();
  await expect(page).toHaveURL(/\/matches\//);
  await expect(page.getByText(/Your pick:/)).toContainText(
    "(1 of 1 called it)",
  );

  assertNoErrors();
});

test("complete champion and recap remain usable at 360px", async ({ page }) => {
  await reseed(page, "complete");
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });

  // "/recap" lands on the season page, awards included.
  for (const path of ["/", "/schedule", "/recap"] as const) {
    await page.goto(path);
    await expect(
      page.getByText("Season 9 (fixture) Champion", { exact: true }),
    ).toBeVisible();
    if (path === "/recap") {
      await expect(
        page.getByRole("region", { name: "Season awards" }),
      ).toBeVisible();
    }
    await expectNoHorizontalOverflow(page, `${path} completed postseason`);
  }

  // Teams lead with the champion and the runner-up.
  await page.goto("/teams");
  const statuses = await playoffStatusLines(page);
  expect(statuses[0]).toBe("Champion");
  expect(statuses[1]).toMatch(/^Runner-up \(lost the grand final .+\)$/);
  await expectNoHorizontalOverflow(page, "/teams completed postseason");

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

  // Once the champion is crowned, the handoff leads the page: one form to
  // open the next season, prefilled and stating what carries over.
  await expect(
    page.getByRole("heading", { name: "Season handoff", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Open Season 10 signups" }),
  ).toBeVisible();
  await expect(page.getByLabel("New season name")).toHaveValue("Season 10");
  await expect(
    page.getByText(/Carried over from Season 9 \(fixture\):/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open signups" })).toBeVisible();
  // The finished season's own cards fold into one record section.
  await expect(
    page.getByRole("heading", { name: "Season 9 (fixture) record" }),
  ).toBeVisible();
  await expect(page.locator("#adm-record")).not.toHaveAttribute("open", "");
  // Archiving without opening the next season is folded away, for
  // reactivating an older season.
  await expect(
    page.getByRole("button", { name: "Archive and enter offseason" }),
  ).toBeHidden();
  await page.getByText("Archive without opening the next season").click();
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
    page.getByRole("link", { name: "Review Season 9 (fixture)" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/ offseason home");

  await page.goto("/how-it-works");
  // Between seasons the page's one button is the league Discord (League
  // news where the region has no invite), never a signup.
  await expect(
    page.locator("#main").getByRole("link", { name: "Sign up as a standin" }),
  ).toHaveCount(0);
  await expect(
    page.locator("#main").getByRole("link", {
      name: /^(Join our Discord|League news)$/,
    }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/how-it-works offseason");

  for (const [path, heading] of [
    ["/players", "Players"],
    ["/teams", "Teams"],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("League offseason", { exact: true }),
    ).toBeVisible();
    // The footer lists Season history too; this is the page's own pointer.
    await expect(
      page.locator("#main").getByRole("link", { name: "Season history" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page, `${path} offseason`);
  }

  // With no season running, the season pages open on the last season
  // instead of an empty "No active season" screen.
  for (const [path, heading] of [
    ["/leaders", "Leaders"],
    ["/pickem", "Pick'em"],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: heading, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText(/Season 9 \(fixture\) · archived/).first(),
    ).toBeVisible();
    await expect(page.getByText("No active season")).toHaveCount(0);
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
  await page.getByLabel("New season name").fill("Season 10 (audit)");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Open signups" }).click();
  await expect(page.getByText(/Created Season 10 \(audit\)/)).toBeVisible();
  await expect(
    page.getByText(/Season 10 \(audit\) — phase control/),
  ).toBeVisible();

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
  await expect(page).toHaveURL(/\/seasons\//);
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
  await expect(page).toHaveURL(/\/seasons\//);
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
  await expect(page.getByText("Archived season", { exact: true })).toBeVisible();
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
  // The season's recap is part of its page now.
  await expect(
    page.getByRole("region", { name: "Season awards" }),
  ).toBeVisible();
  await expectStatValue(page, "Completed series", 35);
  await expect(
    page.locator("#main").getByRole("link", {
      name: "Season recap",
      exact: true,
    }),
  ).toHaveCount(0);
  // The season page uses Schedule's head-to-head grid, the league's one
  // results grid.
  await expect(
    page.getByRole("table", { name: /^Head-to-head results\./ }),
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
      page.locator("#main").getByRole("link", {
        name: "Season recap",
        exact: true,
      }),
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

  // An old recap link (the champion post in Discord) lands on the same page.
  await page.goto(`/recap?season=${archivedSeasonId}`);
  await expect(page).toHaveURL(
    new RegExp(`/seasons/${archivedSeasonId}$`),
  );
  await expect(
    page.getByText("Season 9 (fixture) Champion", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Season awards" }),
  ).toBeVisible();

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
  const archivedPicks = page.locator("section").filter({
    has: page.getByRole("heading", { name: /^Your picks/ }),
  });
  await expect(
    archivedPicks.getByRole("img", { name: "Correct pick" }),
  ).toBeVisible();
  await expect(
    archivedPicks.getByRole("img", { name: "Void pick" }),
  ).toBeVisible();

  assertNoErrors();
});
