import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { POSTSEASON_DB_URL } from "../playwright.postseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "../e2e-mid/helpers";

for (const [flag, games] of [["--three", 1], ["--all", 7]] as const) {
  test(`new ${flag === "--three" ? "three" : "eight"}-team tiebreaker is clear in admin and finishes in one weekend`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    execFileSync(process.execPath, ["--import", "tsx", "test/fixtures/stage-tiebreaker.ts", flag], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: POSTSEASON_DB_URL }, stdio: "pipe",
    });
    expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
    const identity = await page.request.get("/api/health/release");
    expect((await identity.json()).region).toBe(process.env.NEXT_PUBLIC_LEAGUE_REGION ?? "us");
    const noErrors = trackPageErrors(page);
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto("/api/auth/dev?name=Weekend%20Admin&admin=1");
    await page.goto("/admin#playoffs");
    await expect(page.getByRole("button", { name: "Start playoffs", exact: true })).toBeDisabled();
    await expect(page.locator("#playoffs")).toContainText("Up to 3 games per team");
    await page.getByRole("button", { name: "Schedule tiebreaker week", exact: true }).click();
    const admin = page.locator("#adm-tiebreakers");
    await expect(admin.getByTestId("tiebreaker-bracket")).toHaveAttribute("data-format", "BO1_SINGLE_ELIMINATION");
    await expect(admin.getByTestId("tiebreaker-game")).toHaveCount(games);
    await expect(admin.getByTestId("admin-tiebreaker-match")).toHaveCount(flag === "--all" ? 4 : 1);
    await expect(admin).toContainText("no scheduled break");
    await page.goto("/schedule#tiebreakers");
    const bracket = page.locator("#tiebreakers").getByTestId("tiebreaker-bracket");
    await expect(bracket).toContainText("Up to 3 games per team");
    if (flag === "--three") await expect(bracket.getByTestId("tiebreaker-byes")).toContainText("bye into playoffs");
    await bracket.getByText("Published draw & final order", { exact: true }).click();
    const draw = await bracket.getByTestId("tiebreaker-draw").locator("li").allTextContents();
    await expect(bracket.getByTestId("tiebreaker-draw").locator("li")).toHaveCount(flag === "--all" ? 8 : 3);
    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoHorizontalOverflow(page, "weekend bracket mobile");
    await page.screenshot({ path: testInfo.outputPath("weekend-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1366, height: 900 });
    await bracket.screenshot({ path: testInfo.outputPath("weekend-desktop.png") });
    const matchLink = bracket.locator('a[href^="/matches/"]').first();
    await matchLink.click();
    await expect(page.getByText("Playoff tiebreaker · Best of 1.", { exact: true })).toBeVisible();
    await expect(page.getByText(/The next game starts when both opponents are ready/)).toBeVisible();
    await page.goto("/admin#adm-tiebreakers");
    const played = new Map<string, number>();
    for (let i = 0; i < games; i++) {
      const ready = admin.getByTestId("tiebreaker-game").filter({ has: page.getByText("Scheduled", { exact: true }) }).first();
      const target = await ready.getByRole("link", { name: "Manage game →", exact: true }).getAttribute("href");
      expect(target).toMatch(/^#admin-tiebreaker-match-/);
      await ready.getByRole("link", { name: "Manage game →", exact: true }).click();
      const form = page.locator(target!).locator('form:has(input[name="homeScore"])');
      for (const side of ["homeScore", "awayScore"]) {
        const name = await form.locator(`input[name="${side}"]`).getAttribute("aria-label");
        played.set(name!, (played.get(name!) ?? 0) + 1);
      }
      await form.locator('input[name="homeScore"]').fill("1");
      await form.locator('input[name="awayScore"]').fill("0");
      await form.getByRole("button", { name: "Save as final", exact: true }).click();
      await expect(admin.locator('[data-testid="tiebreaker-game"][data-status="complete"]')).toHaveCount(i + 1);
    }
    expect(Math.max(...played.values())).toBeLessThanOrEqual(3);
    await expect(admin.getByTestId("admin-tiebreaker-match")).toHaveCount(games);
    await expect(page.getByRole("button", { name: "Start playoffs", exact: true })).toBeEnabled();
    await page.goto("/schedule#tiebreakers");
    await bracket.getByText("Published draw & final order", { exact: true }).click();
    await expect(bracket.getByTestId("tiebreaker-draw").locator("li")).toHaveText(draw);
    await expect(bracket.getByTestId("tiebreaker-placements")).toBeVisible();
    noErrors();
  });
}
