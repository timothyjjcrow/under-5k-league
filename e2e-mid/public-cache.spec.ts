import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import { trackPageErrors } from "./helpers";

// Never inherit DATABASE_URL: all fixture writes belong to this suite's exact,
// disposable database. The normal shared seed remains intact after this test.
const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
const ADMIN_STEAM_ID = "76561190000991891";
const VIEWER_STEAM_ID = "76561190000991892";
const DOTA_MATCH_ID = "9900018901";
const CHANGE_KEYS = ["resultChangedAt", "publicGameRevision"];

test.afterAll(async () => { await db.$disconnect(); });

async function invalidateFixtureCache(request: APIRequestContext) {
  expect((await request.post("/api/test/cache")).ok()).toBe(true);
}

async function withPublicFixture(
  request: APIRequestContext,
  run: (fixture: {
    seasonId: string; seasonName: string; homeId: string; awayId: string;
    homeName: string; renamedHome: string; playerId: string; playerName: string;
    gameId: string; matchId: string; scoutingId: string;
  }) => Promise<void>,
) {
  const season = await db.season.findFirstOrThrow({ where: { isActive: true } });
  expect(season.status, "the midseason suite must keep its regular-season fixture").toBe("REGULAR_SEASON");
  const suffix = randomUUID();
  const prefix = `public-cache-${suffix}`;
  const userIds = Array.from({ length: 12 }, (_, i) => `${prefix}-user-${i}`);
  const homeId = `${prefix}-home`;
  const awayId = `${prefix}-away`;
  const matchId = `${prefix}-played`;
  const scoutingId = `${prefix}-preview`;
  const gameId = `${prefix}-game`;
  const label = suffix.slice(0, 8);
  const homeName = `Cache Home ${label}`;
  const playerName = `Cache Record Holder ${label}`;
  const maxWeek = await db.match.aggregate({ where: { seasonId: season.id }, _max: { week: true } });
  const week = (maxWeek._max.week ?? 0) + 1;
  const settingKeys = [
    ...CHANGE_KEYS,
    `resultAnnounced:${matchId}`,
    `honorsAnnounced:${season.id}:${week}`,
  ];
  const savedSettings = await db.setting.findMany({ where: { key: { in: settingKeys } } });
  const players = userIds.slice(0, 10).map((userId, i) => ({
    userId, teamId: i < 5 ? homeId : awayId, accountId: null,
    heroId: i + 1, isRadiant: i < 5, kills: i === 0 ? 9999 : 5,
    deaths: 2, assists: 10, netWorth: 15000, gpm: 500, lastHits: 200,
  }));

  try {
    await db.$transaction(async (tx) => {
      await tx.user.createMany({ data: userIds.map((id, i) => ({
        id, steamId: i === 10 ? ADMIN_STEAM_ID : i === 11 ? VIEWER_STEAM_ID : `765611900009919${String(i).padStart(2, "0")}`,
        name: i === 0 ? playerName : `Cache fixture ${label} ${i}`,
        role: i === 10 ? "ADMIN" : "USER",
      })) });
      await tx.team.createMany({ data: [
        { id: homeId, seasonId: season.id, name: homeName, captainId: userIds[0] },
        { id: awayId, seasonId: season.id, name: `Cache Away ${label}`, captainId: userIds[5] },
      ] });
      await tx.teamMember.createMany({ data: players.map((p, i) => ({
        seasonId: season.id, teamId: p.teamId, userId: p.userId, isCaptain: i === 0 || i === 5,
      })) });
      await tx.registration.createMany({ data: players.map((p, i) => ({
        seasonId: season.id, userId: p.userId, roles: String(i % 5 + 1), mmr: 3000,
      })) });
      await tx.match.createMany({ data: [
        { id: matchId, seasonId: season.id, homeTeamId: homeId, awayTeamId: awayId,
          week, phase: "REGULAR", bestOf: 1, status: "COMPLETED", homeScore: 1,
          winnerTeamId: homeId },
        { id: scoutingId, seasonId: season.id, homeTeamId: homeId, awayTeamId: awayId,
          week: week + 1, phase: "REGULAR", bestOf: 1, status: "SCHEDULED" },
      ] });
      await tx.game.create({ data: {
        id: gameId, matchId, dotaMatchId: DOTA_MATCH_ID, radiantWin: true,
        // A clear fixture record proves the data was included before removal;
        // arbitrary seed/player ranking cannot make the negative checks pass.
        durationSecs: 18000, startTime: 1_790_000_000, radiantScore: 10019,
        direScore: 25, radiantTeamId: homeId, direTeamId: awayId,
        winnerTeamId: homeId, players: JSON.stringify(players),
      } });
    });
    await invalidateFixtureCache(request);
    await run({
      seasonId: season.id, seasonName: season.name, homeId, awayId, homeName,
      renamedHome: `Cache Renamed ${label}`, playerId: userIds[0], playerName,
      gameId, matchId, scoutingId,
    });
  } finally {
    await db.$transaction(async (tx) => {
      await tx.adminAction.deleteMany({ where: { actorId: { in: userIds } } });
      await tx.dotaMatchClaim.deleteMany({ where: { dotaMatchId: DOTA_MATCH_ID } });
      await tx.importSuppression.deleteMany({ where: { seasonId: season.id, dotaMatchId: DOTA_MATCH_ID } });
      await tx.importCandidate.deleteMany({ where: { seasonId: season.id, dotaMatchId: DOTA_MATCH_ID } });
      await tx.match.deleteMany({ where: { id: { in: [matchId, scoutingId] } } });
      await tx.team.deleteMany({ where: { id: { in: [homeId, awayId] } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      // removeGame deliberately backfills this durable lock if absent. Restore
      // precisely the fixture's previous value, without changing league phase.
      await tx.season.update({ where: { id: season.id }, data: { fantasyLockedAt: season.fantasyLockedAt } });
    });
    try {
      await invalidateFixtureCache(request);
    } finally {
      // The fixture endpoint also stamps both revision signals. Restore the
      // saved values AFTER expiry, so no suite-owned setting survives cleanup.
      await db.$transaction(async (tx) => {
        await tx.setting.deleteMany({ where: { key: { in: settingKeys } } });
        if (savedSettings.length) await tx.setting.createMany({ data: savedSettings });
      });
    }
  }
}

type PublicRead = { page: Page; html: string; text: string };

async function readTogether(context: BrowserContext, paths: Record<string, string>) {
  const pages: Page[] = [];
  try {
    const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => {
      const page = await context.newPage();
      pages.push(page);
      const noErrors = trackPageErrors(page);
      const response = await page.goto(path);
      expect(response?.ok(), `first response for ${path}`).toBe(true);
      // Save the ORIGINAL document stream, not a later router refresh. This
      // prevents SWR or auto-refresh from making a stale first read look green.
      const html = await response!.text();
      await expect(page.locator("#main h1").first()).toBeVisible();
      const text = await page.locator("#main").innerText();
      noErrors();
      return [key, { page, html, text }] as const;
    }));
    return Object.fromEntries(entries) as Record<string, PublicRead>;
  } catch (error) {
    await Promise.all(pages.map((page) => page.close()));
    throw error;
  }
}

async function closeReads(reads: Record<string, PublicRead>) {
  await Promise.all(Object.values(reads).map(({ page }) => page.close()));
}

async function originalMetaSample(read: PublicRead) {
  // Parse a detached copy of the first document without running its scripts.
  // The visible browser may already have received a ResultSyncPing refresh.
  return read.page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, "text/html");
    const label = [...document.querySelectorAll("p")].find((p) => p.textContent?.trim() === "eligible games");
    return label?.parentElement?.querySelector("p")?.textContent?.replace(/\s+/g, " ").trim() ?? null;
  }, read.html);
}

function playerLink(playerId: string) { return `href="/players/${playerId}"`; }

test("warm public statistics refresh on the first read after real admin corrections, including nested scouting", async ({ page, browser, request, baseURL }) => {
  test.setTimeout(120_000); // Initial dev compilation is outside the TTL proof.
  await withPublicFixture(request, async (fixture) => {
    const context = await browser.newContext({ baseURL }); // Always anonymous.
    try {
      const paths = {
        career: "/hall-of-fame",
        player: `/players/${fixture.playerId}`,
        records: "/records",
        seasonRecords: `/records?season=${fixture.seasonId}`,
        leaders: `/leaders?season=${fixture.seasonId}`,
        meta: `/meta?season=${fixture.seasonId}`,
        recap: `/recap?season=${fixture.seasonId}`,
        scouting: `/matches/${fixture.scoutingId}#match-scouting`,
      };
      await page.goto(`/api/auth/dev?name=Public+cache+admin&steamId=${ADMIN_STEAM_ID}&admin=1&redirect=/admin`);
      await expect(page.getByRole("heading", { name: "Admin", exact: true })).toBeVisible();
      const rename = page.locator("form").filter({ has: page.locator(`input[name="teamId"][value="${fixture.homeId}"]`) })
        .filter({ has: page.locator('input[name="name"]') });
      await rename.locator("xpath=ancestor::details[1]/summary").click();
      await rename.getByRole("textbox", { name: `Name for ${fixture.homeName}`, exact: true }).fill(fixture.renamedHome);

      // Compile every route first, then expire only the directly seeded fixture
      // cache. No cache test endpoint is called after either product mutation.
      await closeReads(await readTogether(context, paths));
      await invalidateFixtureCache(request);
      const warmedAt = Date.now();
      const warm = await readTogether(context, paths);
      for (const key of ["records", "seasonRecords"]) {
        expect(warm[key].html).toContain(`${fixture.playerName} set the kills mark at 9999.`);
        expect(warm[key].html).toContain(`${fixture.homeName} vs Cache Away`);
      }
      for (const key of ["career", "leaders", "recap"]) {
        expect(warm[key].html, `${key} includes the owned imported game before removal`).toContain(playerLink(fixture.playerId));
      }
      expect(warm.player.html).toContain(`href="/matches/${fixture.matchId}"`);
      const sample = /^(\d+)\s*\/\s*(\d+)$/.exec(await originalMetaSample(warm.meta) ?? "");
      expect(sample, "the season meta displays eligible and imported sample sizes").not.toBeNull();
      await expect(warm.scouting.page.getByRole("heading", { name: "Scouting report", exact: true })).toBeVisible();
      expect(warm.scouting.html).toContain("Scouting report");
      expect(warm.scouting.text).toContain(fixture.playerName);
      for (const { page: publicPage } of Object.values(warm)) {
        await expect(publicPage.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
        await expect(publicPage.getByRole("heading", { name: "Captain tools", exact: true })).toHaveCount(0);
      }
      await closeReads(warm);

      const beforeRename = await db.setting.findUnique({ where: { key: "publicGameRevision" } });
      await rename.getByRole("button", { name: "Save team", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: `Saved ${fixture.renamedHome}` })).toBeVisible();
      const afterRename = await db.setting.findUnique({ where: { key: "publicGameRevision" } });
      expect(afterRename?.value, "team identity commits a new public data revision").toBeTruthy();
      expect(afterRename?.value).not.toBe(beforeRename?.value);
      const renamed = await readTogether(context, { records: paths.records, seasonRecords: paths.seasonRecords, player: paths.player });
      for (const key of ["records", "seasonRecords"]) {
        expect(renamed[key].html).toContain(`${fixture.renamedHome} vs Cache Away`);
        expect(renamed[key].html).not.toContain(fixture.homeName);
      }
      expect(renamed.player.text).toContain(fixture.renamedHome);
      expect(Date.now() - warmedAt, "rename is visible before the warm 60-second cache TTL").toBeLessThan(60_000);
      await closeReads(renamed);

      const remove = page.locator("form").filter({ has: page.locator(`input[name="gameId"][value="${fixture.gameId}"]`) });
      // Completed weeks intentionally start collapsed in Admin. Open the
      // owned fixture's week through its real disclosure before correcting it.
      const resultWeek = remove.locator("xpath=ancestor::details[1]");
      if (await resultWeek.getAttribute("open") === null) {
        await resultWeek.locator(":scope > summary").click();
      }
      page.once("dialog", (dialog) => dialog.accept());
      await remove.getByRole("button", { name: "remove", exact: true }).click({ timeout: 10_000 });
      await expect(remove).toHaveCount(0);
      expect(await db.game.findUnique({ where: { id: fixture.gameId } })).toBeNull();
      const afterRemove = await db.setting.findUnique({ where: { key: "publicGameRevision" } });
      expect(afterRemove?.value, "game correction commits a new public data revision").toBeTruthy();
      expect(afterRemove?.value).not.toBe(afterRename?.value);
      const corrected = await readTogether(context, paths);
      for (const key of ["career", "records", "seasonRecords", "leaders", "recap"]) {
        expect(corrected[key].html, `${key} first response excludes the removed game's participant statistics`).not.toContain(playerLink(fixture.playerId));
      }
      expect(corrected.player.html).toContain("No games recorded yet");
      expect(corrected.player.text).not.toContain("9999");
      expect(await originalMetaSample(corrected.meta)).toBe(`${Number(sample![1]) - 1} / ${Number(sample![2]) - 1}`);
      await expect(corrected.scouting.page.getByRole("heading", { name: "Scouting report", exact: true })).toBeVisible();
      expect(corrected.scouting.html).toContain("No league history yet");
      expect(Date.now() - warmedAt, "all first reads reflect both corrections before the original 60-second TTL").toBeLessThan(60_000);
      await closeReads(corrected);

      // Warming an admin render must never put authorization into shared data.
      const anonymous = await context.newPage();
      await anonymous.goto("/admin");
      await expect(anonymous).toHaveURL(/\/login\?next=\/admin$/);
      await anonymous.goto(`/api/auth/dev?name=Public+cache+viewer&steamId=${VIEWER_STEAM_ID}&redirect=/admin`);
      await expect(anonymous.getByRole("heading", { name: "Admin access required", exact: true })).toBeVisible();
      await expect(anonymous.getByRole("button", { name: "Save team", exact: true })).toHaveCount(0);
      await expect(anonymous.getByRole("region", { name: "Saved import progress" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
