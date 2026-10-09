import { PrismaClient } from "@prisma/client";
import { test, expect, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// The inhouse night end to end: an admin plans one on /admin (the start box
// suggests the coming Friday at 8 PM on the league's clock), Home's bar and
// /inhouse's card show it with calendar links, a player says "I'm in" from
// the bar, takes it back on /inhouse and says it again, a second player
// arrives through the invite link, and the admin cancels it. "I'm in" needs
// a linked Discord account (the suite switches linking on), so each player is
// first sent to link it, and the spec links them in the database instead of
// going through Discord. The suite has no Discord bot or webhook, so nothing
// posts and the headcount is the site's alone. A zz- spec because it writes
// league-wide state Home renders; it cancels its night at the end.

const NOTE = "First one (e2e): all ranks welcome";
const ADMIN = "name=Night+Admin&steamId=76561190000994201&admin=1";
const PLAYER = "name=Night+Player&steamId=76561190000994202";
const INVITED = "name=Invited+Player&steamId=76561190000994203";
const LINK_DISCORD = "/api/auth/discord?next=%2Finhouse%3Fimin%3D1";

const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
test.afterAll(async () => {
  await db.$disconnect();
});

/** What Discord's OAuth callback stores, without a trip to Discord. */
async function linkDiscord(steamId: string) {
  await db.user.update({
    where: { steamId },
    data: { discordId: `7${steamId.slice(-17)}`, discordName: `e2e_${steamId.slice(-4)}` },
  });
}

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
  context,
  baseURL,
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
  // Signed out, "I'm in" signs in and comes back through the invite link,
  // which then says it for them.
  await expect(bar.getByRole("link", { name: "I'm in" })).toHaveAttribute(
    "href",
    "/login?next=%2Finhouse%3Fimin%3D1",
  );
  await expect(bar.getByRole("link", { name: "Inhouse night" })).toHaveAttribute(
    "href",
    "/inhouse",
  );
  // The inhouse strip lower down no longer repeats the night.
  await expect(page.getByText("Inhouse night:")).toHaveCount(0);

  // 3. A player without a linked Discord is sent to link it first, from the
  //    bar and the card; linked, they say they're in from the bar: one
  //    toggle, like Discord's Interested button.
  await signIn(page, PLAYER, "/");
  bar = page.getByRole("region", { name: "Inhouse night" });
  await expect(bar.getByRole("link", { name: "I'm in" })).toHaveAttribute("href", LINK_DISCORD);
  await page.goto("/inhouse");
  await expect(page.getByRole("link", { name: "Link Discord to say you're in" })).toHaveAttribute(
    "href",
    LINK_DISCORD,
  );
  await linkDiscord("76561190000994202");
  await page.goto("/");
  bar = page.getByRole("region", { name: "Inhouse night" });
  const barToggle = bar.getByRole("button", { name: "I'm in" });
  await expect(barToggle).toHaveAttribute("aria-pressed", "false");
  await barToggle.click();
  await expect(
    page.getByRole("status").filter({
      hasText: /You're in for .+\. You'll get a Discord ping when it starts\./,
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

  // 5. The invite link: it unfurls as the night with its own picture, the
  //    card copies it, and a new player who opens it is in after signing in,
  //    with the invite scrubbed from the address so a refresh can't repeat it.
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    /^Inhouse night · /,
  );
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    "content",
    /1 coming\. Open this to say you're in/,
  );
  const picture = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(picture).toMatch(/\/inhouse\/opengraph-image/);
  const drawn = await page.request.get(new URL(picture!).pathname + new URL(picture!).search);
  expect(drawn.status()).toBe(200);
  expect(drawn.headers()["content-type"]).toBe("image/png");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy invite link" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /paste it in Discord and it shows the night/ }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    new URL("/inhouse?imin=1", baseURL).href,
  );

  // Without a linked Discord the invite asks for the link, never bouncing to
  // Discord by itself, and the card's button goes to Discord's consent
  // (which would come back to the invite). The spec reads where it would go
  // and stops there, so the suite never loads Discord.
  let consent: URL | null = null;
  const accountLink = (url: URL) => url.pathname === "/api/auth/discord";
  await page.route(accountLink, async (route) => {
    const sent = await route.fetch({ maxRedirects: 0 });
    consent = new URL(sent.headers()["location"]);
    await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Discord</title>" });
  });
  await page.context().clearCookies();
  await signIn(page, INVITED, "/inhouse?imin=1");
  await expect(
    page.getByRole("status").filter({ hasText: /^One step left: press Link Discord to say you're in/ }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/inhouse$/);
  expect(consent).toBeNull();
  await page.getByRole("link", { name: "Link Discord to say you're in" }).click();
  await expect(page).toHaveURL(new URL(LINK_DISCORD, baseURL).href);
  expect(consent).not.toBeNull();
  expect(consent!.origin + consent!.pathname).toBe("https://discord.com/oauth2/authorize");
  expect(consent!.searchParams.get("client_id")).toBe("e2e-discord-client");
  // The callback's origin is APP_URL when one is set, so only its path is ours to check.
  expect(consent!.searchParams.get("redirect_uri")).toMatch(/\/api\/auth\/discord\/callback$/);
  await page.unroute(accountLink);
  await linkDiscord("76561190000994203");
  await page.goto("/inhouse?imin=1");
  await expect(
    page.getByRole("status").filter({ hasText: /^You're in for / }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "I'm in" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page).toHaveURL(/\/inhouse$/);
  await expect(page.getByRole("link", { name: "Invited Player" })).toBeVisible();

  // 6. Cancel it: the confirm counts who said they're in, it comes off Home
  //    and the calendar file is gone.
  await signIn(page, ADMIN, "/admin");
  section = await openNightSection(page);
  await expect(section.getByText(NOTE)).toBeVisible();
  await expect(section.getByText("2 said they're in on the site.")).toBeVisible();
  await expect(section.getByRole("button", { name: "Copy invite link" })).toBeVisible();
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
  expect(confirmText).toContain("2 players said they're in on the site; their list goes with it.");
  await page.goto("/");
  await expect(page.getByRole("link").filter({ hasText: "Inhouse" }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Inhouse night" })).toHaveCount(0);
  expect((await page.request.get("/api/calendar/inhouse-night")).status()).toBe(404);
  noErrors();
});
