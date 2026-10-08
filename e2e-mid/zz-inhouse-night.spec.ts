import { test, expect, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// The inhouse night end to end: an admin plans one on /admin (the start box
// suggests the coming Friday at 8 PM on the league's clock), Home's inhouse
// line and /inhouse's card show it with calendar links, and the admin cancels
// it. The suite has no Discord, so nothing posts. A zz- spec because it
// writes league-wide state Home renders; it cancels its night at the end.

const NOTE = "First one (e2e): all ranks welcome";

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
  await signIn(page, "name=Night+Admin&steamId=76561190000994201&admin=1", "/admin");
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

  // 2. Home's inhouse line names it, with a countdown.
  await page.goto("/");
  const strip = page.getByRole("link").filter({ hasText: "Inhouse night:" });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole("timer")).toHaveAttribute(
    "aria-label",
    /^Inhouse night starts in /,
  );

  // 3. /inhouse's card: the note and both ways into a calendar.
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
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "/inhouse with an inhouse night");

  // 4. Cancel it: it comes off Home and the calendar file is gone.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin");
  section = await openNightSection(page);
  await expect(section.getByText(NOTE)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await section.getByRole("button", { name: "Cancel inhouse night" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /cancelled: Home and the inhouse page no longer show it\./ }),
  ).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("link").filter({ hasText: "Inhouse" }).first()).toBeVisible();
  await expect(page.getByText("Inhouse night:")).toHaveCount(0);
  expect((await page.request.get("/api/calendar/inhouse-night")).status()).toBe(404);
  noErrors();
});
