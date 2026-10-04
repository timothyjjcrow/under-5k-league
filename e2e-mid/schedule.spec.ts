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
// score chip, the playoff-race cards, the season grid, and the calendar menu.

test("schedule renders weeks, cards, the LIVE chip, and the calendar menu", async ({
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
  // The fixture list already shows each team's remaining games.
  await expect(
    page.getByText("Remaining opponents", { exact: true }),
  ).toHaveCount(0);
  await page
    .locator("summary")
    .filter({ hasText: "Head-to-head results grid" })
    .click();
  await expect(
    page.getByRole("table", { name: /^Head-to-head results\./ }),
  ).toBeVisible();
  // One "Add to calendar" control: Apple/Outlook subscribe, Google Calendar
  // and a download, all for the whole league when no team is picked.
  const addToCalendar = page.getByRole("button", {
    name: "Add to calendar",
    exact: true,
  });
  await addToCalendar.click();
  await expect(
    page.getByRole("link", { name: "Apple Calendar or Outlook", exact: true }),
  ).toHaveAttribute("href", /^webcal:\/\/[^/]+\/api\/calendar$/);
  await expect(
    page.getByRole("link", { name: /^Google Calendar/ }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/calendar\.google\.com\/calendar\/render\?cid=webcal%3A%2F%2F/,
  );
  const download = page.getByRole("link", {
    name: "Download .ics file",
    exact: true,
  });
  await expect(download).toHaveAttribute("href", "/api/calendar");
  await expectNoHorizontalOverflow(page, "/schedule calendar menu");
  await page.keyboard.press("Escape");
  await expect(download).toHaveCount(0);
  await expect(addToCalendar).toBeFocused();

  // Picking a team in the fixture filter offers that team's feed, with the
  // whole league one tap away.
  await page
    .getByRole("combobox", { name: "Show matches for" })
    .selectOption({ index: 1 });
  await addToCalendar.click();
  await expect(download).toHaveAttribute("href", /^\/api\/calendar\?team=/);
  await page.getByRole("button", { name: "Whole league", exact: true }).click();
  await expect(download).toHaveAttribute("href", "/api/calendar");
  await page.keyboard.press("Escape");

  // Below `sm` the page title can still keep the button beside the heading,
  // at the right edge (from about 460px); the menu must open back across
  // the screen there, not off its right side.
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 844 });
    await addToCalendar.click();
    await expect(download).toBeVisible();
    await expectNoHorizontalOverflow(page, `/schedule calendar menu at ${width}px`);
    await page.keyboard.press("Escape");
    await expect(download).toHaveCount(0);
  }

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
  // names and the match link keep their room. At the desktop
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
  // The banner counts the player's own side, on phones too; the names
  // behind that count are for captains, so a player sees none.
  await expect(page.getByText(/^1 of 5 in\b/)).toBeVisible();
  await expect(page.getByText("No reply", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "/schedule participant check-in");

  await login(page, "Schedule Home Captain", LOGISTICS.homeCaptain, matchHref!);
  // The captain is spoken to as the captain, and the Matchup card names who
  // hasn't answered yet.
  await expect(page.getByText(/^You're captaining /)).toBeVisible();
  await expect(
    page.locator("#match-matchup").getByText("no reply", { exact: true }).first(),
  ).toBeVisible();
  // Reschedule as a ready check: two times, one a quick pick and one typed
  // on the captain's own clock, plus a note.
  await page.locator("summary").filter({ hasText: "Propose new times" }).click();
  const proposed = await page.evaluate(() => {
    const d = new Date(Date.now() + 2 * 24 * 3600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  await page.locator('input[name="customTime"]').fill(proposed);
  await page.getByRole("button", { name: "+ Add time" }).click();
  const quickPick = page
    .getByRole("group", { name: /Quick picks/ })
    .getByRole("button")
    .first();
  await quickPick.click();
  await expect(quickPick).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel(/^Note/).fill("Two of us have exams that night");
  await page.getByRole("button", { name: /^Send ready check/ }).click();
  await expect(
    page.getByText("Ready check sent — waiting on everyone else"),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "/matches/[id] proposer ready check");

  // The player hears about it on Home and answers with one tap.
  await login(page, "Schedule Player", LOGISTICS.player, "/");
  await expect(page.getByText(/2 times to answer/)).toBeVisible();
  await page.getByRole("link", { name: /^Answer/ }).click();
  await expect(page).toHaveURL(/#match-reschedule$/);
  await expect(page.getByText("Two of us have exams that night")).toBeVisible();
  const imIn = page.getByRole("button", { name: "✓ I'm in" }).first();
  await imIn.click();
  await expect(imIn).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Thanks — answer the rest too")).toBeVisible();
  await expectNoHorizontalOverflow(page, "/matches/[id] player ready check");

  // The other captain is pointed at it, and locks the first time in without
  // waiting for the rest of the lineup.
  await login(page, "Schedule Away Captain", LOGISTICS.awayCaptain, matchHref!);
  await page.getByRole("link", { name: /Answer the ready check/ }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "🔒 Accept & lock in" })
    .first()
    .click();
  await expect(
    page.getByText(/^Locked in — match moved for both teams\./),
  ).toBeVisible();
  await expect(page.getByText("Locked in!")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reschedule" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/matches/[id] captain reschedule");

  // Each answer to the locked time is a check-in for the new kickoff: the
  // home side has its captain (the proposer's yes) and the player, the away
  // side the captain who locked it.
  await page.goto("/schedule");
  await page.setViewportSize({ width: 1024, height: 812 });
  await expect(
    page.getByRole("img", { name: /2 of 5 confirmed/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /1 of 5 confirmed/ }).first(),
  ).toBeVisible();
  assertNoErrors();
});

test("fully-played past weeks start collapsed and expand on click", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/schedule");

  // Scope to #fixtures: the header's hamburger and the page title's "Add to
  // calendar" button also carry aria-expanded and would otherwise be .first().
  const collapsed = page
    .locator('#fixtures button[aria-expanded="false"]')
    .first();
  await expect(collapsed).toBeVisible();
  const weekName = (await collapsed.getAttribute("aria-label"))!;
  const week = page.getByRole("button", { name: weekName, exact: true });
  // A closed week still lists each series' score on one line, and every line
  // opens its match.
  const results = page.getByRole("list", { name: `${weekName} results` });
  const firstResult = results.getByRole("link").first();
  await expect(firstResult).toHaveAttribute("href", /^\/matches\//);
  await expect(firstResult).toHaveText(/\d–\d/);
  await week.click();
  await expect(week).toHaveAttribute("aria-expanded", "true");
  // Expanded, the week shows the full match cards instead.
  await expect(results).toHaveCount(0);

  assertNoErrors();
});

test("the team filter narrows the week rows and the All teams option restores them", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/schedule");

  // count() doesn't auto-wait — anchor on rendered content first so the
  // streamed page is actually there before counting.
  await expect(page.getByText("Week 1").first()).toBeVisible();
  // Chrome's accessible name puts a space before the card link's sr-only
  // ": Home vs Away" suffix, so the name reads "Match page : …".
  const fixtures = page.locator("#fixtures");
  await expect(
    fixtures.getByRole("link", { name: /^Match page ?: / }).first(),
  ).toBeVisible();
  // Each series shows once, as a card in an open week or as a result line in
  // a closed one, so count distinct match links.
  const seriesShown = () =>
    fixtures
      .locator('a[href^="/matches/"]')
      .evaluateAll(
        (links) => new Set(links.map((link) => link.getAttribute("href"))).size,
      );
  const allSeries = await seriesShown();
  expect(allSeries).toBeGreaterThan(5);

  // The labeled selector exposes every team without sideways scrolling.
  const team = page.getByRole("combobox", { name: "Show matches for" });
  await team.selectOption({ index: 1 });
  // The fixture's 6-team single round robin gives every team one series a
  // week: 5 series. Finished earlier weeks stay closed as one-line results
  // under the filter instead of expanding the whole season.
  await expect.poll(seriesShown).toBe(5);
  await expect(
    fixtures.getByRole("list", { name: /^Week \d+ results$/ }),
  ).not.toHaveCount(0);
  // The dropdown's own "All teams" option is the one way back.
  await expect(page.getByRole("button", { name: "All teams" })).toHaveCount(0);
  await team.selectOption({ label: "All teams" });
  await expect.poll(seriesShown).toBe(allSeries);

  assertNoErrors();
});
