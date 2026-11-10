import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { MID_DB_URL } from "../playwright.midseason.config";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
  untilHydrated,
} from "./helpers";

// This suite writes only to the explicitly configured disposable fixture.
const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
test.afterAll(async () => {
  await db.$disconnect();
});

// The mid-season dashboard: standings, the This-week strip (with the staged
// LIVE match), and the standings table's phone layout.

test("dashboard shows the regular-season hero, standings, and a LIVE chip", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");

  // Regular-season hero counts the weeks ("Week" / "5" / "of 5 weeks" are
  // separate stat elements — match the one contiguous fragment).
  await expect(page.locator("#main")).toContainText(/of \d+ weeks/);
  await expect(page.getByRole("table").first()).toBeVisible();

  // The staged LIVE 1–0 match pulses on the This-week strip.
  await expect(
    page.getByRole("img", { name: /Live — series at 1–0/ }).first(),
  ).toBeVisible();

  assertNoErrors();
});

// The header's status chip says what is happening now: with the staged LIVE
// series it reads "Series live" on every page, phones included, and opens
// this week's fixtures.
test("the header chip links the live series from any page, on phones too", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/news");
  const chip = page
    .getByRole("banner")
    .getByRole("link", { name: /^League status: .+ — Series live$/ });
  await expect(chip).toHaveAttribute("href", "/schedule#this-week");
  await expect(chip).toContainText("Series live");

  await page.setViewportSize({ width: 360, height: 812 });
  await expect(chip).toBeVisible();
  await expectNoHorizontalOverflow(page, "/news header chip");
  await chip.click();
  await expect(page).toHaveURL(/\/schedule#this-week$/);
  assertNoErrors();
});

test("signed-out visitors sign in first, with the standin signup as a line", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");

  // The main button just signs in and comes back here: rostered players open
  // Discord links signed out, and must not be told to sign up as standins.
  const main = page.locator("#main");
  const signIn = main.getByRole("link", {
    name: "Sign in with Steam",
    exact: true,
  });
  await expect(signIn).toBeVisible();
  // Dev login is on in e2e, so these go through /login; with only Steam they
  // go straight to Steam, and the note beside them says what is shared.
  await expect(signIn).toHaveAttribute("href", "/login");
  const cta = main.getByRole("link", { name: "Sign in to join as a standin" });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute("href", "/login?next=/me");
  await expect(main.getByRole("link", { name: "Sign in to stand in" })).toHaveCount(0);
  await expect(
    page.getByText(/so we never see your password or email\.$/),
  ).toBeVisible();

  assertNoErrors();
});

// A pinned post rides the strip under the hero and the League news card lists
// the latest of the rest, so the pinned one is printed once, not twice.
test("home shows a pinned post once, with the latest news below", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");
  const main = page.locator("#main");
  await expect(
    main.getByRole("link", { name: /Pinned notice: Match night reminder/ }),
  ).toBeVisible();
  await expect(main.getByText(/Match night reminder/)).toHaveCount(1);
  await expect(
    main.getByRole("heading", { name: "League news", level: 2 }),
  ).toBeVisible();
  await expect(
    main.getByRole("link", { name: "Week schedule published", exact: true }),
  ).toBeVisible();
  assertNoErrors();
});

// An admin gets the panel's next step as one line under the hero, linking
// the panel; everyone else sees Home as before.
test("admins get the admin panel's next step under the hero", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");
  const main = page.locator("#main");
  const strip = main.getByRole("link", { name: /Open admin$/ });
  await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(strip).toHaveCount(0);

  await page.goto("/api/auth/dev?name=Home%20Admin&admin=1");
  await expect(page).toHaveURL(/\/$/);
  await expect(strip).toHaveAttribute("href", "/admin");
  // The fixture's last week is still open, and its LIVE series is past
  // kickoff: the panel's headline, word for word.
  await expect(strip).toContainText(
    /Admin.*Season running: \d+ results? outstanding\./,
  );
  await page.setViewportSize({ width: 360, height: 812 });
  await expectNoHorizontalOverflow(page, "/ admin line");
  assertNoErrors();
});

// The dashboard is the widest page in the app — standings table, bracket, the
// This-week grid — and it was the one page with no overflow tripwire at all.
test("dashboard has no horizontal page overflow on a phone", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/");
  await expect(page.locator("#main")).toContainText(/of \d+ weeks/);
  await expectNoHorizontalOverflow(page, "/");
  assertNoErrors();
});

test("standings columns line up on a phone, with points at the right edge", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const table = page.getByRole("table", { name: "League standings", exact: true });
  await expect(table).toBeVisible();
  // Last 5 hides on phones. It is the last column, so no visible cell slides
  // onto its zero-width <col>: points ends where the table ends.
  await expect(
    table.getByRole("columnheader", {
      name: "Last 5",
      exact: true,
      includeHidden: true,
    }),
  ).toBeHidden();
  const tableBox = (await table.boundingBox())!;
  const pointsHeader = table.getByRole("columnheader", { name: "Points", exact: true });
  const headerBox = (await pointsHeader.boundingBox())!;
  expect(
    Math.abs(tableBox.x + tableBox.width - (headerBox.x + headerBox.width)),
  ).toBeLessThan(2);
  const firstRow = table.locator("tbody tr").first();
  const lastCell = firstRow.locator("td:visible").last();
  const cellBox = (await lastCell.boundingBox())!;
  expect(Math.abs(cellBox.x - headerBox.x)).toBeLessThan(2);
  expect(Math.abs(cellBox.width - headerBox.width)).toBeLessThan(2);

  assertNoErrors();
});

// A rostered player's Home: the hero says where the league and their team
// stand, and This week is a list of compact rows with their own series first
// and a one-line pick that saves on one tap.
test("a rostered player sees where they stand, their series first and a one-tap pick", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  // A series on this week's slate that hasn't started, so its pick is open.
  const match = await db.match.findFirstOrThrow({
    where: { phase: "REGULAR", status: "SCHEDULED" },
    orderBy: [{ week: "asc" }, { id: "asc" }],
    include: { homeTeam: true, awayTeam: true },
  });
  const member = await db.teamMember.findFirstOrThrow({
    where: { teamId: match.homeTeamId, isCaptain: false },
    orderBy: { id: "asc" },
    include: { user: true },
  });
  const params = new URLSearchParams({
    steamId: member.user.steamId,
    name: member.user.name,
    redirect: "/",
  });
  await page.goto(`/api/auth/dev?${params}`);
  await expect(page).toHaveURL(/\/$/);
  const main = page.locator("#main");

  // The hero: the league's race, then the viewer's own standing.
  await expect(
    main.getByRole("link", { name: "Playoff race", exact: true }),
  ).toHaveAttribute("href", "/schedule#playoff-analysis");
  const standing = main
    .locator("div")
    .filter({ has: page.getByText("Where you stand", { exact: true }) })
    .last();
  await expect(
    standing.getByRole("link", { name: match.homeTeam.name, exact: true }),
  ).toHaveAttribute("href", `/teams/${match.homeTeamId}`);
  await expect(standing).toContainText(
    /\d+ wins?, (\d+ draws?, )?\d+ loss(es)?/,
  );
  // The regular season has no "Your team" card to repeat it.
  await expect(
    main.getByRole("heading", { name: "Your team", exact: true }),
  ).toHaveCount(0);

  // This week: one row a series, the viewer's first and marked.
  await expect(
    main.getByRole("heading", { name: /^This week · Week \d+$/ }),
  ).toBeVisible();
  const week = main
    .getByRole("list")
    .filter({ has: page.getByText("Your match", { exact: true }) });
  const rows = week.getByRole("listitem");
  expect(await rows.count()).toBeGreaterThan(1);
  const mine = rows.first();
  await expect(mine).toContainText("Your match");
  await expect(week.getByText("Your match", { exact: true })).toHaveCount(1);
  await expect(mine).toContainText(match.homeTeam.name);
  await expect(mine).toContainText(match.awayTeam.name);
  await expect(
    mine.getByRole("link", { name: /Match details and check-in$/ }),
  ).toHaveAttribute("href", `/matches/${match.id}`);
  // Each side's check-ins, named in full for a screen reader.
  await expect(mine.getByRole("img", { name: /checked in/ })).toHaveCount(2);

  // The pick is one line under the row and saves on one tap.
  await expect(mine.getByRole("button")).toHaveCount(2);
  const pick = mine.getByRole("button", {
    name: new RegExp(escapeRegExp(match.awayTeam.name)),
  });
  await expect(pick).toHaveAttribute("aria-pressed", "false");
  await untilHydrated(page, pick);
  try {
    await pick.click();
    await expect(pick).toHaveAttribute("aria-pressed", "true");
  } finally {
    // Other specs read the fixture's pick'em board: leave it as it was.
    await db.prediction.deleteMany({
      where: { userId: member.userId, matchId: match.id },
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(mine).toBeVisible();
  await expectNoHorizontalOverflow(page, "/ as a rostered player");
  assertNoErrors();
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
