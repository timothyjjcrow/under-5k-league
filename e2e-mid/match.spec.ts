import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

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

  // The staged LIVE row already has a recorded game and correctly renders its
  // box score. Select a SCHEDULED row by its kickoff <time> so this check keeps
  // exercising the pre-game scouting state regardless of within-week order.
  const scheduledDetails = page.locator(
    '#fixtures div:has(> a[href^="/matches/"]):has(time) > a[href^="/matches/"]',
  );
  await expect(scheduledDetails.first()).toBeVisible();
  await scheduledDetails.first().click();
  await expect(page).toHaveURL(/\/matches\//);
  await expect(page.getByText("Scouting report")).toBeVisible();

  assertNoErrors();
});

test("captains can report an open series and get a clear correction handoff once it is final", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto(
    "/api/auth/dev?name=Result%20Captain&steamId=76561190000991001&redirect=/schedule",
  );

  // stage.ts assigns this identity to one scheduled fixture's home captain.
  // Resolve that fixture through the captain's own check-in banner rather than
  // relying on within-week insertion order (or hard-coding a generated id).
  const checkIn = page.getByRole("button", { name: "✓ I'm in" });
  await expect(checkIn).toBeVisible();
  const checkInBanner = checkIn.locator(
    'xpath=ancestor::div[.//a[normalize-space()="details →"]][1]',
  );
  const openHref = await checkInBanner
    .getByRole("link", { name: "details →" })
    .getAttribute("href");
  expect(openHref).toMatch(/^\/matches\//);

  await page.goto(openHref!);
  await expect(
    page.getByRole("heading", { name: "Official lobby checklist" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Result recording" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /League-feed checks begin 25 minutes .* repeat about every 3 minutes/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Current league id", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("17119", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "This is a Bo2: create two separate Bo1 lobbies and select this league ticket in both.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy league id" }),
  ).toBeVisible();
  const matchRef = page.getByRole("textbox", {
    name: "Dota match ID or URL",
  });
  await expect(matchRef).toBeVisible();
  await expect(
    page.getByText(
      "Paste a numeric Dota match ID or an OpenDota/Dotabuff match URL.",
    ),
  ).toBeVisible();
  const autoFetch = page.getByRole("button", { name: "Auto-fetch games" });
  const addGame = page.getByRole("button", { name: "Add game" });
  await expect(autoFetch).toBeVisible();
  await expect(addGame).toBeVisible();

  // A malformed reference is rejected before any OpenDota request. This also
  // proves the shared ActionForm keeps a captain's pasted value on an error
  // and returns both controls to an actionable state.
  await matchRef.fill("not-a-match");
  await addGame.click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Enter a valid match id or URL" }),
  ).toBeVisible();
  // The error remains beside the form after the global toast disappears.
  await expect(page.getByRole("alert").filter({ hasText: "Enter a valid match id or URL" })).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator("form").filter({ has: matchRef })).toContainText("Enter a valid match id or URL");
  await expect(matchRef).toHaveValue("not-a-match");
  await expect(autoFetch).toBeEnabled();
  await expect(addGame).toBeEnabled();
  await expectNoHorizontalOverflow(page, "/matches/[id] captain result form");

  // Capture the dynamically staged captain's team from the match itself, then
  // use the team filter to reach a completed fixture for the same captain.
  // Filtering expands every week; current fixtures come first, past weeks follow.
  const captainTeam = page.locator('#main a[href^="/teams/"]').first();
  const captainTeamName = (await captainTeam.textContent())?.trim();
  expect(captainTeamName).toBeTruthy();
  await page.goto("/schedule");
  await page
    .getByRole("button", { name: captainTeamName!, exact: true })
    .click();
  // Scope out the separate "Your next match" check-in banner, which carries
  // its own details link above the five filtered regular-season rows.
  const teamMatches = page
    .locator("#fixtures")
    .getByRole("link", { name: "details →" });
  await expect(teamMatches).toHaveCount(5);
  await teamMatches.last().click();

  await expect(
    page.getByText("Series complete", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Need a result correction?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Report your result" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Dota match ID or URL" }),
  ).toHaveCount(0);
  await expectNoHorizontalOverflow(
    page,
    "/matches/[id] captain correction state",
  );

  assertNoErrors();
});
