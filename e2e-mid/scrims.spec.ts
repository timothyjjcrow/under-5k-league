import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
  untilHydrated,
} from "./helpers";

// A booked scrim tells each viewer what to do and how to set up its Dota
// lobby so the games record: the host captain, a teammate, someone on
// another team and a signed-out visitor each get their own view, and only the
// two teams see the lobby's password. Its teams' players also find it on
// /scrims, their team page and Home. Direct writes only stage the suite's own
// teams and scrim, and the finally block removes them.
// This suite writes only to the explicitly configured disposable fixture.
const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
test.use({ actionTimeout: 10_000 });
test.afterAll(async () => {
  await db.$disconnect();
});

type User = { id: string; steamId: string; name: string };
type Fixture = {
  scrimId: string;
  homeId: string;
  homeName: string;
  awayName: string;
  captain: User;
  teammate: User;
  outsider: User;
  ticket: string | null;
};

async function withScrim(
  request: APIRequestContext,
  run: (f: Fixture) => Promise<void>,
) {
  const suffix = randomUUID();
  const prefix = `scrims-browser-${suffix}`;
  const label = suffix.slice(0, 6);
  const season = await db.season.findFirstOrThrow({ where: { isActive: true } });
  const size = season.teamSize;
  const homeId = `${prefix}-home`;
  const awayId = `${prefix}-away`;
  const scrimId = `${prefix}-scrim`;
  const homeName = `Scrim Home ${label}`;
  const awayName = `Scrim Away ${label}`;
  // Home seats 0..size-1 (0 captains), away seats size..2size-1 (size
  // captains), then one signed-up player on neither team.
  const users: User[] = Array.from({ length: size * 2 + 1 }, (_, i) => ({
    id: `${prefix}-user-${i}`,
    steamId: `76561190000997${String(i).padStart(3, "0")}`,
    name: `Scrims ${label} player ${i + 1}`,
  }));
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
        data: users.map((user) => ({
          seasonId: season.id,
          userId: user.id,
          mmr: 2800,
          roles: "4,5",
          type: "PLAYER",
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
      // Booked for two hours from now: inside Home's scrim window.
      await tx.scrim.create({
        data: {
          id: scrimId,
          seasonId: season.id,
          hostTeamId: homeId,
          opponentTeamId: awayId,
          createdById: users[0].id,
          scheduledAt: new Date(Date.now() + 2 * 3_600_000),
          bestOf: 2,
          status: "SCHEDULED",
          participants: {
            create: users.slice(0, size * 2).map((user, i) => ({
              teamId: i < size ? homeId : awayId,
              userId: user.id,
              dotaAccountId: 994_000 + i,
              displayName: user.name,
              guest: false,
            })),
          },
        },
      });
    });
    expect((await request.post("/api/test/cache")).ok()).toBe(true);
    await run({
      scrimId,
      homeId,
      homeName,
      awayName,
      captain: users[0],
      teammate: users[1],
      outsider: users[size * 2],
      ticket: season.dotaLeagueId,
    });
  } finally {
    await db.$transaction(async (tx) => {
      const ids = users.map((user) => user.id);
      await tx.scrim.deleteMany({ where: { id: scrimId } });
      await tx.team.deleteMany({ where: { id: { in: [homeId, awayId] } } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    });
    expect((await request.post("/api/test/cache")).ok()).toBe(true);
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

test("a booked scrim shows each viewer their next step and the lobby setup", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await withScrim(request, async (f) => {
    const noErrors = trackPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });

    // The host captain: they host, with the lobby's name, password and the
    // ticket to set.
    await login(page, f.captain, `/scrims/${f.scrimId}`);
    const nextStep = page.getByTestId("scrim-next-step");
    await expect(nextStep).toContainText("You host. Make the lobby");
    const lobby = page.locator("#lobby");
    await expect(
      lobby.getByRole("heading", { name: "Lobby setup", exact: true }),
    ).toBeVisible();
    await expect(lobby.getByTitle("Copy lobby name")).toHaveText(/Scrim \d{4}/);
    const password = lobby.getByTitle("Copy password");
    await expect(password).toHaveText(/^[a-z2-9]{6}/);
    const hostPassword = (await password.innerText()).slice(0, 6);
    if (f.ticket) {
      await expect(lobby.getByTitle("Copy league ticket")).toContainText(f.ticket);
      await expect(lobby).toContainText("Records with the ticket");
    } else {
      await expect(lobby).toContainText("No league ticket yet");
    }
    await expect(page.locator("#results")).toContainText("No games recorded yet");

    // A teammate: their own next step and the same password.
    await login(page, f.teammate, `/scrims/${f.scrimId}`);
    await expect(nextStep).toContainText("Your team plays this scrim.");
    await expect(lobby.getByTitle("Copy password")).toContainText(hostPassword);
    await expect(page.getByRole("button", { name: "Cancel scrim" })).toHaveCount(0);

    // Someone on neither team: the steps, never the password.
    await login(page, f.outsider, `/scrims/${f.scrimId}`);
    await expect(lobby).toBeVisible();
    await expect(lobby.getByTitle("Copy password")).toHaveCount(0);
    await expect(lobby).toContainText(
      "Shown here to both teams' players when they're signed in.",
    );
    await expect(nextStep).toHaveCount(0);
    expect(await page.content()).not.toContain(hostPassword);

    // Signed out: the same, and nothing in the page source either.
    await page.context().clearCookies();
    await page.goto(`/scrims/${f.scrimId}`);
    await expect(lobby).toBeVisible();
    await expect(lobby.getByTitle("Copy password")).toHaveCount(0);
    expect(await page.content()).not.toContain(hostPassword);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/scrims/${f.scrimId}`);
    await expect(lobby).toBeVisible();
    await expectNoHorizontalOverflow(page, "booked scrim at 390px");
    noErrors();
  });
});

test("a team's players find their scrim on /scrims, their team page and Home", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await withScrim(request, async (f) => {
    const noErrors = trackPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });

    // /scrims leads with the team's own scrims, with the lobby one tap away.
    await login(page, f.teammate, "/scrims");
    const mine = page.locator("#your-team");
    await expect(
      mine.getByRole("heading", { name: `${f.homeName} scrims` }),
    ).toBeVisible();
    // Only a captain posts times.
    await expect(mine.getByRole("button", { name: "Post availability" })).toHaveCount(0);
    const row = mine
      .getByRole("list", { name: "Your team's scrims" })
      .getByRole("listitem")
      .filter({ hasText: `vs ${f.awayName}` });
    await expect(row).toContainText("your team hosts");
    await untilHydrated(page, row);
    await row.getByRole("link", { name: /Lobby setup/ }).click();
    await expect(page).toHaveURL(new RegExp(`/scrims/${f.scrimId}#lobby$`));

    // The team page lists it under Scrims.
    await page.goto(`/teams/${f.homeId}`);
    const scrims = page.locator("#team-scrims");
    await expect(scrims.getByRole("heading", { name: "Scrims", exact: true })).toBeVisible();
    await expect(
      scrims.getByRole("list", { name: "Coming up" }).getByRole("link", {
        name: `vs ${f.awayName}`,
      }),
    ).toHaveAttribute("href", `/scrims/${f.scrimId}`);

    // Home points a player at today's scrim.
    await page.goto("/");
    const today = page.getByTestId("home-scrim-today");
    await expect(today).toContainText(`vs ${f.awayName}`);
    await expect(today).toHaveAttribute("href", `/scrims/${f.scrimId}#lobby`);
    noErrors();
  });
});
