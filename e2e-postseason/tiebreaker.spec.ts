import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { POSTSEASON_DB_URL } from "../playwright.postseason.config";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
} from "../e2e-mid/helpers";

async function expectFinalTracker(
  page: import("@playwright/test").Page,
  qualified: string[],
  eliminated: string[],
) {
  await page.goto("/schedule");
  await page.locator("summary").filter({ hasText: "Playoff race & possible matchups" }).click();
  for (const [names, status] of [
    [qualified, "Qualified for playoffs"],
    [eliminated, "Eliminated"],
  ] as const) {
    for (const name of names) {
      const href = await page.getByRole("link", { name, exact: true }).first().getAttribute("href");
      expect(href).toMatch(/^\/teams\//);
      const teamId = href!.split("/").pop()!;
      const outlook = page.locator(`[data-testid="playoff-outlook"][data-team-id="${teamId}"]`).first();
      await expect(outlook.getByTestId("playoff-status")).toContainText(status);
      await expect(outlook).not.toContainText("Waiting on other results");
    }
  }
}

test("a tied playoff place requires a BO3 extra week before the bracket starts", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsx", "test/fixtures/stage-tiebreaker.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: POSTSEASON_DB_URL },
      stdio: "pipe",
    },
  );
  expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
  const assertNoErrors = trackPageErrors(page);
  page.on("dialog", (dialog) => dialog.accept());
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/api/auth/dev?name=Tiebreaker%20Admin&admin=1");
  await page.goto("/admin#playoffs");
  const start = page.getByRole("button", {
    name: "Start playoffs",
    exact: true,
  });
  await expect(start).toBeDisabled();
  await page
    .getByRole("button", { name: "Schedule tiebreaker week", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reset tiebreaker week", exact: true }),
  ).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Schedule tiebreaker week", exact: true }),
  ).toHaveCount(0);
  await page
    .locator("#playoffs")
    .screenshot({ path: testInfo.outputPath("admin-tiebreaker-pending.png") });

  await page.goto("/schedule#tiebreakers");
  const extraWeek = page.locator("#tiebreakers");
  await expect(
    extraWeek.getByText("Tiebreaker week · Week 6 · Best of 3", {
      exact: true,
    }),
  ).toBeVisible();
  const match = extraWeek.locator('a[href^="/matches/"]');
  await expect(match).toHaveCount(1);
  const matchHref = await match.getAttribute("href");
  expect(matchHref).toBeTruthy();
  await extraWeek.screenshot({
    path: testInfo.outputPath("schedule-tiebreaker-pending.png"),
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page, "tiebreaker schedule");
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Tiebreaker week · Week 6",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Tiebreaker pending", { exact: true })).toHaveCount(2);
  await expectNoHorizontalOverflow(page, "tiebreaker dashboard");
  await page.screenshot({ path: testInfo.outputPath("home-tiebreaker-pending-mobile.png"), fullPage: true });
  await page.goto(matchHref!);
  await expect(
    page.getByText("Playoff tiebreaker · Best of 3.", { exact: true }),
  ).toBeVisible();

  await page.goto("/admin#adm-schedule");
  const result = page
    .locator("details")
    .filter({
      has: page
        .locator("summary")
        .filter({ hasText: "Tiebreaker week · Week 6 · Best of 3" }),
    });
  await expect(result).toBeVisible();
  const form = result.locator('form:has(input[name="homeScore"])');
  const winnerName = (await form
    .locator('input[name="awayScore"]')
    .getAttribute("aria-label"))!.replace(/ series score$/, "");
  const loserName = (await form
    .locator('input[name="homeScore"]')
    .getAttribute("aria-label"))!.replace(/ series score$/, "");
  await form.locator('input[name="homeScore"]').fill("1");
  await form.locator('input[name="awayScore"]').fill("2");
  await form
    .getByRole("button", { name: "Save as final", exact: true })
    .click();
  await expect(start).toBeEnabled();
  await expect(
    page.getByText("The tiebreaker results have settled the playoff order.", {
      exact: false,
    }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "tiebreaker admin");
  await page.setViewportSize({ width: 1366, height: 900 });
  await page
    .locator("#playoffs")
    .screenshot({ path: testInfo.outputPath("admin-tiebreaker-resolved.png") });
  await expectFinalTracker(page, [winnerName], [loserName]);
  await page.goto("/admin#playoffs");
  await start.click();
  await expect(
    page.getByRole("button", { name: "Reset playoffs", exact: true }),
  ).toBeVisible();
  await page.goto("/schedule#playoff-bracket");
  await expect(
    page
      .locator("#playoff-bracket")
      .getByRole("heading", { name: "Playoff bracket", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#playoff-bracket")).toContainText(winnerName);
  await expect(page.locator("#playoff-bracket")).not.toContainText(loserName);
  await expect(page.locator("#tiebreakers")).toContainText(
    "1 of 1 series complete",
  );
  assertNoErrors();
});

for (const resetFinal of [false, true]) {
  test(`three tied teams resolve qualification and seeding in ${resetFinal ? 5 : 4} BO1 games in one week`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", "test/fixtures/stage-tiebreaker.ts", "--three"],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: POSTSEASON_DB_URL }, stdio: "pipe" },
    );
    expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
    const assertNoErrors = trackPageErrors(page);
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto("/api/auth/dev?name=Tiebreaker%20Admin&admin=1");
    await page.goto("/admin#playoffs");
    const start = page.getByRole("button", { name: "Start playoffs", exact: true });
    await expect(start).toBeDisabled();
    await expect(page.locator("#playoffs")).toContainText("Opening matchup and bye drawn when scheduled");
    await page.getByRole("button", { name: "Schedule tiebreaker week", exact: true }).click();
    await expect(page.locator("#playoffs")).toContainText("Opening bye drawn:");

    await page.goto("/schedule#tiebreakers");
    const extraWeek = page.locator("#tiebreakers");
    await expect(extraWeek.getByText("Tiebreaker week · Week 6 · Best of 1", { exact: true })).toBeVisible();
    await expect(extraWeek).toContainText("four games, or five if the final needs a reset");
    const opening = extraWeek.locator('a[href^="/matches/"]');
    await expect(opening).toHaveCount(1);
    await opening.click();
    await expect(page.getByText("Playoff tiebreaker · Best of 1.", { exact: true })).toBeVisible();
    await page.goto("/admin#adm-schedule");
    const results = page.locator("details").filter({
      has: page.locator("summary").filter({ hasText: "Tiebreaker week · Week 6 · Best of 1" }),
    });
    const totalGames = resetFinal ? 5 : 4;
    let thirdPlace = "";
    let firstPlace = "";
    let secondPlace = "";
    for (let stage = 1; stage <= totalGames; stage++) {
      await expect(start).toBeDisabled();
      const form = results.locator('form:has(input[name="homeScore"])');
      await expect(form).toHaveCount(1);
      const homeName = (await form.locator('input[name="homeScore"]').getAttribute("aria-label"))!.replace(/ series score$/, "");
      const awayName = (await form.locator('input[name="awayScore"]').getAttribute("aria-label"))!.replace(/ series score$/, "");
      const awayWins = resetFinal && stage === 4;
      if (stage === 3) thirdPlace = awayName;
      if (stage === totalGames) {
        firstPlace = awayWins ? awayName : homeName;
        secondPlace = awayWins ? homeName : awayName;
      }
      await form.locator('input[name="homeScore"]').fill(awayWins ? "0" : "1");
      await form.locator('input[name="awayScore"]').fill(awayWins ? "1" : "0");
      await form.getByRole("button", { name: "Save as final", exact: true }).click();
      // A new fixture is created automatically after each decisive result.
      await expect(results.locator('a[href^="/matches/"]')).toHaveCount(Math.min(stage + 1, totalGames));
      if (stage === 3) {
        await expectFinalTracker(page, [], [thirdPlace]);
        await page.goto("/admin#adm-schedule");
      }
    }
    await expect(start).toBeEnabled();
    await expect(page.locator("#playoffs")).toContainText("The tiebreaker results have settled the playoff order.");
    await page.locator("#playoffs").screenshot({ path: testInfo.outputPath("three-team-resolved.png") });
    await expectFinalTracker(page, [firstPlace, secondPlace], [thirdPlace]);
    await page.goto("/admin#playoffs");
    await start.click();
    await expect(page.getByRole("button", { name: "Reset playoffs", exact: true })).toBeVisible();
    await page.goto("/schedule#playoff-bracket");
    await expect(extraWeek).toContainText(`${totalGames} of ${totalGames} series complete`);
    await expect(extraWeek).not.toContainText("Week 7");
    await expect(page.locator("#playoff-bracket")).toContainText(firstPlace);
    await expect(page.locator("#playoff-bracket")).toContainText(secondPlace);
    await expect(page.locator("#playoff-bracket")).not.toContainText(thirdPlace);
    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoHorizontalOverflow(page, "three-team tiebreaker schedule");
    await extraWeek.screenshot({ path: testInfo.outputPath("three-team-schedule-mobile.png") });
    assertNoErrors();
  });
}

test("live best-of-two tracker only offers results still possible at 1–0", async ({ page }) => {
  test.setTimeout(90_000);
  const output = execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsx", "test/fixtures/stage-tiebreaker.ts", "--live"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: POSTSEASON_DB_URL }, encoding: "utf8" },
  );
  const fixture = JSON.parse(output.trim().split("\n").at(-1)!) as {
    liveMatchId: string; homeTeamId: string; awayTeamId: string;
  };
  expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
  const assertNoErrors = trackPageErrors(page);
  await page.goto(`/matches/${fixture.liveMatchId}`);
  const home = page.locator(`[data-testid="playoff-outlook"][data-team-id="${fixture.homeTeamId}"]`);
  const away = page.locator(`[data-testid="playoff-outlook"][data-team-id="${fixture.awayTeamId}"]`);
  await expect(home.getByTestId("playoff-paths").getByText("Win", { exact: true })).toBeVisible();
  await expect(home.getByTestId("playoff-paths").getByText("Draw", { exact: true })).toBeVisible();
  await expect(home.getByTestId("playoff-paths").getByText("Loss", { exact: true })).toHaveCount(0);
  await expect(away.getByTestId("playoff-paths").getByText("Draw", { exact: true })).toBeVisible();
  await expect(away.getByTestId("playoff-paths").getByText("Loss", { exact: true })).toBeVisible();
  await expect(away.getByTestId("playoff-paths").getByText("Win", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page, "live playoff tracker");
  assertNoErrors();
});
