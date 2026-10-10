import { PrismaClient } from "@prisma/client";
import { test, expect, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// Play later end to end: a signed-out visitor finds the card under the room
// with a sign-in to post; a player posts a time (the box starts on the next
// whole hour on their clock), sees it with its calendar links and copies its
// link; a second player opens that link, which unfurls as the time and puts
// the card first with the time picked out, and says they're in; then both
// take it back and the time is gone, which its link then says. Nothing posts
// to Discord. A zz- spec because it writes state the inhouse page renders;
// it leaves no times behind.

const POSTER = "name=Time+Poster&steamId=76561190000995201";
const JOINER = "name=Time+Joiner&steamId=76561190000995202";

const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
test.afterAll(async () => {
  await db.inhouseTimeRsvp.deleteMany();
  await db.$disconnect();
});

async function signIn(page: Page, query: string, redirect: string) {
  await page.goto(`/api/auth/dev?${query}&redirect=${encodeURIComponent(redirect)}`);
}

const top = async (page: Page, selector: string) =>
  (await page.locator(selector).boundingBox())!.y;

test("players post an inhouse time, say they're in on it through its link, and take it back", async ({
  page,
  context,
  baseURL,
}) => {
  test.slow();
  const noErrors = trackPageErrors(page);
  await db.inhouseTimeRsvp.deleteMany();

  // 1. Signed out: the card sits under the room, with a sign-in to post.
  await page.goto("/inhouse");
  let card = page.getByRole("region", { name: "Play later" });
  await expect(card.getByRole("heading", { name: "Play later", level: 2 })).toBeVisible();
  await expect(card.getByText(/^Nobody has posted a time yet\./)).toBeVisible();
  await expect(card.getByRole("link", { name: "Sign in to post a time" })).toHaveAttribute(
    "href",
    "/login?next=%2Finhouse%23play-later",
  );
  expect(await top(page, "#play-later")).toBeGreaterThan(await top(page, "#live-room"));

  // 2. A player posts the time the box starts on; the line under it says
  //    which time that is before they press anything.
  await signIn(page, POSTER, "/inhouse");
  card = page.getByRole("region", { name: "Play later" });
  await expect(card.getByLabel("Post a time")).toHaveValue(/^\d{2}:00$/);
  await expect(card.getByText(/^(Today|Tomorrow), .+ · in \d/)).toBeVisible();
  // The worked-out start survives the line's re-render, not just the submit.
  await expect(card.locator('input[name="at"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}T\d{2}:00Z$/);
  await card.getByRole("button", { name: "Post time" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: /^You posted .+\. Copy its link to share it in Discord\.$/,
    }),
  ).toBeVisible();
  let row = card.getByRole("listitem").filter({ hasText: "1 in · 9 more for a game" });
  await expect(row.getByRole("button", { name: "I'm in" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The box is back on its starting time, which the line says they're in on.
  await expect(card.getByText(/ · you're already in on it$/)).toBeVisible();
  await expect(row.getByRole("link", { name: "Time Poster" })).toHaveAttribute(
    "href",
    /^\/players\//,
  );
  // In on it and waiting: the calendar links are the reminder.
  await expect(row.getByRole("link", { name: "Add to Google Calendar" })).toHaveAttribute(
    "href",
    /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&/,
  );
  const icsHref = await row.getByRole("link", { name: "Apple or Outlook (.ics)" }).getAttribute("href");
  const ics = await page.request.get(icsHref!);
  expect(ics.status()).toBe(200);
  expect(ics.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
  expect(await ics.text()).toContain("BEGIN:VEVENT");

  // 3. Its link, copied from the row.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await row.getByRole("button", { name: "Copy link" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /paste it in Discord and it shows this time/ }),
  ).toBeVisible();
  const link = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(link.origin).toBe(new URL(baseURL!).origin);
  expect(link.pathname).toBe("/inhouse");
  expect(link.searchParams.get("at")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
  const timeId = `#inhouse-time-${Date.parse(link.searchParams.get("at")!)}`;

  // 4. A second player opens it: it unfurls as the time with the league's
  //    picture (the page's own is the night's), puts the card first with the
  //    time picked out, and signs nobody up until they press "I'm in".
  await page.context().clearCookies();
  await signIn(page, JOINER, `${link.pathname}${link.search}`);
  // The sign-in's redirect may percent-encode the colons; the time is the same.
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname} ${url.searchParams.get("at")}`;
    })
    .toBe(`/inhouse ${link.searchParams.get("at")}`);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    /^Inhouse · /,
  );
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    "content",
    /^1 in · 9 more for a game\. Open this to say you're in/,
  );
  expect(
    new URL((await page.locator('meta[property="og:image"]').getAttribute("content"))!).pathname,
  ).toMatch(/^\/(opengraph-image\.png|brand\/ggd2l-europe-og\.png)$/);
  expect(await top(page, "#play-later")).toBeLessThan(await top(page, "#live-room"));
  card = page.getByRole("region", { name: "Play later" });
  row = card.getByRole("listitem").filter({ has: page.locator(timeId) });
  await expect(row).toHaveClass(/border-accent/);
  const toggle = row.getByRole("button", { name: "I'm in" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAttribute("aria-describedby", timeId.slice(1));
  await toggle.click();
  await expect(page.getByRole("status").filter({ hasText: /^You're in for / })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByText("2 in · 8 more for a game")).toBeVisible();
  await expect(row.getByRole("link", { name: "Time Joiner" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "/inhouse opened from a Play later link");
  await page.setViewportSize({ width: 1280, height: 900 });

  // 5. Both take it back: the time stays while anyone is in, then it's gone,
  //    and its link says so.
  await toggle.click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Okay, you're off / }),
  ).toBeVisible();
  await expect(row.getByText("1 in · 9 more for a game")).toBeVisible();
  await signIn(page, POSTER, "/inhouse");
  card = page.getByRole("region", { name: "Play later" });
  row = card.getByRole("listitem").filter({ has: page.locator(timeId) });
  await row.getByRole("button", { name: "I'm in" }).click();
  await expect(card.getByText(/^Nobody has posted a time yet\./)).toBeVisible();
  await page.goto(`${link.pathname}${link.search}`);
  await expect(
    page.getByText("The time in that link is over, or everyone on it has dropped out."),
  ).toBeVisible();
  expect((await page.request.get(icsHref!)).status()).toBe(404);
  noErrors();
});
