import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { POSTSEASON_DB_URL } from "../playwright.postseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "../e2e-mid/helpers";

// Seasons in layouts an admin chose in the season builder, which the
// team-count rule never made, through the public pages: the standings and
// their cut, the season plan, /rules, the bracket and the teams page.

async function seed(
  page: Page,
  mode: "regular" | "playoffs" | "complete",
  teams: number,
  layout: { groups: number; meet: number; playoffs: number },
) {
  execFileSync(process.execPath, ["--import", "tsx", "e2e-postseason/seed.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: POSTSEASON_DB_URL,
      FIXTURE_MODE: mode,
      FIXTURE_TEAMS: String(teams),
      FIXTURE_FORMAT: JSON.stringify({ v: 1, ...layout }),
    },
    stdio: "pipe",
  });
  expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
}

test("two groups sending the top 2 of each: group tables, their cut, the plan and /rules", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await seed(page, "regular", 13, { groups: 2, meet: 1, playoffs: 4 });
  const assertNoErrors = trackPageErrors(page);

  await page.goto("/schedule");
  for (const key of ["A", "B"]) {
    await expect(
      page.getByRole("table", { name: `Group ${key} standings`, exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByRole("table", { name: "League standings", exact: true })).toHaveCount(0);
  const standings = page.locator("#standings");
  await expect(standings.getByText("Playoff cut · 2 places")).toHaveCount(2);
  await expect(standings).toContainText("Top 2 of each group make the playoffs");
  const plan = page.locator("details").filter({ hasText: "Season plan" });
  await expect(plan).toContainText("Two groups of 7 and 6");
  await plan.locator("summary").click();
  const steps = plan.getByRole("list", { name: "Season plan" });
  await expect(steps).toContainText("Semifinals");
  await expect(steps).toContainText("Grand final");
  await expect(steps).not.toContainText("Quarterfinals");
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page, "/schedule, two groups top 2 of each");
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/");
  await expect(page.getByRole("table", { name: "Group A standings", exact: true })).toBeVisible();

  await page.goto("/rules");
  await expect(page.locator("#format")).toContainText("This season has 13 teams: two groups of 7 and 6.");
  await expect(page.locator("#format")).not.toContainText("the plan until the schedule is made");
  await expect(page.locator("#playoffs")).toContainText(
    "This season plays two groups, and the top 2 of each group make the playoffs.",
  );
  assertNoErrors();
});

test("two groups sending the top 2 of each: semifinals across the groups", async ({ page }) => {
  test.setTimeout(180_000);
  await seed(page, "playoffs", 13, { groups: 2, meet: 1, playoffs: 4 });
  const assertNoErrors = trackPageErrors(page);

  await page.goto("/schedule");
  const bracket = page.getByRole("region", { name: "Playoff bracket" });
  await expect(bracket).toBeVisible();
  await expect(bracket.getByRole("heading", { name: "Quarterfinals" })).toHaveCount(0);
  await expect(bracket.getByRole("heading", { name: /Semifinals/ }).first()).toBeVisible();
  for (const seed of ["A1", "B1", "A2", "B2"]) {
    await expect(bracket.getByText(seed, { exact: true }).first()).toBeVisible();
  }
  await expect(bracket.getByText("A3", { exact: true })).toHaveCount(0);

  await page.goto("/teams");
  const rosters = page.getByRole("region", { name: "Team rosters" });
  await expect(rosters.getByText("Missed the playoffs", { exact: true })).toHaveCount(9);
  assertNoErrors();
});

test("two groups sending their winners: a grand final and nothing before it", async ({ page }) => {
  test.setTimeout(180_000);
  await seed(page, "complete", 7, { groups: 2, meet: 1, playoffs: 2 });
  const assertNoErrors = trackPageErrors(page);

  await page.goto("/schedule");
  const bracket = page.getByRole("region", { name: "Playoff bracket" });
  await expect(bracket).toBeVisible();
  await expect(bracket.getByRole("heading", { name: /Semifinals|Quarterfinals/ })).toHaveCount(0);
  await expect(bracket.getByText("A1", { exact: true }).first()).toBeVisible();
  await expect(bracket.getByText("B1", { exact: true }).first()).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page, "/schedule, a bracket that is only the final");
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/rules");
  await expect(page.locator("#playoffs")).toContainText(
    "The two group winners play the grand final, and Group A's winner hosts.",
  );
  assertNoErrors();
});

test("one table of 9 sending 8, and a table played twice", async ({ page }) => {
  test.setTimeout(180_000);
  await seed(page, "regular", 9, { groups: 1, meet: 1, playoffs: 8 });
  const assertNoErrors = trackPageErrors(page);

  await page.goto("/schedule");
  await expect(page.getByRole("table", { name: "League standings", exact: true })).toBeVisible();
  const standings = page.locator("#standings");
  await expect(standings.getByText("Playoff cut · 8 places")).toHaveCount(1);
  await expect(standings).toContainText("8 playoff places");
  await page.goto("/rules");
  await expect(page.locator("#playoffs")).toContainText("This season's top 8 make the playoffs.");

  await seed(page, "regular", 6, { groups: 1, meet: 2, playoffs: 4 });
  await page.goto("/schedule");
  const plan = page.locator("details").filter({ hasText: "Season plan" });
  await expect(plan).toContainText("One table, played twice");
  assertNoErrors();
});
