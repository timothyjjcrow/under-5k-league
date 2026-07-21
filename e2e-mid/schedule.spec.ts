import { test, expect } from "@playwright/test";
import { trackPageErrors } from "./helpers";

// /schedule mid-season: week list with collapse/filter behavior, the LIVE
// score chip, the playoff-race cards, the season grid, and the calendar link.

test("schedule renders weeks, cards, the LIVE chip, and the calendar link", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/schedule");

  await expect(page.getByText("Week 1").first()).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Live — series at 1–0/ }).first(),
  ).toBeVisible();
  await expect(page.getByText("Playoff picture")).toBeVisible();
  await expect(page.getByText("Run-in")).toBeVisible();
  await expect(page.getByText("Season grid")).toBeVisible();
  // Two calendar links exist (schedule header + footer) — either proves it.
  await expect(
    page.getByRole("link", { name: /Calendar \(\.ics\)/ }).first(),
  ).toHaveAttribute("href", /\/api\/calendar/);

  assertNoErrors();
});

test("fully-played past weeks start collapsed and expand on click", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/schedule");

  // Scope to #main: the header's (hidden-at-desktop) hamburger also carries
  // aria-expanded and would otherwise be .first().
  const collapsed = page.locator('#main button[aria-expanded="false"]').first();
  await expect(collapsed).toBeVisible();
  await collapsed.click();
  await expect(
    page.locator('#main button[aria-expanded="true"]').first(),
  ).toBeVisible();

  assertNoErrors();
});

test("the team filter narrows the week rows and All teams restores them", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/schedule");

  // count() doesn't auto-wait — anchor on rendered content first so the
  // streamed page is actually there before counting.
  await expect(page.getByText("Week 1").first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: "details →" }).first(),
  ).toBeVisible();
  const allRows = await page.getByRole("link", { name: "details →" }).count();
  expect(allRows).toBeGreaterThan(0);

  // The chip strip sits next to "All teams" — click the first real team chip.
  const allTeams = page.getByRole("button", { name: "All teams" });
  await expect(allTeams).toBeVisible();
  const chip = allTeams.locator("xpath=following-sibling::button[1]");
  await chip.click();
  // Filtering force-expands collapsed weeks, so the count isn't simply
  // smaller — but in the fixture's 6-team single round robin every team
  // plays exactly once a week: 5 rows, one per week.
  await expect(page.getByRole("link", { name: "details →" })).toHaveCount(5);
  await allTeams.click();
  await expect(page.getByRole("link", { name: "details →" })).toHaveCount(
    allRows,
  );

  assertNoErrors();
});
