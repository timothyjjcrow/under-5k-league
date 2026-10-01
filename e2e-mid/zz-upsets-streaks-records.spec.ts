import { test, expect, type Locator, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// Upsets, win streaks and record watch, end to end. The fixture's stronger
// team wins every regular series (week 3 draws are random), so after weeks
// 1-4 Roshan's Revenge has 4 or 6 points and The Couriers 0 or 1: Couriers
// beating Roshan's in week 5 is an upset whatever the draws did, and Techies
// beating Pudge is not (they are level within a point). Techies lost weeks
// 1-3 (or drew week 3) and won week 4, so that win makes a run of exactly
// two. The results are entered late through /admin, as zz-result-entry does,
// and reopened in `finally` so the shared fixture stays replay-safe.

const COURIERS = "The Couriers of Catastrophe With Very Long Name";
const ROSHANS = "Roshan's Revenge";
const TECHIES = "Techies Anonymous";
const PUDGE = "Pudge Patrol";
const TEAMS = [
  "Radiant Raccoons",
  "Dire Straits",
  ROSHANS,
  PUDGE,
  TECHIES,
  COURIERS,
];
const STREAK_CHIP = /^Won the last \d+ series$/;

function acceptNextDialog(page: Page) {
  page.once("dialog", (dialog) => dialog.accept());
}

/** /admin's editable result form for a team's week-5 fixture. */
function adminForm(page: Page, team: string) {
  return page
    .locator("form")
    .filter({
      has: page.getByRole("spinbutton", {
        name: `${team} series score`,
        exact: true,
      }),
    })
    .first();
}

async function recordFinal(page: Page, winner: string, loser: string) {
  await page.goto("/admin");
  const form = adminForm(page, winner);
  await form
    .getByRole("spinbutton", { name: `${winner} series score`, exact: true })
    .fill("2");
  await form
    .getByRole("spinbutton", { name: `${loser} series score`, exact: true })
    .fill("0");
  // Played to its finish: never the forfeit box, or it isn't an upset.
  await expect(
    form.getByRole("checkbox", { name: "forfeit / ruling" }),
  ).not.toBeChecked();
  acceptNextDialog(page);
  await form.getByRole("button", { name: "Save as final" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Result saved · " }),
  ).toBeVisible();
}

async function reopen(page: Page, matchHref: string) {
  await page.goto("/admin");
  // Every /admin result row is its own jump target (adminMatchRowId).
  const row = page.locator(`#adm-match-${matchHref.split("/").pop()}`);
  const button = row.getByRole("button", { name: "Reopen for import" });
  if (!(await button.isVisible().catch(() => false))) return false;
  acceptNextDialog(page);
  await button.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Match reopened — its games can be imported now" }),
  ).toBeVisible();
  return true;
}

function standingsRow(page: Page, team: string): Locator {
  return page
    .getByRole("table", { name: "League standings" })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: team, exact: true }) });
}

test("upsets, win streaks and record watch reach Home, the table, the preview and profiles", async ({
  page,
}) => {
  test.slow();
  const noErrors = trackPageErrors(page);
  await page.goto("/api/auth/dev?name=Upset%20Admin&admin=1");
  await page.goto("/admin");
  const couriersHref = await adminForm(page, COURIERS)
    .getByRole("link", { name: "Wk 5" })
    .getAttribute("href");
  const techiesHref = await adminForm(page, TECHIES)
    .getByRole("link", { name: "Wk 5" })
    .getAttribute("href");
  expect(couriersHref).toMatch(/^\/matches\//);
  expect(techiesHref).toMatch(/^\/matches\//);

  // Record watch, before a ball is thrown: the preview of an upcoming
  // fixture lists up to three players, each a profile link and stored marks.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(couriersHref!);
  const watchHeading = page.getByRole("heading", {
    name: "Record watch",
    level: 2,
    exact: true,
  });
  await expect(watchHeading).toBeVisible();
  const watchRows = page.getByRole("listitem").filter({ hasText: "Career best" });
  const lineCount = await watchRows.count();
  expect(lineCount).toBeGreaterThan(0);
  expect(lineCount).toBeLessThanOrEqual(3);
  for (let i = 0; i < lineCount; i++) {
    await expect(watchRows.nth(i)).toContainText(
      /Career best [\d,]+ [A-Za-z ]+ · (record [\d,]+, [\d,]+ short|level with the record)/,
    );
    await expect(watchRows.nth(i).getByRole("link")).toHaveAttribute(
      "href",
      /^\/players\//,
    );
  }
  // After the tale of the tape, before the Matchup card.
  const top = async (locator: Locator) => (await locator.boundingBox())!.y;
  const tapeY = await top(
    page.getByRole("heading", {
      name: "Tale of the tape",
      level: 2,
      exact: true,
    }),
  );
  const watchY = await top(watchHeading);
  const matchupY = await top(
    page.getByRole("heading", { name: "Matchup", level: 2, exact: true }),
  );
  expect(watchY).toBeGreaterThan(tapeY);
  expect(matchupY).toBeGreaterThan(watchY);
  await expectNoHorizontalOverflow(page, "match preview with record watch");

  // The same line is on that player's profile, in the League records card.
  const firstLine = (await watchRows.first().locator("p").textContent())!.trim();
  await watchRows.first().getByRole("link").click();
  await expect(page).toHaveURL(/\/players\//);
  const records = page.locator("#player-records");
  await expect(records.getByText("Within reach", { exact: true })).toBeVisible();
  await expect(records).toContainText(firstLine);
  await expectNoHorizontalOverflow(page, "profile with a record within reach");

  await page.setViewportSize({ width: 1280, height: 900 });
  let recorded = 0;
  try {
    await recordFinal(page, COURIERS, ROSHANS);
    recorded += 1;
    await recordFinal(page, TECHIES, PUDGE);
    recorded += 1;

    await page.goto("/");
    // Recent results: the upset is chipped, and said, without losing the
    // row's "won the series · Match details" ending.
    const recentHeading = page.getByRole("heading", {
      name: "Recent results",
      level: 2,
      exact: true,
    });
    const recent = recentHeading.locator(
      "xpath=ancestor::div[.//a[contains(., 'All results')]][1]",
    );
    const upsetRow = recent.locator(`li a[href="${couriersHref}"]`);
    await expect(upsetRow).toHaveAccessibleName(
      new RegExp(`Upset: ${COURIERS} won the series · Match details$`),
    );
    await expect(upsetRow.getByText("Upset", { exact: true })).toBeVisible();
    const formRow = recent.locator(`li a[href="${techiesHref}"]`);
    await expect(formRow).toHaveAccessibleName(
      new RegExp(`${TECHIES} won the series · Match details$`),
    );
    await expect(formRow).not.toHaveAccessibleName(/Upset/);
    await expect(formRow.getByText("Upset", { exact: true })).toHaveCount(0);

    // The week's biggest upset, on its own line.
    const highlight = page.getByRole("region", { name: "Week 5 upset" });
    await expect(highlight).toBeVisible();
    await expect(highlight).toContainText(
      `${COURIERS} beat ${ROSHANS} 2–0, from `,
    );
    await expect(highlight).toContainText(
      /from \d+ points behind going into the week/,
    );
    await expect(
      highlight.getByRole("link", { name: "Match details" }),
    ).toHaveAttribute("href", couriersHref!);

    // Streaks on the live table: Techies' two wins in a row, nobody else's
    // single win or loss, and every chip agreeing with its Last 5 strip.
    await expect(
      standingsRow(page, TECHIES).getByRole("img", {
        name: "Won the last 2 series",
      }),
    ).toBeVisible();
    await expect(standingsRow(page, TECHIES)).toContainText("W2 streak");
    for (const team of [COURIERS, ROSHANS, PUDGE]) {
      await expect(
        standingsRow(page, team).getByRole("img", { name: STREAK_CHIP }),
      ).toHaveCount(0);
    }
    for (const team of TEAMS) {
      const row = standingsRow(page, team);
      const strip = await row
        .getByRole("img", { name: /^Recent form, newest first:/ })
        .getAttribute("aria-label");
      const results = strip!
        .replace("Recent form, newest first: ", "")
        .split(", ");
      const leading = results.findIndex((r) => r !== "win");
      const wins = leading === -1 ? results.length : leading;
      const chip = row.getByRole("img", { name: STREAK_CHIP });
      if (wins < 2) {
        await expect(chip, team).toHaveCount(0);
      } else if (wins < results.length) {
        await expect(chip, team).toHaveAccessibleName(
          `Won the last ${wins} series`,
        );
      } else {
        // Every result in the strip is a win: the run may go back further.
        const name = await chip.getAttribute("aria-label");
        expect(Number(name!.match(/\d+/)![0]), team).toBeGreaterThanOrEqual(wins);
      }
    }

    // /schedule's table carries the same chip.
    await page.goto("/schedule");
    await expect(
      standingsRow(page, TECHIES).getByRole("img", {
        name: "Won the last 2 series",
      }),
    ).toBeVisible();

    // Chips and the long team name wrap at phone width.
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoHorizontalOverflow(page, "schedule with a streak chip");
    await page.goto("/");
    await expect(
      page.getByRole("region", { name: "Week 5 upset" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page, "home with an upset");
  } finally {
    // Restore the shared fixture even when an assertion above failed.
    await page.setViewportSize({ width: 1280, height: 900 });
    if (recorded > 0) await reopen(page, couriersHref!).catch(() => false);
    if (recorded > 1) await reopen(page, techiesHref!).catch(() => false);
  }

  noErrors();
});
