import { PrismaClient } from "@prisma/client";
import { test, expect, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// Play later end to end: a signed-out visitor finds the card under the room
// with a sign-in to post, and no strip at the top while nothing is posted; a
// player posts a time (the box starts on the next whole hour on their clock),
// which the strip above the room then shows, sees it with its calendar links
// and copies its link; a second player opens that link, which unfurls as the
// time and puts the card first with the time picked out (and no strip), and
// says they're in; back on /inhouse they say so from the strip, which shows
// at most three times; then both take it back and the time is gone, which
// its link then says. Nothing posts to Discord. A zz- spec because it writes
// state the inhouse page renders; it leaves no times behind.

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

// The card and the strip both name Play later; the card's region is exactly it.
const theCard = (page: Page) => page.getByRole("region", { name: "Play later", exact: true });
const theStrip = (page: Page) => page.getByRole("region", { name: "Play later times" });

test("players post an inhouse time, say they're in on it through its link, and take it back", async ({
  page,
  context,
  baseURL,
}) => {
  test.slow();
  const noErrors = trackPageErrors(page);
  await db.inhouseTimeRsvp.deleteMany();

  // 1. Signed out: the card sits under the room, with a sign-in to post, and
  //    nothing is open, so the top of the page has no strip.
  await page.goto("/inhouse");
  let card = theCard(page);
  await expect(card.getByRole("heading", { name: "Play later", level: 2 })).toBeVisible();
  await expect(card.getByText(/^Nobody has posted a time yet\./)).toBeVisible();
  await expect(card.getByRole("link", { name: "Sign in to post a time" })).toHaveAttribute(
    "href",
    "/login?next=%2Finhouse%23play-later",
  );
  expect(await top(page, "#play-later")).toBeGreaterThan(await top(page, "#live-room"));
  await expect(theStrip(page)).toHaveCount(0);

  // 2. A player posts the time the box starts on; the line under it says
  //    which time that is before they press anything.
  await signIn(page, POSTER, "/inhouse");
  card = theCard(page);
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
  // The posted time now leads the page too: the strip above the room, with
  // the poster's pressed "I'm in" and a link down to the card to post more.
  let strip = theStrip(page);
  await expect(strip.getByRole("heading", { name: "Play later", level: 2 })).toBeVisible();
  expect(await top(page, "#play-later-next")).toBeLessThan(await top(page, "#live-room"));
  await expect(strip.getByRole("listitem")).toHaveCount(1);
  await expect(strip.getByText("1 in · 9 more for a game")).toBeVisible();
  await expect(strip.getByRole("button", { name: "I'm in" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(strip.getByRole("img", { name: "Time Poster is in" })).toBeVisible();
  await expect(strip.getByRole("link", { name: "Post a time" })).toHaveAttribute(
    "href",
    "#play-later",
  );

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
  // The whole card is first, so the strip doesn't repeat it.
  await expect(theStrip(page)).toHaveCount(0);
  card = theCard(page);
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

  // 5. They take it back on the card; the time stays while anyone is in.
  await toggle.click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Okay, you're off / }),
  ).toBeVisible();
  await expect(row.getByText("1 in · 9 more for a game")).toBeVisible();

  // 6. On /inhouse itself the strip leads, and its "I'm in" is the card's:
  //    the same toggle, described by the tile's own time, and both agree.
  await page.goto("/inhouse");
  strip = theStrip(page);
  expect(await top(page, "#play-later-next")).toBeLessThan(await top(page, "#live-room"));
  const tileId = `inhouse-time-next-${Date.parse(link.searchParams.get("at")!)}`;
  const tile = strip.getByRole("listitem").filter({ has: page.locator(`#${tileId}`) });
  const stripToggle = tile.getByRole("button", { name: "I'm in" });
  await expect(stripToggle).toHaveAttribute("aria-pressed", "false");
  await expect(stripToggle).toHaveAttribute("aria-describedby", tileId);
  await stripToggle.click();
  await expect(page.getByRole("status").filter({ hasText: /^You're in for / })).toBeVisible();
  await expect(stripToggle).toHaveAttribute("aria-pressed", "true");
  await expect(tile.getByText("2 in · 8 more for a game")).toBeVisible();
  await expect(tile.getByRole("img", { name: "Time Poster and Time Joiner are in" })).toBeVisible();
  card = theCard(page);
  row = card.getByRole("listitem").filter({ has: page.locator(timeId) });
  await expect(row.getByText("2 in · 8 more for a game")).toBeVisible();
  await expect(row.getByRole("button", { name: "I'm in" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  //    Four times open: the strip shows the soonest three and counts the
  //    rest (written straight to the table, under a player of the fixture).
  const other = await db.user.findFirstOrThrow({
    where: { steamId: { notIn: ["76561190000995201", "76561190000995202"] } },
    select: { id: true },
  });
  const firstMs = Date.parse(link.searchParams.get("at")!);
  const later = [2, 3, 4].map((hours) => new Date(firstMs + hours * 60 * 60_000));
  await db.inhouseTimeRsvp.createMany({
    data: later.map((startsAt) => ({ startsAt, userId: other.id })),
  });
  await page.reload();
  await expect(strip.getByRole("listitem")).toHaveCount(3);
  await expect(strip.getByRole("link", { name: "1 more time" })).toBeVisible();
  await expect(tile).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "/inhouse with the Play later strip");
  //    On a phone the three swipe in one row: the queue stays on the first
  //    screen (the strip must not push it down).
  expect(await top(page, "#live-room")).toBeLessThan(844 - 120);
  await page.setViewportSize({ width: 1280, height: 900 });

  //    Signed out, the strip shows too, above the room, with a sign-in that
  //    comes back to the time.
  const visitor = await context.browser()!.newContext({ baseURL });
  const guest = await visitor.newPage();
  const guestErrors = trackPageErrors(guest);
  await guest.goto("/inhouse");
  const guestStrip = theStrip(guest);
  await expect(guestStrip.getByRole("listitem")).toHaveCount(3);
  expect(await top(guest, "#play-later-next")).toBeLessThan(await top(guest, "#live-room"));
  await expect(
    guestStrip.getByRole("link", { name: "I'm in" }).first(),
  ).toHaveAttribute("href", /^\/login\?next=%2Finhouse%3Fat%3D/);
  guestErrors();
  await visitor.close();
  await db.inhouseTimeRsvp.deleteMany({ where: { userId: other.id } });

  //    Taking it back from the strip.
  await page.reload();
  await expect(strip.getByRole("listitem")).toHaveCount(1);
  await stripToggle.click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Okay, you're off / }),
  ).toBeVisible();
  await expect(stripToggle).toHaveAttribute("aria-pressed", "false");
  await expect(tile.getByText("1 in · 9 more for a game")).toBeVisible();


  // 7. The poster takes theirs back: the time is gone, the strip with it,
  //    and its link says so.
  await signIn(page, POSTER, "/inhouse");
  card = theCard(page);
  row = card.getByRole("listitem").filter({ has: page.locator(timeId) });
  await row.getByRole("button", { name: "I'm in" }).click();
  await expect(card.getByText(/^Nobody has posted a time yet\./)).toBeVisible();
  await expect(theStrip(page)).toHaveCount(0);
  await page.goto(`${link.pathname}${link.search}`);
  await expect(
    page.getByText("The time in that link is over, or everyone on it has dropped out."),
  ).toBeVisible();
  expect((await page.request.get(icsHref!)).status()).toBe(404);

  // 8. A time that started a few minutes ago, the only one open, which this
  //    player is in on: its full-width tile offers "Join the queue" and the
  //    pressed "I'm in" (taking it back is never hidden), at the tile's foot,
  //    clear of the time and its countdown, on a phone and a tablet.
  const poster = await db.user.findFirstOrThrow({
    where: { steamId: "76561190000995201" },
    select: { id: true },
  });
  const startedAt = new Date(Math.floor((Date.now() - 5 * 60_000) / 60_000) * 60_000);
  await db.inhouseTimeRsvp.create({ data: { startsAt: startedAt, userId: poster.id } });
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/inhouse");
    const onTile = theStrip(page).getByRole("listitem");
    await expect(onTile).toHaveCount(1);
    const join = onTile.getByRole("link", { name: "Join the queue" });
    const taken = onTile.getByRole("button", { name: "I'm in" });
    await expect(join).toBeVisible();
    await expect(taken).toHaveAttribute("aria-pressed", "true");
    const timer = (await onTile.getByRole("timer").boundingBox())!;
    for (const control of [join, taken]) {
      const box = (await control.boundingBox())!;
      const overlaps =
        timer.x < box.x + box.width &&
        box.x < timer.x + timer.width &&
        timer.y < box.y + box.height &&
        box.y < timer.y + timer.height;
      expect(overlaps, `the countdown clears the tile's buttons at ${width}px`).toBe(false);
    }
    await expectNoHorizontalOverflow(page, `/inhouse with a Play later time that's on (${width}px)`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await db.inhouseTimeRsvp.deleteMany({ where: { startsAt: startedAt } });
  noErrors();
});
