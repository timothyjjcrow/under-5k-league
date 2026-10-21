import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import path from "node:path";
import { trackPageErrors } from "../e2e-mid/helpers";

// The roll call (Tim, 2026-10-20), in a real browser: an admin opens it on
// /admin, a signed-up player sees the season's match night on their own
// clock on Home, taps "I'm in", and lands in the "Locked in" list; closing it
// takes the card off Home. Everything is put back at the end, so the specs
// after this one see the Home they expect.

// Explicitly pinned to Playwright's disposable database, never an .env URL.
const db = new PrismaClient({
  datasources: { db: { url: `file:${path.resolve("prisma/e2e.db")}` } },
});

const EUROPE = process.env.NEXT_PUBLIC_LEAGUE_REGION === "eu";
// The night as each league's pages print it, and a viewer an hour or three
// away from the league's clock, so the card has something to convert.
const NIGHT = EUROPE ? "Saturdays at 20:00 Berlin time" : "Saturdays at 2:00 PM Pacific time";
const VIEWER_ZONE = EUROPE ? "Europe/London" : "America/New_York";
const YOUR_TIME = EUROPE
  ? "That's Saturday at 19:00 in your local time (London)."
  : "That's Saturday at 5 PM in your local time (Eastern).";
// A seeded player (prisma/seed.ts), signed up for the season.
const PLAYER = { name: "Dendi", steamId: "7656119800001002" };
const ADMIN_LOGIN = "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1";

test.use({ timezoneId: VIEWER_ZONE });

test("an admin opens the roll call and a player locks in for the match night from Home", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const season = await db.season.findFirstOrThrow({ where: { isActive: true } });
  await db.rollCallAnswer.deleteMany({ where: { seasonId: season.id } });
  await db.season.update({
    where: { id: season.id },
    data: { matchSchedule: NIGHT, rollCallOpenedAt: null },
  });
  const player = await browser.newContext({ timezoneId: VIEWER_ZONE });
  try {
    const assertAdminErrors = trackPageErrors(page);
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${ADMIN_LOGIN}&redirect=${encodeURIComponent("/admin")}`);
    const section = page.locator("#adm-roll-call");
    // Set, not clicked: a toggle races the jump bar, which opens a section
    // itself when the page lands on its anchor.
    await section.evaluate((details) => {
      (details as HTMLDetailsElement).open = true;
    });
    await section.getByRole("button", { name: "Open the roll call", exact: true }).click();
    await expect(page.getByText(/^Roll call open:/)).toBeVisible();
    await expect(section.getByRole("button", { name: "Close the roll call" })).toBeVisible();

    const home = await player.newPage();
    const assertPlayerErrors = trackPageErrors(home);
    await home.goto(
      `/api/auth/dev?name=${PLAYER.name}&steamId=${PLAYER.steamId}&redirect=${encodeURIComponent("/#roll-call")}`,
    );
    const card = home.locator("#roll-call");
    await expect(card.getByRole("heading", { name: `Are you in for ${season.name}?` })).toBeVisible();
    await expect(card).toContainText(`Match night is ${NIGHT}.`);
    await expect(card.getByText(YOUR_TIME)).toBeVisible();
    const notYet = card.getByRole("heading", { name: /^Not yet/ }).locator("..");
    await expect(notYet.getByRole("link", { name: PLAYER.name })).toBeVisible();

    await card.getByRole("button", { name: "I'm in, lock me in" }).click();
    await expect(home.getByText(`You're in. Match night is ${NIGHT}. See you on the first one.`)).toBeVisible();
    await expect(card.getByText("You're locked in")).toBeVisible();
    const lockedIn = card.getByRole("heading", { name: /^Locked in/ }).locator("..");
    await expect(lockedIn.getByRole("link", { name: PLAYER.name })).toBeVisible();
    await expect(card.getByRole("progressbar", { name: "Players in" })).toHaveAttribute(
      "aria-valuenow",
      "1",
    );
    await expect
      .poll(async () => db.rollCallAnswer.count({ where: { seasonId: season.id } }))
      .toBe(1);

    // On a phone, nothing scrolls sideways.
    await home.setViewportSize({ width: 390, height: 844 });
    await home.reload();
    await expect(card.getByText("You're locked in")).toBeVisible();
    expect(
      await home.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);

    // The admin sees the answer, and closing takes the card off Home.
    await page.reload();
    await expect(section).toContainText(/1 of \d+ players are in/);
    await section.getByRole("button", { name: "Close the roll call", exact: true }).click();
    await expect(page.getByText(/^Roll call closed\./)).toBeVisible();
    await home.reload();
    await expect(home.getByRole("heading", { name: /^Are you in for/ })).toHaveCount(0);

    assertAdminErrors();
    assertPlayerErrors();
  } finally {
    await player.close();
    await db.rollCallAnswer.deleteMany({ where: { seasonId: season.id } });
    await db.season.update({
      where: { id: season.id },
      data: { matchSchedule: season.matchSchedule, rollCallOpenedAt: null },
    });
    await db.$disconnect();
  }
});
