import { test, expect } from "@playwright/test";
import { trackPageErrors } from "./helpers";

// Match pages in both mid-season states: a completed series' box score (MVP
// chip, report-card grades) and an unplayed match's preview (scouting report).

test("a completed match page renders the box score with an MVP chip", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/schedule");

  // Past completed weeks start collapsed — expand the first (#main scope:
  // the header hamburger also has aria-expanded) and open its first match.
  await page.locator('#main button[aria-expanded="false"]').first().click();
  await page.getByRole("link", { name: "details →" }).first().click();

  await expect(page).toHaveURL(/\/matches\//);
  await expect(page.getByText("series").first()).toBeVisible();
  // Box scores are div grids (no <table>): the MVP chip on the crowned line
  // and at least one hero portrait prove the score rendered.
  await expect(page.getByText("MVP").first()).toBeVisible();

  assertNoErrors();
});

test("an unplayed match page renders the preview with the scouting report", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/schedule");

  // The tonight-retimed open matches render kickoff times, not scores; their
  // details links sit in the current (expanded) week. The first details link
  // on the page belongs to the current week when past weeks are collapsed.
  await page.getByRole("link", { name: "details →" }).first().click();
  await expect(page).toHaveURL(/\/matches\//);
  await expect(page.getByText("Scouting report")).toBeVisible();

  assertNoErrors();
});
