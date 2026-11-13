import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
  untilHydrated,
} from "./helpers";

// The Captains page (/captains): a captain runs their team from one page with
// the site's own controls. This drives each of them through its real form:
// book a standin from "Needs you", check in, send a ready check, post and
// cancel a scrim, manage a booked scrim (lobby setup, a guest), rename the
// team. Direct writes only stage the suite's own
// two teams and their fixture, and the finally block removes them.
// This suite writes only to the explicitly configured disposable fixture.
const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
const CHANGE_KEYS = ["resultChangedAt", "publicGameRevision"];
test.use({ actionTimeout: 10_000 });
test.afterAll(async () => {
  await db.$disconnect();
});

type User = { id: string; steamId: string; name: string };
type Fixture = {
  matchId: string;
  homeId: string;
  awayId: string;
  awayCaptain: User;
  homeName: string;
  awayName: string;
  captain: User;
  out: User;
  standin: User;
  teammate: User;
};

async function withFixture(
  request: APIRequestContext,
  run: (f: Fixture) => Promise<void>,
) {
  const suffix = randomUUID();
  const prefix = `captains-browser-${suffix}`;
  const label = suffix.slice(0, 6);
  const season = await db.season.findFirstOrThrow({ where: { isActive: true } });
  const size = season.teamSize;
  const homeId = `${prefix}-home`;
  const awayId = `${prefix}-away`;
  const matchId = `${prefix}-match`;
  const homeName = `Captains Home ${label}`;
  const awayName = `Captains Away ${label}`;
  // Home seats 0..size-1 (0 captains), away seats size..2size-1 (size
  // captains), then one standin.
  const users: User[] = Array.from({ length: size * 2 + 1 }, (_, i) => ({
    id: `${prefix}-user-${i}`,
    steamId: `76561190000993${String(i).padStart(3, "0")}`,
    name: `Captains ${label} player ${i + 1}`,
  }));
  const savedSettings = await db.setting.findMany({
    where: { key: { in: CHANGE_KEYS } },
  });
  try {
    await db.$transaction(async (tx) => {
      await tx.user.createMany({ data: users });
      await tx.team.createMany({
        data: [
          { id: homeId, seasonId: season.id, name: homeName, captainId: users[0].id },
          { id: awayId, seasonId: season.id, name: awayName, captainId: users[size].id },
        ],
      });
      await tx.registration.createMany({
        data: users.map((user, i) => ({
          seasonId: season.id,
          userId: user.id,
          mmr: 2800,
          roles: "4,5",
          type: i === size * 2 ? "STANDIN" : "PLAYER",
        })),
      });
      await tx.teamMember.createMany({
        data: users.slice(0, size * 2).map((user, i) => ({
          seasonId: season.id,
          teamId: i < size ? homeId : awayId,
          userId: user.id,
          isCaptain: i === 0 || i === size,
        })),
      });
      await tx.match.create({
        data: {
          id: matchId,
          seasonId: season.id,
          homeTeamId: homeId,
          awayTeamId: awayId,
          week: 97,
          bestOf: 3,
          status: "SCHEDULED",
          scheduledAt: new Date(Date.now() + 2 * 86400_000),
        },
      });
      // One home player can't make it and has no cover: the thing waiting.
      await tx.matchAvailability.create({
        data: { matchId, userId: users[1].id, status: "OUT" },
      });
    });
    expect((await request.post("/api/test/cache")).ok()).toBe(true);
    await run({
      matchId,
      homeId,
      awayId,
      awayCaptain: users[size],
      homeName,
      awayName,
      captain: users[0],
      out: users[1],
      standin: users[size * 2],
      teammate: users[2],
    });
  } finally {
    await db.$transaction(async (tx) => {
      const ids = users.map((user) => user.id);
      await tx.adminAction.deleteMany({ where: { actorId: { in: ids } } });
      await tx.setting.deleteMany({
        where: { key: { contains: prefix } },
      });
      await tx.match.deleteMany({ where: { id: matchId } });
      await tx.scrim.deleteMany({
        where: { OR: [{ hostTeamId: homeId }, { opponentTeamId: homeId }] },
      });
      await tx.team.deleteMany({ where: { id: { in: [homeId, awayId] } } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    });
    try {
      expect((await request.post("/api/test/cache")).ok()).toBe(true);
    } finally {
      await db.$transaction(async (tx) => {
        await tx.setting.deleteMany({ where: { key: { in: CHANGE_KEYS } } });
        if (savedSettings.length) await tx.setting.createMany({ data: savedSettings });
      });
    }
  }
}

async function login(page: Page, user: User, path: string) {
  const params = new URLSearchParams({
    steamId: user.steamId,
    name: user.name,
    redirect: path,
  });
  await page.goto(`/api/auth/dev?${params}`);
}

/** "2026-11-14T19:30" on the browser's own clock, `days` from now. */
async function localInput(page: Page, days: number) {
  return page.evaluate((d) => {
    const at = new Date(Date.now() + d * 24 * 3600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:00`;
  }, days);
}

test("a captain runs their team from the Captains page", async ({ page, request }) => {
  test.setTimeout(120_000);
  await withFixture(request, async (f) => {
    const noErrors = trackPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, f.captain, "/");
    await expect(page).toHaveURL(/\/$/);

    // The header and Home both lead here.
    const primary = page.locator('header > div nav[aria-label="Primary"]');
    await expect(
      primary.getByRole("link", { name: "Captains", exact: true }),
    ).toHaveAttribute("href", "/captains");
    const strip = page.getByTestId("captain-strip");
    await expect(strip).toContainText("1 thing needs you");
    await expect(strip).toContainText(`vs ${f.awayName}`);
    await untilHydrated(page, strip);
    await strip.click();
    await expect(page).toHaveURL(/\/captains$/);
    const main = page.locator("#main");
    await expect(
      main.getByRole("heading", { level: 1, name: "Captains", exact: true }),
    ).toBeVisible();

    // The open fixture says what the page does for it: standins and moving
    // the match are a tap away, on this page.
    const shortcuts = main.getByRole("navigation", { name: "Captain shortcuts" });
    await expect(
      shortcuts.getByRole("link", { name: /Find a standin/ }),
    ).toHaveAttribute("href", "#match-standins");
    await expect(
      shortcuts.getByRole("link", { name: /Change the time/ }),
    ).toHaveAttribute("href", "#match-reschedule");

    // "Line up cover" under the check-in stays on this page.
    await expect(
      main.getByRole("link", { name: /Line up cover/ }),
    ).toHaveAttribute("href", "#match-standins");

    // Needs you → the Standins card on this page → book cover there.
    const needs = main.getByRole("list", { name: "Needs you" });
    const line = needs.getByRole("listitem").filter({ hasText: f.out.name });
    await expect(line).toContainText("can't make it");
    await line.getByRole("link", { name: /Find a standin/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/captains\\?match=${f.matchId}#match-standins$`),
    );
    const standins = page.locator("#match-standins");
    await untilHydrated(page, standins);
    await standins
      .getByRole("combobox", { name: "Standin to bring in", exact: true })
      .selectOption(f.standin.id);
    await standins
      .getByRole("combobox", { name: "Player they cover", exact: true })
      .selectOption(f.out.id);
    await expect(standins).toContainText("Books straight away.");
    await standins.getByRole("button", { name: "Assign standin", exact: true }).click();
    await expect
      .poll(() =>
        db.standinAssignment.count({
          where: {
            matchId: f.matchId,
            teamId: f.homeId,
            standinUserId: f.standin.id,
            replacingUserId: f.out.id,
          },
        }),
      )
      .toBe(1);
    await expect(main).toContainText("Nothing needs you right now");

    // The captain's own check-in.
    await main.getByRole("button", { name: "✓ I'm in", exact: true }).first().click();
    await expect
      .poll(() =>
        db.matchAvailability.findUnique({
          where: { matchId_userId: { matchId: f.matchId, userId: f.captain.id } },
          select: { status: true },
        }),
      )
      .toEqual({ status: "IN" });

    // Move the match: a ready check sent from here.
    await main.locator("summary").filter({ hasText: "Propose new times" }).click();
    await main.locator('input[name="customTime"]').fill(await localInput(page, 3));
    await main.getByRole("button", { name: "+ Add time" }).click();
    await main.getByRole("button", { name: /^Send ready check/ }).click();
    await expect(
      page.getByText("Ready check sent — waiting on everyone else"),
    ).toBeVisible();
    expect(
      await db.rescheduleRequest.count({
        where: { matchId: f.matchId, status: "PENDING" },
      }),
    ).toBe(1);

    // Scrims: post a time, see it, cancel it.
    const scrims = page.locator("#scrims");
    await scrims.locator('input[name="scheduledAt"]').fill(await localInput(page, 4));
    await scrims.getByRole("button", { name: "Post availability", exact: true }).click();
    await expect(
      page.getByText("Scrim availability posted — another captain can claim it."),
    ).toBeVisible();
    const mine = scrims.getByRole("list", { name: "Your scrims" });
    await expect(mine).toContainText("Your open time");
    await expect(mine).toContainText("Waiting for a team");
    page.once("dialog", (dialog) => dialog.accept());
    await mine.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .poll(() =>
        db.scrim.count({ where: { hostTeamId: f.homeId, status: "CANCELLED" } }),
      )
      .toBe(1);
    await expect(scrims.getByRole("list", { name: "Your scrims" })).toHaveCount(0);

    // A booked scrim is run from here too: the other team posted a time and
    // this team claimed it (staged; claiming is the scrims suite's job).
    const season = await db.season.findFirstOrThrow({ where: { isActive: true } });
    const members = await db.teamMember.findMany({
      where: { teamId: { in: [f.homeId, f.awayId] } },
      select: { teamId: true, userId: true, user: { select: { name: true } } },
    });
    const scrim = await db.scrim.create({
      data: {
        seasonId: season.id,
        hostTeamId: f.awayId,
        opponentTeamId: f.homeId,
        createdById: f.awayCaptain.id,
        scheduledAt: new Date(Date.now() + 5 * 86400_000),
        bestOf: 3,
        status: "SCHEDULED",
        participants: {
          create: members.map((m, i) => ({
            teamId: m.teamId,
            userId: m.userId,
            displayName: m.user.name,
            dotaAccountId: 990_000_000 + i,
          })),
        },
      },
    });
    await page.goto("/captains");
    const desk = page.getByTestId("scrim-desk");
    await expect(
      desk.getByRole("heading", { name: `Your scrim vs ${f.awayName}` }),
    ).toBeVisible();
    await expect(desk.getByTestId("scrim-next-step")).toContainText(
      `${f.awayCaptain.name} hosts`,
    );
    await expect(desk.getByRole("heading", { name: "Lobby setup" })).toBeVisible();
    await expect(desk).toContainText("Lobby name");
    await expect(
      page
        .locator("#scrims")
        .getByRole("list", { name: "Your scrims" })
        .getByRole("link", { name: /Open below/ }),
    ).toHaveAttribute(
      "href",
      new RegExp(`/captains\\?match=${f.matchId}&scrim=${scrim.id}#scrim-desk$`),
    );
    // A casual guest for this side, added and removed without leaving.
    await untilHydrated(page, desk);
    await desk.getByRole("textbox", { name: "Guest name" }).fill("Captains Guest");
    await desk.getByRole("textbox", { name: "Dota or Steam ID" }).fill("123456789");
    await desk.getByRole("button", { name: "Add casual guest", exact: true }).click();
    const guests = () =>
      db.scrimParticipant.count({
        where: { scrimId: scrim.id, teamId: f.homeId, guest: true },
      });
    await expect.poll(guests).toBe(1);
    await expect(desk).toContainText("Captains Guest");
    page.once("dialog", (dialog) => dialog.accept());
    await desk.getByRole("button", { name: "Remove", exact: true }).click();
    await expect.poll(guests).toBe(0);
    // The fallback for a game that didn't record is here as well, folded
    // away while a ticketed season's games still record by themselves.
    const missing = desk.locator("summary").filter({ hasText: "Game missing?" });
    if (await missing.count()) await missing.click();
    await expect(
      desk.getByRole("button", { name: "Search for games", exact: true }),
    ).toBeVisible();

    // The team: rename it with the team page's own form.
    const renamed = `${f.homeName} Renamed`;
    const team = page.locator("#team");
    await team
      .getByRole("textbox", { name: `Name for ${f.homeName}`, exact: true })
      .fill(renamed);
    await team.getByRole("button", { name: "Save team", exact: true }).click();
    await expect
      .poll(() =>
        db.team.findUniqueOrThrow({ where: { id: f.homeId }, select: { name: true } }),
      )
      .toEqual({ name: renamed });
    await expect(main).toContainText(`${renamed} ·`);

    // A phone: the team tab is Captains, and the page fits.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/captains");
    const dock = page.getByRole("navigation", { name: "Quick navigation" });
    await expect(
      dock.getByRole("link", { name: "Captains", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expectNoHorizontalOverflow(page, "/captains at 390px");
    noErrors();
  });
});

test("a teammate who isn't captain gets no Captains link and a plain note", async ({
  page,
  request,
}) => {
  await withFixture(request, async (f) => {
    const noErrors = trackPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, f.teammate, "/");
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("link", { name: "Captains", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("captain-strip")).toHaveCount(0);
    await page.goto("/captains");
    await expect(
      page.getByRole("heading", { level: 1, name: "Captains", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#main")).toContainText(
      "This page is for team captains",
    );
    noErrors();
  });
});

test("a signed-out visitor is sent to sign in first", async ({ page }) => {
  await page.goto("/captains");
  await expect(page).toHaveURL(/\/login\?next=(%2F|\/)captains/);
});
