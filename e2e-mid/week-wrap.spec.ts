import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });

test.afterAll(async () => {
  await db.$disconnect();
});

// The week wrap: one finished regular week's results, honors, table and
// what's next, under the season's own URL. /schedule links it from every
// finished week, and the honors post links it.
test("a finished week has a wrap: results, the table, what's next, no client errors", async ({
  page,
}) => {
  const season = await db.season.findFirstOrThrow({
    where: { isActive: true },
    select: { id: true },
  });
  const weeks = await db.match.findMany({
    where: { seasonId: season.id, phase: "REGULAR" },
    select: { week: true, status: true },
  });
  const finished = [...new Set(weeks.map((m) => m.week))]
    .sort((a, b) => a - b)
    .find((week) =>
      weeks.filter((m) => m.week === week).every((m) => m.status === "COMPLETED"),
    );
  test.skip(finished === undefined, "the fixture has no finished regular week");

  const assertNoErrors = trackPageErrors(page);
  await page.goto("/schedule");
  const wrapLink = page.getByRole("link", { name: `Week ${finished} wrap`, exact: false });
  await expect(wrapLink.first()).toHaveAttribute(
    "href",
    `/seasons/${season.id}/weeks/${finished}`,
  );

  await page.goto(`/seasons/${season.id}/weeks/${finished}`);
  await expect(
    page.getByRole("heading", { name: `Week ${finished} wrap`, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Results", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Honors", level: 2 })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: `The table after week ${finished}`, level: 2 }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "week wrap");
  assertNoErrors();
});

// The root loading.tsx streams the shell first, so notFound() renders the
// not-found page under a 200: check what it renders, as quality-of-life does.
test("a week that doesn't exist is not found", async ({ page }) => {
  const season = await db.season.findFirstOrThrow({
    where: { isActive: true },
    select: { id: true },
  });
  const assertNoErrors = trackPageErrors(page);
  for (const week of ["999", "not-a-week"]) {
    await page.goto(`/seasons/${season.id}/weeks/${week}`);
    await expect(
      page.locator('meta[name="robots"][content="noindex"]').first(),
    ).toBeAttached();
    await expect(
      page.getByRole("heading", { name: "Page not found", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: /wrap$/ })).toHaveCount(0);
  }
  assertNoErrors();
});
