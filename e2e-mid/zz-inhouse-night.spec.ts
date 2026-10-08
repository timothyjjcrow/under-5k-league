import { test, expect, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// The inhouse night end to end: an admin plans one on /admin (the start box
// suggests the coming Friday at 8 PM on the league's clock), Home's bar and
// /inhouse's card show it with calendar links, a player says "I'm in" from
// the bar, takes it back on /inhouse and says it again, and the admin
// cancels it. The suite has no Discord, so nothing posts and the headcount is
// the site's alone. A zz- spec because it writes league-wide state Home
// renders; it cancels its night at the end.

const NOTE = "First one (e2e): all ranks welcome";
const ADMIN = "name=Night+Admin&steamId=76561190000994201&admin=1";
const PLAYER = "name=Night+Player&steamId=76561190000994202";

async function signIn(page: Page, query: string, redirect: string) {
  await page.goto(`/api/auth/dev?${query}&redirect=${encodeURIComponent(redirect)}`);
}

async function openNightSection(page: Page) {
  const section = page.locator("#adm-inhouse-night");
  await page
    .getByRole("navigation", { name: "Admin sections" })
    .getByRole("link", { name: "Inhouse night", exact: true })
    .click();
  await expect(section).toHaveAttribute("open", "");
  return section;
}

test("an admin plans an inhouse night that Home and the inhouse page show, then cancels it", async ({
  page,
}) => {
  test.slow();
  const noErrors = trackPageErrors(page);

  // 1. Plan it with the suggested start and a note.
  await signIn(page, ADMIN, "/admin");
  let section = await openNightSection(page);
  await expect(section.getByText("None planned", { exact: false }).first()).toBeVisible();
  await section.getByLabel("Note (optional)").fill(NOTE);
  await section.getByRole("button", { name: "Plan inhouse night" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Inhouse night set for .+: Home and the inhouse page show it\./ }),
  ).toBeVisible();
  // No webhook in the suite: the toast says so instead of claiming a post.
  await expect(
    page.getByRole("status").filter({ hasText: /post didn't go out/ }),
  ).toBeVisible();

  // 2. Home's thin bar leads the page: the night with a countdown, and
  //    "I'm in" for someone signed out goes through sign-in back to Home.
  await page.context().clearCookies();
  await page.goto("/");
  let bar = page.getByRole("region", { name: "Inhouse night" });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("timer")).toHaveAttribute(
    "aria-label",
    /^Inhouse night starts in /,
  );
  const barTop = (await bar.boundingBox())!.y;
  const heroTop = (await page.getByRole("heading", { level: 1 }).boundingBox())!.y;
  expect(barTop).toBeLessThan(heroTop);
  await expect(bar.getByRole("link", { name: "I'm in" })).toHaveAttribute(
    "href",
    "/login?next=%2F",
  );
  await expect(bar.getByRole("link", { name: "Inhouse night" })).toHaveAttribute(
    "href",
    "/inhouse",
  );
  // The inhouse strip lower down no longer repeats the night.
  await expect(page.getByText("Inhouse night:")).toHaveCount(0);

  // 3. A player says they're in from the bar: one toggle, like Discord's
  //    Interested button.
  await signIn(page, PLAYER, "/");
  bar = page.getByRole("region", { name: "Inhouse night" });
  const barToggle = bar.getByRole("button", { name: "I'm in" });
  await expect(barToggle).toHaveAttribute("aria-pressed", "false");
  await barToggle.click();
  await expect(
    page.getByRole("status").filter({
      hasText: /You're in for .+\. Link Discord under My account to get a ping when it starts\./,
    }),
  ).toBeVisible();
  await expect(barToggle).toHaveAttribute("aria-pressed", "true");
  await expect(bar.getByText("1 coming")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "Home with the inhouse night bar");
  await page.setViewportSize({ width: 1280, height: 900 });

  // 4. /inhouse's card: the note, who's in, both ways into a calendar, and
  //    taking it back (then saying it again).
  await page.goto("/inhouse");
  await expect(page.getByRole("heading", { name: "Inhouse night", level: 2 })).toBeVisible();
  await expect(page.getByText(NOTE)).toBeVisible();
  await expect(page.getByRole("link", { name: "Add to Google Calendar" })).toHaveAttribute(
    "href",
    /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&/,
  );
  await expect(
    page.getByRole("link", { name: "Add to Apple or Outlook calendar (.ics)" }),
  ).toHaveAttribute("href", "/api/calendar/inhouse-night");
  const ics = await page.request.get("/api/calendar/inhouse-night");
  expect(ics.status()).toBe(200);
  expect(ics.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
  expect(await ics.text()).toContain("BEGIN:VEVENT");
  await expect(page.getByText("Said I'm in on the site:")).toBeVisible();
  await expect(page.getByRole("link", { name: "Night Player" })).toHaveAttribute(
    "href",
    /^\/players\//,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "/inhouse with an inhouse night");
  await page.setViewportSize({ width: 1280, height: 900 });
  const cardToggle = page.getByRole("button", { name: "I'm in" });
  await expect(cardToggle).toHaveAttribute("aria-pressed", "true");
  await cardToggle.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Okay, you're off the list for this inhouse night." }),
  ).toBeVisible();
  await expect(cardToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Said I'm in on the site:")).toHaveCount(0);
  await cardToggle.click();
  await expect(cardToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Said I'm in on the site:")).toBeVisible();

  // 5. Cancel it: the confirm counts who said they're in, it comes off Home
  //    and the calendar file is gone.
  await signIn(page, ADMIN, "/admin");
  section = await openNightSection(page);
  await expect(section.getByText(NOTE)).toBeVisible();
  await expect(section.getByText("1 said they're in on the site.")).toBeVisible();
  let confirmText = "";
  page.once("dialog", (dialog) => {
    confirmText = dialog.message();
    void dialog.accept();
  });
  await section.getByRole("button", { name: "Cancel inhouse night" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /cancelled: Home and the inhouse page no longer show it\./ }),
  ).toBeVisible();
  expect(confirmText).toContain("1 player said they're in on the site; their list goes with it.");
  await page.goto("/");
  await expect(page.getByRole("link").filter({ hasText: "Inhouse" }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Inhouse night" })).toHaveCount(0);
  expect((await page.request.get("/api/calendar/inhouse-night")).status()).toBe(404);
  noErrors();
});
