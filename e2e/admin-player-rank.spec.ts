import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import path from "node:path";

// These fixtures use the same disposable database as playwright.config.ts.
// Never inherit DATABASE_URL from a developer's shell or .env file.
const db = new PrismaClient({
  datasources: { db: { url: `file:${path.resolve("prisma/e2e.db")}` } },
});

async function openEditor(page: Page, name: string) {
  const editor = page
    .getByLabel(`MMR for ${name}`, { exact: true })
    .locator("xpath=ancestor::details[1]");
  await editor.locator("summary").click();
  await expect(page.getByLabel(`MMR for ${name}`, { exact: true })).toBeVisible();
  return editor;
}

async function saveRank(
  page: Page,
  player: { id: string; name: string; registrationId: string },
  mmr: number,
  rankTier: number,
) {
  const editor = await openEditor(page, player.name);
  await editor.getByLabel(`MMR for ${player.name}`, { exact: true }).fill(String(mmr));
  await editor
    .getByLabel(`Medal source for ${player.name}`, { exact: true })
    .selectOption("manual");
  await editor
    .getByLabel(`Medal for ${player.name}`, { exact: true })
    .selectOption(String(rankTier));
  await editor.getByRole("button", { name: "Save medal & MMR", exact: true }).click();
  await expect.poll(async () => {
    const registration = await db.registration.findUniqueOrThrow({
      where: { id: player.registrationId },
      include: { user: true },
    });
    return {
      mmr: registration.mmr,
      rankTier: registration.user.rankTier,
      manual: registration.user.rankTierManual,
    };
  }).toEqual({ mmr, rankTier: rankTier || null, manual: true });
}

for (const viewport of [
  { label: "desktop", width: 1440, height: 1000 },
  { label: "mobile", width: 375, height: 812 },
]) {
  test(`${viewport.label}: admin medal and MMR corrections reach public players before and after the draft`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const season = await db.season.findFirstOrThrow({ where: { isActive: true } });
    const originalDraft = await db.draft.findUnique({ where: { seasonId: season.id } });
    const prefix = `e2e-rank-${viewport.label}-`;
    const players = [];
    const publicContext = await browser.newContext({ viewport });
    const publicPage = await publicContext.newPage();
    try {
      // The test restores these phase fields in finally, so the rest of the
      // signup suite can still carry its shared seed into draft-night tests.
      await db.season.update({ where: { id: season.id }, data: { status: "SIGNUPS" } });
      if (originalDraft) {
        await db.draft.update({ where: { id: originalDraft.id }, data: { status: "NOT_STARTED" } });
      }
      for (const [index, kind] of ["Captain", "Player", "Standin"].entries()) {
        const id = `${prefix}${kind.toLowerCase()}`;
        const name = `Rank ${viewport.label} ${kind}`;
        const user = await db.user.create({
          data: {
            id,
            name,
            steamId: `76561190000009${viewport.label === "desktop" ? "7" : "8"}0${index}`,
            rankTier: 31,
            rankTierManual: false,
          },
        });
        const registration = await db.registration.create({
          data: {
            id: `${id}-registration`,
            userId: user.id,
            seasonId: season.id,
            mmr: 2300,
            type: kind === "Standin" ? "STANDIN" : "PLAYER",
            wantsCaptain: kind === "Captain",
          },
        });
        players.push({ id, name, registrationId: registration.id });
      }
      const [captain, player, standin] = players;
      const team = await db.team.create({
        data: {
          id: `${prefix}team`,
          name: `Rank ${viewport.label} Team`,
          seasonId: season.id,
          captainId: captain.id,
          members: {
            create: { seasonId: season.id, userId: captain.id, isCaptain: true },
          },
        },
      });
      await page.goto(
        "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/admin",
      );
      await expect(page.getByRole("heading", { name: "Admin", exact: true })).toBeVisible();

      // Every registration type offers the same correction path in Players.
      await saveRank(page, captain, 4600, 54);
      await page.reload();
      await saveRank(page, player, 4800, 11);
      await page.reload();
      await saveRank(page, standin, 4100, 43);
      await page.reload();
      const persisted = await openEditor(page, player.name);
      await expect(persisted.getByLabel(`MMR for ${player.name}`, { exact: true })).toHaveValue("4800");
      await expect(persisted.getByLabel(`Medal for ${player.name}`, { exact: true })).toHaveValue("11");
      await expect(persisted.getByLabel(`Medal source for ${player.name}`, { exact: true })).toHaveValue("manual");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await persisted.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`admin-rank-${viewport.label}.png`) });

      const publicUrl = new URL("/players", page.url()).href;
      await publicPage.goto(publicUrl);
      const publicPlayer = publicPage.locator("li").filter({ has: publicPage.getByRole("link", { name: player.name, exact: true }) });
      await expect(publicPlayer.getByText("4800", { exact: true })).toBeVisible();
      await expect(publicPlayer.getByLabel("Herald 1", { exact: true })).toBeVisible();
      const publicStandin = publicPage.getByRole("link", { name: new RegExp(standin.name) });
      await expect(publicStandin.getByText("4100", { exact: true })).toBeVisible();
      await expect(publicStandin.getByLabel("Archon 3", { exact: true })).toBeVisible();

      await db.teamMember.create({
        data: { seasonId: season.id, teamId: team.id, userId: player.id, price: 1 },
      });
      await db.draft.upsert({
        where: { seasonId: season.id },
        create: { seasonId: season.id, status: "COMPLETE" },
        update: { status: "COMPLETE" },
      });
      await db.season.update({ where: { id: season.id }, data: { status: "REGULAR_SEASON" } });
      expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
      await page.goto("/admin");
      await saveRank(page, player, 4700, 64);
      await page.reload();
      const postdraftCaptain = await openEditor(page, captain.name);
      await expect(postdraftCaptain.getByLabel(`MMR for ${captain.name}`, { exact: true })).toHaveValue("4600");
      const postdraftStandin = await openEditor(page, standin.name);
      await expect(postdraftStandin.getByLabel(`MMR for ${standin.name}`, { exact: true })).toHaveValue("4100");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      await publicPage.goto(new URL(`/players/${player.id}`, publicUrl).href);
      await expect(publicPage.getByRole("heading", { name: player.name, exact: true })).toBeVisible();
      await expect(publicPage.getByText("4700", { exact: true })).toBeVisible();
      await expect(publicPage.getByLabel("Ancient 4", { exact: true }).first()).toBeVisible();
      await publicPage.goto(publicUrl);
      const rosterRow = publicPage
        .locator("section")
        .filter({ has: publicPage.getByRole("heading", { name: /^Rosters/ }) })
        .getByRole("link", { name: player.name, exact: true })
        .locator("..");
      await expect(rosterRow.getByLabel("Ancient 4", { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await publicContext.close();
      await db.team.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.adminAction.deleteMany({
        where: { action: "setPlayerRank", summary: { contains: `Rank ${viewport.label}` } },
      });
      await db.season.update({ where: { id: season.id }, data: { status: season.status } });
      if (originalDraft) {
        await db.draft.update({ where: { id: originalDraft.id }, data: { status: originalDraft.status } });
      } else {
        await db.draft.deleteMany({ where: { seasonId: season.id } });
      }
      await page.request.post("/api/test/cache");
    }
  });
}

test.afterAll(async () => {
  await db.$disconnect();
});
