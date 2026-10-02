import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { POSTSEASON_DB_URL } from "../playwright.postseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "../e2e-mid/helpers";

type FinalFixture = { matchId: string; homeName: string; awayName: string };

async function seedUpcomingFinal(page: Page): Promise<FinalFixture> {
  const env = {
    ...process.env,
    DATABASE_URL: POSTSEASON_DB_URL,
    FIXTURE_MODE: "complete",
    FIXTURE_TEAMS: "8",
  };
  // The shared seeder checks the exact suite-owned SQLite path before resetDb.
  execFileSync(process.execPath, ["--import", "tsx", "e2e-postseason/seed.ts"], {
    cwd: process.cwd(), env, stdio: "pipe",
  });
  // tsx exposes this local TypeScript module through its CommonJS default export.
  const output = execFileSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval", `
      import { PrismaClient } from "@prisma/client";
      import fixtureDatabase from "./src/lib/fixture-database.ts";
      const { assertExpectedFixtureDatabase } = fixtureDatabase;
      assertExpectedFixtureDatabase(
        process.env.DATABASE_URL ?? "", ["postseason"], "reopen the fixture final",
      );
      const db = new PrismaClient();
      try {
        const season = await db.season.findFirstOrThrow({
          where: { isActive: true, status: "COMPLETE" },
        });
        const finals = await db.match.findMany({
          where: { seasonId: season.id, phase: "FINAL", status: "COMPLETED" },
        });
        if (finals.length !== 1) throw new Error("Expected one completed fixture final.");
        const final = finals[0];
        const homeName = "w4tkins's Team";
        const awayName = "Bad Boys of Dota";
        await db.$transaction([
          db.game.deleteMany({ where: { matchId: final.id } }),
          db.match.update({
            where: { id: final.id },
            data: {
              status: "SCHEDULED", scheduledAt: new Date(Date.now() + 86_400_000),
              homeScore: 0, awayScore: 0, winnerTeamId: null, forfeit: false,
              completedAt: null, autoSyncedAt: null, autoSyncAttempts: 0,
            },
          }),
          db.season.update({
            where: { id: season.id }, data: { status: "PLAYOFFS", championTeamId: null },
          }),
          db.team.update({ where: { id: final.homeTeamId }, data: { name: homeName } }),
          db.team.update({ where: { id: final.awayTeamId }, data: { name: awayName } }),
        ]);
        console.log(JSON.stringify({ matchId: final.id, homeName, awayName }));
      } finally {
        await db.$disconnect();
      }
    `,
  ], { cwd: process.cwd(), env, encoding: "utf8", stdio: "pipe" });
  const cache = await page.request.post("/api/test/cache");
  expect(cache.ok(), "expire the postseason fixture cache").toBe(true);
  return JSON.parse(output.trim()) as FinalFixture;
}

for (const width of [400, 1366]) {
  test(`upcoming final has honest status and Full schedule reaches playoffs at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertNoErrors = trackPageErrors(page);
    await page.setViewportSize({ width, height: 900 });
    await page.context().clearCookies();
    const final = await seedUpcomingFinal(page);
    await page.goto("/");

    const main = page.locator("#main");
    const hero = main.locator("section").filter({
      has: page.getByRole("heading", { level: 1 }),
    });
    await expect(hero.getByText("Grand final", { exact: true })).toBeVisible();
    await expect(hero).not.toContainText("underway");
    const finalHeading = main.getByRole("heading", {
      name: "The grand final", exact: true, level: 2,
    });
    await expect(finalHeading).toBeVisible();
    const fullSchedule = finalHeading.locator("../..").getByRole("link", {
      name: "Full schedule", exact: true,
    });
    await expect(fullSchedule).toHaveAttribute("href", "/schedule#playoff-bracket");
    await expectNoHorizontalOverflow(page, `upcoming-final Home ${width}px`);
    await page.screenshot({ path: testInfo.outputPath("final-home.png"), fullPage: true });

    await fullSchedule.click();
    await expect(page).toHaveURL(/\/schedule#playoff-bracket$/);
    const destination = page.locator("#playoff-bracket");
    await expect(destination).toBeInViewport();
    // This article belongs to the phone-friendly round list, not the wide bracket.
    const finalRow = destination.getByRole("article", {
      name: `${final.homeName} vs ${final.awayName} · Upcoming`, exact: true,
    });
    await expect(finalRow).toBeVisible();
    await expect(finalRow.locator(`a[href="/matches/${final.matchId}"]`)).toBeVisible();
    await expectNoHorizontalOverflow(page, `upcoming-final Schedule ${width}px`);
    await page.screenshot({ path: testInfo.outputPath("final-schedule.png"), fullPage: true });
    assertNoErrors();
  });
}
