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
  const bracket = extraWeek.getByTestId("tiebreaker-bracket");
  await expect(bracket).toHaveAttribute("data-format", "BO3_ROUND_ROBIN");
  await expect(bracket.getByTestId("tiebreaker-game")).toHaveCount(1);
  const matchDetails = extraWeek.getByTestId("tiebreaker-match-details");
  await matchDetails.locator("summary").first().click();
  await expect(
    matchDetails.getByText("Tiebreaker week · Week 6 · Best of 3", {
      exact: true,
    }),
  ).toBeVisible();
  const match = bracket.locator('a[href^="/matches/"]');
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
  await expect(page.getByTestId("tiebreaker-match-details")).toContainText(
    "1 of 1 series complete",
  );
  assertNoErrors();
});

for (const resetFinal of [false, true]) {
  test(`three tied teams resolve qualification and seeding in ${resetFinal ? 5 : 4} BO1 games in one week`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const fixtureOutput = execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", "test/fixtures/stage-tiebreaker.ts", "--three"],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: POSTSEASON_DB_URL }, encoding: "utf8" },
    );
    const tiedTeamNames = fixtureOutput.trim().split("\n").at(-1)!
      .replace(/^Tiebreaker fixture ready: /, "")
      .replace(/ tied for third through fifth\.$/, "")
      .split(", ");
    expect(tiedTeamNames).toHaveLength(3);
    expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
    const assertNoErrors = trackPageErrors(page);
    page.on("dialog", (dialog) => dialog.accept());
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/api/auth/dev?name=Tiebreaker%20Admin&admin=1");
    await page.goto("/admin#playoffs");
    const start = page.getByRole("button", { name: "Start playoffs", exact: true });
    await expect(start).toBeDisabled();
    await expect(page.locator("#playoffs")).toContainText("Opening matchup and bye drawn when scheduled");
    await page.getByRole("button", { name: "Schedule tiebreaker week", exact: true }).click();
    await expect(page.locator("#playoffs")).toContainText("Opening bye drawn:");

    await page.goto("/schedule#tiebreakers");
    const extraWeek = page.locator("#tiebreakers");
    const bracket = extraWeek.getByTestId("tiebreaker-bracket");
    const matchDetails = extraWeek.getByTestId("tiebreaker-match-details");
    const game = (number: number) => bracket.locator(`[data-testid="tiebreaker-game"][data-game="${number}"]`);
    await expect(bracket).toHaveAttribute("data-format", "BO1_DOUBLE_ELIMINATION");
    await expect(bracket.getByRole("heading", { name: "Three-team tiebreaker", exact: true })).toBeVisible();
    await expect(bracket).toContainText("4–5 games · Every game best of 1");
    await expect(bracket.getByTestId("tiebreaker-game")).toHaveCount(5);
    for (const number of [1, 2, 3, 4, 5]) {
      await expect(game(number)).toBeVisible();
    }
    for (const name of tiedTeamNames) {
      await expect(bracket.getByTestId("tiebreaker-teams").getByText(name, { exact: true })).toBeVisible();
    }
    const byeRosterEntry = bracket.getByTestId("tiebreaker-teams")
      .locator("[data-team-id]")
      .filter({ hasText: "Opening bye → Game 2" });
    await expect(byeRosterEntry).toHaveCount(1);
    await expect(byeRosterEntry).toBeVisible();
    // Read the actual random opening draw, rather than assuming a seeded bye.
    const byeRosterText = await byeRosterEntry.innerText();
    const openingBye = tiedTeamNames.find((name) => byeRosterText.includes(name));
    expect(openingBye).toBeTruthy();
    await expect(game(2).getByText(openingBye!, { exact: true })).toBeVisible();
    await expect(game(1)).toHaveAttribute("data-status", "scheduled");
    for (const number of [2, 3, 4]) {
      await expect(game(number)).toHaveAttribute("data-status", "waiting");
    }
    await expect(game(5)).toHaveAttribute("data-status", "conditional");
    await expect(game(5).getByText("Only if the Game 3 winner wins Game 4.", { exact: true })).toBeVisible();
    for (const [number, sources] of [
      [2, ["Winner of Game 1"]],
      [3, ["Loser of Game 1", "Loser of Game 2"]],
      [4, ["Winner of Game 2", "Winner of Game 3"]],
    ] as const) {
      for (const source of sources) {
        await expect(game(number).getByText(source, { exact: true })).toBeVisible();
      }
    }
    await expect(matchDetails.getByText("Tiebreaker week · Week 6 · Best of 1", { exact: true })).not.toBeVisible();
    const opening = bracket.locator('a[href^="/matches/"]');
    await expect(opening).toHaveCount(1);
    await bracket.screenshot({ path: testInfo.outputPath("three-team-bracket-opening-desktop.png") });
    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoHorizontalOverflow(page, "three-team opening bracket");
    for (const number of [1, 2, 3, 4, 5]) {
      await expect(game(number)).toBeVisible();
    }
    await expect(byeRosterEntry).toBeVisible();
    await bracket.screenshot({ path: testInfo.outputPath("three-team-bracket-opening-mobile.png") });
    await opening.click();
    await expect(page.getByText("Playoff tiebreaker · Best of 1.", { exact: true })).toBeVisible();
    const fullBracketLink = page.getByRole("link", { name: "View full tiebreaker bracket →", exact: true });
    await expect(fullBracketLink).toHaveAttribute("href", "/schedule#tiebreakers");
    await expect(fullBracketLink).toBeVisible();
    await expectNoHorizontalOverflow(page, "three-team opening match context");
    await page.screenshot({ path: testInfo.outputPath("three-team-opening-match-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/admin#adm-schedule");
    const results = page.locator("details").filter({
      has: page.locator("summary").filter({ hasText: "Tiebreaker week · Week 6 · Best of 1" }),
    });
    const totalGames = resetFinal ? 5 : 4;
    let thirdPlace = "";
    let firstPlace = "";
    let secondPlace = "";
    const outcomes = new Map<number, { winner: string; loser: string }>();
    for (let stage = 1; stage <= totalGames; stage++) {
      await expect(start).toBeDisabled();
      const form = results.locator('form:has(input[name="homeScore"])');
      await expect(form).toHaveCount(1);
      const homeName = (await form.locator('input[name="homeScore"]').getAttribute("aria-label"))!.replace(/ series score$/, "");
      const awayName = (await form.locator('input[name="awayScore"]').getAttribute("aria-label"))!.replace(/ series score$/, "");
      const awayWins = resetFinal && stage === 4;
      outcomes.set(stage, {
        winner: awayWins ? awayName : homeName,
        loser: awayWins ? homeName : awayName,
      });
      if (stage === 1) {
        expect([homeName, awayName]).not.toContain(openingBye);
      }
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
      await page.goto("/schedule#tiebreakers");
      await expect(bracket.getByTestId("tiebreaker-game")).toHaveCount(5);
      for (let completed = 1; completed <= stage; completed++) {
        await expect(game(completed)).toHaveAttribute("data-status", "complete");
        const outcome = outcomes.get(completed)!;
        await expect(game(completed).getByText(outcome.winner, { exact: true })).toBeVisible();
        await expect(game(completed).getByText(outcome.loser, { exact: true })).toBeVisible();
      }
      if (stage < totalGames) {
        await expect(game(stage + 1)).toHaveAttribute("data-status", "scheduled");
        const nextTeams = stage === 1 ? [outcomes.get(1)!.winner, openingBye!]
          : stage === 2 ? [outcomes.get(1)!.loser, outcomes.get(2)!.loser]
          : [outcomes.get(2)!.winner, outcomes.get(3)!.winner];
        for (const name of nextTeams) {
          await expect(game(stage + 1).getByText(name, { exact: true })).toBeVisible();
        }
      }
      if (stage < 4) {
        await expect(game(5)).toHaveAttribute("data-status", "conditional");
      } else if (!resetFinal) {
        await expect(game(5)).toHaveAttribute("data-status", "not-needed");
        await expect(game(5).getByText("Not needed", { exact: true })).toBeVisible();
        await expect(game(5).locator('a[href^="/matches/"]')).toHaveCount(0);
      }
      await expect(bracket.locator('a[href^="/matches/"]')).toHaveCount(Math.min(stage + 1, totalGames));
      if (stage === 3) {
        const third = bracket.getByTestId("tiebreaker-placements").locator('[data-place="3"]');
        await expect(third).toContainText(thirdPlace);
        await expect(third).toContainText("Out of playoffs");
        await expectFinalTracker(page, [], [thirdPlace]);
      }
      await page.goto("/admin#adm-schedule");
    }
    await expect(start).toBeEnabled();
    await expect(page.locator("#playoffs")).toContainText("The tiebreaker results have settled the playoff order.");
    await page.locator("#playoffs").screenshot({ path: testInfo.outputPath("three-team-resolved.png") });
    await expectFinalTracker(page, [firstPlace, secondPlace], [thirdPlace]);
    await page.goto("/admin#playoffs");
    await start.click();
    await expect(page.getByRole("button", { name: "Reset playoffs", exact: true })).toBeVisible();
    await page.goto("/schedule#playoff-bracket");
    await expect(matchDetails).toContainText(`${totalGames} of ${totalGames} series complete`);
    await expect(matchDetails).not.toContainText("Week 7");
    const placements = bracket.getByTestId("tiebreaker-placements");
    for (const [place, name, outcome] of [
      [1, firstPlace, "Playoff seed 3"],
      [2, secondPlace, "Playoff seed 4"],
      [3, thirdPlace, "Out of playoffs"],
    ] as const) {
      const row = placements.locator(`[data-place="${place}"]`);
      await expect(row).toContainText(name);
      await expect(row).toContainText(outcome);
    }
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
