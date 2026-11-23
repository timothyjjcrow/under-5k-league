import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";
import { matchNightForWeek } from "../src/lib/schedule";

// Breaks (docs/features/season-schedule-playoffs.md#breaks): an admin skips a
// league night, the season plan shows it, and Remove puts the season back.
// Named to run last: it moves the season's week-1 night for the test (the
// fixture's is in June, its open week retimed to tonight) and restores it.

// Hard-wired to this suite's disposable SQLite database.
const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
const ADMIN = "/api/auth/dev?name=Break+Admin&steamId=76561190000995301&admin=1&redirect=/admin";

test.afterAll(async () => {
  await db.$disconnect();
});

function acceptNextDialog(page: Page) {
  page.once("dialog", (dialog) => dialog.accept());
}

test("an admin adds a break, the season plan shows it, and Remove puts it back", async ({
  page,
}) => {
  test.slow();
  const assertNoErrors = trackPageErrors(page);
  const season = await db.season.findFirstOrThrow({ where: { isActive: true } });
  // The last regular week was staged for tonight (stage.ts), and earlier specs
  // may have played it since: its kickoff is the anchor either way.
  const [last] = await db.match.findMany({
    where: { seasonId: season.id, phase: "REGULAR", scheduledAt: { not: null } },
    orderBy: [{ week: "desc" }, { scheduledAt: "desc" }, { id: "asc" }],
    take: 1,
  });
  expect(last).toBeDefined();
  // Put the weekly rhythm on that week's night, so the nights after it (the
  // tiebreaker week and the playoffs) are still to come.
  const anchor = matchNightForWeek(last.scheduledAt!, 2 - last.week);
  await db.season.update({ where: { id: season.id }, data: { firstMatchNight: anchor } });
  try {
    await page.goto(ADMIN);
    const box = page.getByRole("region", { name: "Breaks" });
    await expect(box).toContainText("No breaks: the league plays every week.");
    const select = box.getByRole("combobox", { name: "Night to skip" });
    const labels = await select.locator("option").allTextContents();
    const index = labels.findIndex((label) => label.includes("Tiebreakers"));
    expect(index, `options: ${labels.join(" | ")}`).toBeGreaterThanOrEqual(0);
    await select.selectOption({ index });
    acceptNextDialog(page);
    await box.getByRole("button", { name: "Add break" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Break added: no games on" }),
    ).toBeVisible();
    await expect(box).toContainText("Tiebreakers and later play a night later");
    const stored = await db.season.findUniqueOrThrow({ where: { id: season.id } });
    expect(JSON.parse(stored.breakDates!)).toHaveLength(1);

    // Players see it in the season plan, at phone width too.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/schedule");
    await page.getByText("Season plan", { exact: true }).click();
    const plan = page.getByRole("list", { name: "Season plan" });
    await expect(plan.getByRole("listitem").filter({ hasText: /^Break/ })).toContainText("no games");
    await expectNoHorizontalOverflow(page, "/schedule with a break");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/admin");
    acceptNextDialog(page);
    await page.getByRole("region", { name: "Breaks" }).getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("status").filter({ hasText: "removed" })).toBeVisible();
    expect((await db.season.findUniqueOrThrow({ where: { id: season.id } })).breakDates).toBeNull();
  } finally {
    await db.season.update({
      where: { id: season.id },
      data: { firstMatchNight: season.firstMatchNight, breakDates: null },
    });
  }
  assertNoErrors();
});
