import { test, expect, type Page } from "@playwright/test";
import { LEAGUE_CONFIG } from "../src/lib/league-config";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// The match-night poll end to end: an admin opens it from /admin (the grid
// fills itself: every day over the league's window, noon to 6 PM Pacific or
// 5 PM to 11 PM Berlin), a signed-up player marks times on
// Home and sees who can play when, a viewer in another zone sees the grid on
// their own clock, and the admin closes and deletes it. A zz- spec because
// it writes league-wide state Home renders; it deletes its poll at the end.

const QUESTION = "When should match night be? (e2e)";
const EU = process.env.NEXT_PUBLIC_LEAGUE_REGION === "eu";
const LEAGUE_ZONE = EU ? "Europe/Berlin" : "America/Los_Angeles";
/** The default window's first and last start hours on the league's clock. */
const { from: FIRST, to: LAST } = LEAGUE_CONFIG.pollDefaultHours;
/** A grid hour as the league's locale prints it. */
const hour = (h: number) =>
  EU ? `${String(h).padStart(2, "0")}:00` : `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

async function signIn(page: Page, query: string, redirect: string) {
  await page.goto(`/api/auth/dev?${query}&redirect=${encodeURIComponent(redirect)}`);
}

async function openPollSection(page: Page) {
  const section = page.locator("#adm-poll");
  await page
    .getByRole("navigation", { name: "Admin sections" })
    .getByRole("link", { name: "Match night poll", exact: true })
    .click();
  await expect(section).toHaveAttribute("open", "");
  return section;
}

test.describe.configure({ mode: "serial" });

test.describe("on the league's clock", () => {
  test.use({ timezoneId: LEAGUE_ZONE });

  test("an admin opens a poll and a signed-up player marks the times they can play", async ({
    page,
  }) => {
    test.slow();
    const noErrors = trackPageErrors(page);

    // 1. The admin opens a poll; the grid fills itself.
    await signIn(page, "name=Poll+Admin&steamId=76561190000994101&admin=1", "/admin");
    const section = await openPollSection(page);
    await section.getByLabel("Question").fill(QUESTION);
    await section.getByLabel(/Announce it on Discord/).uncheck();
    await section.getByRole("button", { name: "Open the poll" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /Poll open on Home: Every day, .+ \(49 start times\)/ }),
    ).toBeVisible();

    // 2. An account that isn't signed up sees which times are on offer and
    // who votes, but no grid.
    await signIn(page, "name=Poll+Outsider&steamId=76561190000994102", "/");
    const card = page.locator("#match-night-poll");
    await expect(card.getByRole("heading", { name: QUESTION, level: 2 })).toBeVisible();
    await expect(card.getByText(/Times on offer: Every day/)).toBeVisible();
    await expect(
      card.getByText(/Voting is for players signed up for .+, and you aren't signed up\./),
    ).toBeVisible();
    await expect(card.getByRole("link", { name: "My account" })).toHaveAttribute("href", "/me");
    await expect(card.getByRole("table", { name: "Times you could play" })).toHaveCount(0);

    // 3. A rostered player (stage.ts pins this steamId) gets the grid.
    await signIn(page, "name=Poll+Voter&steamId=76561190000991003", "/");
    const grid = card.getByRole("table", { name: "Times you could play" });
    await expect(grid).toBeVisible();
    await expect(grid.locator('[data-slot][aria-pressed="false"]')).toHaveCount(49);
    // Same clock as the league: still says the times are local, no switch.
    await expect(card.getByText(/Times are shown in your local time \((Pacific|Berlin) time\)\.$/)).toBeVisible();
    await expect(card.getByRole("group", { name: "Show times on" })).toHaveCount(0);
    const save = card.getByRole("button", { name: "Save my times" });
    await expect(save).toBeDisabled();

    // A whole day from its header, then one time off again.
    await grid.getByRole("button", { name: "Mark every Saturday time" }).click();
    await expect(grid.locator('[data-slot][aria-pressed="true"]')).toHaveCount(7);
    await grid.getByRole("button", { name: `Saturday ${hour(LAST)}`, exact: true }).click();
    // A range by dragging down Sunday over its first three start times.
    const from = await grid
      .getByRole("button", { name: `Sunday ${hour(FIRST)}`, exact: true })
      .boundingBox();
    const to = await grid
      .getByRole("button", { name: `Sunday ${hour(FIRST + 2)}`, exact: true })
      .boundingBox();
    if (!from || !to) throw new Error("grid cells have no box");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(grid.locator('[data-slot][aria-pressed="true"]')).toHaveCount(9);
    await expect(card.getByText(/^9 times:/)).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page, "home poll grid");
    await page.setViewportSize({ width: 1280, height: 900 });

    await save.click();
    await expect(
      page.getByRole("status").filter({ hasText: /^Saved 9 times: Sat .+, Sun .+ \(.+ time\)\./ }),
    ).toBeVisible();
    await expect(card.getByText("Your times are in")).toBeVisible();
    await expect(card.getByText("Who can play when", { exact: true })).toBeVisible();
    const heatmap = card.getByRole("table", { name: /How many players can play each time/ });
    await expect(heatmap).toBeVisible();
    await expect(card.getByRole("list", { name: "Best times" })).toContainText("1 of 1 can play");

    // Changing reopens the grid with the saved times.
    await card.getByRole("button", { name: "Change my times" }).click();
    await expect(grid.locator('[data-slot][aria-pressed="true"]')).toHaveCount(9);
    await card.getByRole("button", { name: "Cancel" }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page, "home poll heatmap");
    noErrors();
  });
});

test.describe("from another time zone", () => {
  // Tokyo is half a day or more from both leagues' clocks.
  test.use({ timezoneId: "Asia/Tokyo" });

  test("a player sees the grid on their own clock and can switch to the league's", async ({
    page,
  }) => {
    const noErrors = trackPageErrors(page);
    await signIn(page, "name=Poll+Voter&steamId=76561190000991003", "/");
    const card = page.locator("#match-night-poll");
    const toggle = card.getByRole("group", { name: "Show times on" });
    await expect(
      toggle.getByRole("button", { name: "Your local time (Tokyo)" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(card.getByText("Times are shown in your local time (Tokyo time).")).toBeVisible();
    const heatmap = card.getByRole("table", { name: /How many players can play each time/ });
    // The first row is the window's first hour on the league's clock: a
    // different hour in Tokyo.
    const firstRow = heatmap.getByRole("rowheader").first();
    await expect(heatmap).toHaveAccessibleName(/in your local time \(Tokyo time\)/);
    await expect(firstRow).not.toHaveText(hour(FIRST));
    await toggle.getByRole("button", { name: /^League time \((Pacific|Berlin)\)$/ }).click();
    await expect(firstRow).toHaveText(hour(FIRST));
    await expect(card.getByText(/Times are shown in league time \((Pacific|Berlin) time\)\.$/)).toBeVisible();
    noErrors();
  });
});

test.describe("closing", () => {
  test.use({ timezoneId: LEAGUE_ZONE });

  test("the admin closes voting, Home shows the winner, and the poll can be deleted", async ({
    page,
  }) => {
    const noErrors = trackPageErrors(page);
    await signIn(page, "name=Poll+Admin&steamId=76561190000994101&admin=1", "/admin");
    let section = await openPollSection(page);
    page.once("dialog", (dialog) => dialog.accept());
    await section.getByRole("button", { name: "Close voting now" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Voting closed with 1 vote" }),
    ).toBeVisible();

    await page.goto("/");
    const card = page.locator("#match-night-poll");
    await expect(card.getByText("Voting closed", { exact: true })).toBeVisible();
    await expect(card.getByText("The league picked", { exact: true })).toBeVisible();
    // Every marked time has the one voter; Saturday's second start time is
    // the earliest with a marked time on both sides, so it wins the tie.
    await expect(card.getByText(/^Saturdays at .+ time$/)).toBeVisible();

    await page.goto("/admin");
    section = await openPollSection(page);
    await section.getByRole("button", { name: "Delete poll" }).click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", { name: "Delete poll" });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox").fill(QUESTION);
    await confirm.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Deleted the poll and its 1 vote" }),
    ).toBeVisible();
    await page.goto("/");
    await expect(page.locator("#match-night-poll")).toHaveCount(0);
    noErrors();
  });
});
