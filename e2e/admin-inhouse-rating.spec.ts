import {
  expect,
  request as pwRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import path from "node:path";

// An admin's inhouse MMR and medal for a player who never signed up for the
// league (Tim, 2026-10-17), in a real browser: a stale Divine medal keeps
// them out of the queue, an admin corrects both on /admin/inhouse-players,
// and the player then joins at the admin's number, whatever they type. The
// player leaves the queue at the end, so the inhouse specs after this one
// start from the queue they expect.

const BASE = "http://localhost:3210";
// Explicitly pinned to Playwright's disposable database, never an .env URL.
const db = new PrismaClient({
  datasources: { db: { url: `file:${path.resolve("prisma/e2e.db")}` } },
});

const NAME = "Rating E2E Smurf";
const STEAM_ID = "76561198077000123";

async function apiPlayer(): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.get(
    `/api/auth/dev?name=${encodeURIComponent(NAME)}&steamId=${STEAM_ID}&redirect=/inhouse`,
  );
  expect(res.ok()).toBe(true);
  return ctx;
}

async function act(ctx: APIRequestContext, body: Record<string, unknown>) {
  const res = await ctx.post("/api/inhouse", { data: body, headers: { Origin: BASE } });
  return (await res.json()) as { error?: string; queue?: unknown[] };
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("an admin sets a never-signed-up player's medal and inhouse MMR, and the queue uses them", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const player = await apiPlayer();
  try {
    // OpenDota's medal says Divine 5, which the inhouse cap turns away.
    const user = await db.user.update({
      where: { steamId: STEAM_ID },
      data: { rankTier: 75, rankTierManual: false, inhouseMmr: null },
    });
    expect(await db.registration.count({ where: { userId: user.id } })).toBe(0);
    expect((await act(player, { action: "join", mmr: 3000 })).error).toMatch(
      /your Divine 5 medal puts you above it/,
    );

    await page.goto(
      `/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=${encodeURIComponent(`/admin/inhouse-players?q=${NAME}`)}`,
    );
    await expect(page.getByRole("heading", { name: "Inhouse players", exact: true })).toBeVisible();
    const row = page.locator(`[data-inhouse-player="${user.id}"]`);
    await expect(row.getByLabel("Divine 5", { exact: true })).toBeVisible();
    await expect(row.getByText("over the inhouse cap", { exact: true })).toBeVisible();

    await row.locator("summary").click();
    await row.getByLabel(`Inhouse MMR for ${NAME}`, { exact: true }).fill("4200");
    await row.getByLabel(`Medal source for ${NAME}`, { exact: true }).selectOption("manual");
    await row.getByLabel(`Medal for ${NAME}`, { exact: true }).selectOption("62");
    await row.getByRole("button", { name: "Save medal & MMR", exact: true }).click();
    await expect(
      page.getByText(`${NAME}: inhouse MMR 4,200 from their next join · Ancient 2 medal (manual).`),
    ).toBeVisible();
    await expect
      .poll(async () =>
        db.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { inhouseMmr: true, rankTier: true, rankTierManual: true },
        }),
      )
      .toEqual({ inhouseMmr: 4200, rankTier: 62, rankTierManual: true });

    // The player is in now, at the admin's number rather than the typed one.
    expect((await act(player, { action: "join", mmr: 2500 })).error).toBeUndefined();
    await expect
      .poll(async () => (await db.inhouseQueueEntry.findUnique({ where: { userId: user.id } }))?.mmr)
      .toBe(4200);

    // The list shows them queued at it, on a phone with nothing scrolling sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin/inhouse-players");
    // Each player is listed once: the queue comes first.
    const queuedRow = page.locator(`[data-inhouse-player="${user.id}"]`);
    await expect(queuedRow.getByText("4,200", { exact: true })).toBeVisible();
    await expect(queuedRow).toContainText("MMR, set by an admin · queued at 4,200");
    // The row's own medal; the folded editor previews the same one.
    await expect(queuedRow.getByLabel("Ancient 2", { exact: true }).first()).toBeVisible();
    await expect(queuedRow.getByText("manual medal", { exact: true })).toBeVisible();
    await queuedRow.locator("summary").click();
    await expect(queuedRow.getByLabel(`Inhouse MMR for ${NAME}`, { exact: true })).toHaveValue("4200");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await act(player, { action: "leave" });
    await player.dispose();
    await db.$disconnect();
  }
});
