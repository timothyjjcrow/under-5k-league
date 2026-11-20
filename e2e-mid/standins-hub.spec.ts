import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
  untilHydrated,
} from "./helpers";

// The Standins page (/standins) is the one place standins are coordinated
// (Tim, 2026-11-17). This drives the whole loop through the real forms: a
// standin says "I can play" for a game a player can't make, that team's
// captain books them from the list on the same page, and the standin then
// says they can't make it, which gives the seat back so the game is listed
// again. Direct writes only stage the suite's own two teams, their fixture
// and the player who is out; the finally block removes them. This suite
// writes only to the explicitly configured disposable fixture.
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
  homeName: string;
  awayName: string;
  captain: User;
  out: User;
  /** A home player who is in: neither the captain nor the one who is out. */
  teammate: User;
  standin: User;
};

async function withFixture(
  request: APIRequestContext,
  run: (f: Fixture) => Promise<void>,
) {
  const suffix = randomUUID();
  const prefix = `standins-hub-${suffix}`;
  const label = suffix.slice(0, 6);
  const season = await db.season.findFirstOrThrow({ where: { isActive: true } });
  const size = season.teamSize;
  const homeId = `${prefix}-home`;
  const awayId = `${prefix}-away`;
  const matchId = `${prefix}-match`;
  const homeName = `Hub Home ${label}`;
  const awayName = `Hub Away ${label}`;
  // Home seats 0..size-1 (0 captains), away seats size..2size-1 (size
  // captains), then one standin.
  const users: User[] = Array.from({ length: size * 2 + 1 }, (_, i) => ({
    id: `${prefix}-user-${i}`,
    steamId: `76561190000998${String(i).padStart(3, "0")}`,
    name: `Hub ${label} player ${i + 1}`,
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
      // Everyone level at 2800, so the captain's pick books straight away.
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
          week: 96,
          bestOf: 3,
          status: "SCHEDULED",
          scheduledAt: new Date(Date.now() + 2 * 86400_000),
        },
      });
      // One home player can't make it and has no cover: the game lists itself.
      await tx.matchAvailability.create({
        data: { matchId, userId: users[1].id, status: "OUT" },
      });
    });
    expect((await request.post("/api/test/cache")).ok()).toBe(true);
    await run({
      matchId,
      homeId,
      homeName,
      awayName,
      captain: users[0],
      out: users[1],
      teammate: users[2],
      standin: users[size * 2],
    });
  } finally {
    await db.$transaction(async (tx) => {
      await tx.setting.deleteMany({ where: { key: { contains: prefix } } });
      await tx.match.deleteMany({ where: { id: matchId } });
      await tx.team.deleteMany({ where: { id: { in: [homeId, awayId] } } });
      await tx.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
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

test("a standin offers, the captain picks on the same page, and a drop-out lists the game again", async ({ page, request }) => {
  test.setTimeout(120_000);
  await withFixture(request, async (f) => {
    const noErrors = trackPageErrors(page);
    const hub = `/standins?match=${f.matchId}`;
    const game = page.locator(`#need-${f.matchId}-${f.homeId}`);

    // The standin finds the game and says they can play.
    await login(page, f.standin, "/standins");
    await untilHydrated(page, game);
    await expect(game).toContainText(`${f.homeName} needs a standin`);
    // The board never names who is out.
    await expect(game).not.toContainText(f.out.name);
    await game.getByRole("button", { name: "I can play", exact: true }).click();
    await expect(
      page.getByText(`You're on the list for ${f.homeName}.`, { exact: false }).first(),
    ).toBeVisible();
    await expect(game).toContainText("You're on the list.");
    await expect
      .poll(() => db.standinOffer.count({ where: { matchId: f.matchId } }))
      .toBe(1);

    // The captain picks from the list on the same page, in one tap.
    await login(page, f.captain, hub);
    const cover = page.locator(`#cover-${f.matchId}`);
    await untilHydrated(page, cover);
    await expect(cover).toContainText(`Out and uncovered: ${f.out.name}`);
    const offered = cover.getByRole("listitem").filter({ hasText: f.standin.name });
    await expect(offered).toContainText(`for ${f.out.name}`);
    // The captain's own side is in their section, never on the list below.
    await expect(game).toHaveCount(0);
    await offered.getByRole("button", { name: `Book ${f.standin.name}`, exact: true }).click();
    await expect
      .poll(() =>
        db.standinAssignment.count({
          where: { matchId: f.matchId, standinUserId: f.standin.id, replacingUserId: f.out.id },
        }),
      )
      .toBe(1);
    await expect(cover).toContainText(`${f.standin.name} in for ${f.out.name}`);
    // A booking answers the standin's offer.
    expect(await db.standinOffer.count({ where: { matchId: f.matchId } })).toBe(0);

    // The standin sees the game under "Your games" and can't make it after
    // all: confirming gives the seat back.
    await login(page, f.standin, "/standins");
    const mine = page.getByRole("region", { name: "Your games" });
    await untilHydrated(page, mine);
    await expect(mine).toContainText(f.homeName);
    page.once("dialog", (dialog) => dialog.accept());
    await mine.getByRole("button", { name: "✗ Can't make it", exact: true }).click();
    await expect(
      page.getByText("You're off this match.", { exact: false }).first(),
    ).toBeVisible();
    await expect
      .poll(() => db.standinAssignment.count({ where: { matchId: f.matchId } }))
      .toBe(0);
    // The seat is open again, so the game is back on the list.
    await page.goto("/standins");
    await expect(game).toContainText(`${f.homeName} needs a standin`);
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoHorizontalOverflow(page, "standins page at 390px");

    // …and the captain is asked for cover again, wherever they look.
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, f.captain, "/captains");
    const needs = page.getByRole("list", { name: "Needs you" });
    await expect(needs).toContainText(`${f.out.name} can't make it`);
    await expect(
      needs.getByRole("link", { name: /Find a standin/ }),
    ).toHaveAttribute("href", hub);
    noErrors();
  });
});

// Tim, 2026-11-20: any player on the team can copy the game's standin link,
// as the captain can. The teammate's own side leads the list with the link
// where a standin would see "I can play", and the player who is out is sent
// there from their check-in.
test("a teammate copies their team's standin link, and the player who is out is sent to it", async ({ page, request, context, baseURL }) => {
  test.setTimeout(90_000);
  await withFixture(request, async (f) => {
    const noErrors = trackPageErrors(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const game = page.locator(`#need-${f.matchId}-${f.homeId}`);

    await login(page, f.teammate, "/standins");
    await untilHydrated(page, game);
    // Their own side leads the list, marked as theirs.
    await expect(page.locator('[id^="need-"]').first()).toHaveAttribute(
      "id",
      `need-${f.matchId}-${f.homeId}`,
    );
    await expect(game).toContainText(`${f.homeName} needs a standin`);
    await expect(game).toContainText("Your team");
    await expect(game).not.toContainText("can't stand in");
    await expect(game.getByRole("button", { name: "I can play" })).toHaveCount(0);
    // The board still never names who is out.
    await expect(game).not.toContainText(f.out.name);
    await game.getByRole("button", { name: /Copy standin link/ }).click();
    await expect(game.getByRole("button", { name: /Copied!/ })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      new URL(
        `/standins?match=${encodeURIComponent(f.matchId)}&team=${encodeURIComponent(f.homeId)}&play=1`,
        baseURL,
      ).href,
    );
    // Copying offers nothing: a teammate is never on their own side's list.
    expect(await db.standinOffer.count({ where: { matchId: f.matchId } })).toBe(0);
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoHorizontalOverflow(page, "standins page for a teammate at 390px");
    await page.setViewportSize({ width: 1280, height: 900 });

    // The player who is out is pointed at the game from their check-in.
    await login(page, f.out, `/matches/${f.matchId}`);
    const help = page.getByRole("link", { name: /Help find a standin/ });
    await expect(help).toHaveAttribute(
      "href",
      `/standins?match=${encodeURIComponent(f.matchId)}`,
    );
    noErrors();
  });
});
