import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

const LOGISTICS = {
  homeCaptain: "76561190000991001",
  awayCaptain: "76561190000991002",
  player: "76561190000991003",
};

async function login(
  page: import("@playwright/test").Page,
  name: string,
  steamId: string,
  redirect = "/schedule",
) {
  await page.goto(
    `/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}&redirect=${encodeURIComponent(redirect)}`,
  );
}

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
  await page
    .locator("summary")
    .filter({ hasText: "Playoff race & possible matchups" })
    .click();
  await expect(page.getByText("Playoff picture")).toBeVisible();
  await expect(
    page.getByText("Remaining opponents", { exact: true }),
  ).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "Head-to-head results grid" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Head-to-head results", exact: true }),
  ).toBeVisible();
  // Two calendar links exist (schedule header + footer) — either proves it.
  await expect(
    page.getByRole("link", { name: /Calendar feed \(\.ics\)/ }).first(),
  ).toHaveAttribute("href", /\/api\/calendar/);

  assertNoErrors();
});

test("player check-in and captain reschedule stay synchronized end to end", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await login(page, "Schedule Player", LOGISTICS.player);

  const checkIn = page.getByRole("button", { name: "✓ I'm in" });
  await expect(checkIn).toBeVisible();
  const matchHref = await page
    .getByRole("link", { name: "details →" })
    .first()
    .getAttribute("href");
  expect(matchHref).toMatch(/^\/matches\//);

  await checkIn.click();
  await expect(
    page.getByText("You're confirmed for the match ✓"),
  ).toBeVisible();
  // Readiness stays intentionally off the one-line phone fixture row so team
  // names and the details target keep their tap space. At the desktop
  // breakpoint the same refreshed payload exposes the captain roll-up.
  await page.setViewportSize({ width: 1024, height: 812 });
  await expect(
    page.getByRole("img", { name: /1 of 5 confirmed/ }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 360, height: 812 });
  // A duplicate submission updates the same unique RSVP; it never inflates
  // readiness to 2/5.
  await checkIn.click();
  await expect(
    page.locator('[role="img"][aria-label^="1 of 5 confirmed"]'),
  ).toHaveCount(1);
  await expectNoHorizontalOverflow(page, "/schedule participant check-in");

  await login(page, "Schedule Home Captain", LOGISTICS.homeCaptain, matchHref!);
  const proposed = await page.evaluate(() => {
    const d = new Date(Date.now() + 2 * 24 * 3600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  await page.locator('input[name="proposedTime"]').fill(proposed);
  await page.getByRole("button", { name: "Propose new time" }).click();
  await expect(page.getByText(/You proposed/)).toBeVisible();

  await login(page, "Schedule Away Captain", LOGISTICS.awayCaptain, matchHref!);
  await expect(page.getByText(/Accepting will clear 1 check-in/)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "✓ Accept time" }).click();
  await expect(
    page.getByText("Accepted — match retimed for both teams."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reschedule" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/matches/[id] captain reschedule");
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

  // The labeled selector exposes every team without sideways scrolling.
  const allTeams = page.getByRole("button", { name: "All teams" });
  await page
    .getByRole("combobox", { name: "Show matches for" })
    .selectOption({ index: 1 });
  await expect(allTeams).toBeVisible();
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
