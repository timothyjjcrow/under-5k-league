import {
  expect,
  request as pwRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import path from "node:path";

// An inhouse ban in a real browser (Tim, 2026-11-02): an admin bans a queued
// player from their row on /admin/inhouse-players, the player is out of the
// queue and refused a join, /inhouse lists the ban with its reason (on a
// phone, nothing scrolling sideways), and the admin lifts it from the bans
// card so the player can queue again. The ban is lifted and the player out
// of the queue at the end, so the inhouse specs after this one start from
// the queue they expect.

const BASE = "http://localhost:3210";
// Explicitly pinned to Playwright's disposable database, never an .env URL.
const db = new PrismaClient({
  datasources: { db: { url: `file:${path.resolve("prisma/e2e.db")}` } },
});

const NAME = "Ban E2E Griefer";
const STEAM_ID = "76561198077000456";
const REASON = "Leaving games on purpose";

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
  return (await res.json()) as { error?: string };
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("an admin bans a queued player, /inhouse lists it, and a lift lets them back in", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  // The ban and the lift ask for a browser confirm.
  page.on("dialog", (d) => d.accept());
  const player = await apiPlayer();
  try {
    const user = await db.user.update({
      where: { steamId: STEAM_ID },
      data: { rankTier: 45, rankTierManual: false, inhouseMmr: null },
    });
    expect((await act(player, { action: "join", mmr: 3000 })).error).toBeUndefined();

    await page.goto(
      `/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=${encodeURIComponent(`/admin/inhouse-players?q=${NAME}`)}`,
    );
    await expect(page.getByRole("heading", { name: "Inhouse bans", exact: true })).toBeVisible();
    await expect(page.getByText("Nobody is banned.", { exact: true })).toBeVisible();
    const row = page.locator(`[data-inhouse-player="${user.id}"]`);
    await row.locator("[data-inhouse-ban-editor] summary").click();
    await row.getByLabel(`Ban length for ${NAME}`, { exact: true }).selectOption("3d");
    await row.getByLabel(`Ban reason for ${NAME}`, { exact: true }).fill(REASON);
    await row.getByRole("button", { name: "Ban from inhouse", exact: true }).click();
    await expect(page.getByText(`${NAME} is banned from inhouse until`)).toBeVisible();
    await expect(page.getByText("They're out of the queue.").first()).toBeVisible();

    await expect
      .poll(async () => db.inhouseQueueEntry.count({ where: { userId: user.id } }))
      .toBe(0);
    const ban = await db.inhouseBan.findFirstOrThrow({ where: { userId: user.id, liftedAt: null } });
    expect(ban.reason).toBe(REASON);
    expect(ban.endsAt!.getTime() - ban.createdAt.getTime()).toBe(3 * 86_400_000);
    expect((await act(player, { action: "join", mmr: 3000 })).error).toMatch(
      /^You're banned from inhouse games until .+\. Reason: Leaving games on purpose$/,
    );

    // Everyone sees it on /inhouse, on a phone, nothing scrolling sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/inhouse");
    const card = page.getByRole("region", { name: "Banned from inhouse" });
    await expect(card).toBeVisible();
    await expect(card.getByText(NAME, { exact: true })).toBeVisible();
    await expect(card.getByText(REASON, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);

    // The admin lifts it from the bans card; the player can queue again.
    await page.goto("/admin/inhouse-players");
    const listed = page.locator(`[data-inhouse-ban="${ban.id}"]`);
    await expect(listed).toContainText(REASON);
    await listed.getByRole("button", { name: "Lift ban", exact: true }).click();
    await expect(page.getByText(`${NAME}'s inhouse ban is lifted: they can queue again.`)).toBeVisible();
    await expect(page.getByText("Nobody is banned.", { exact: true })).toBeVisible();
    expect((await act(player, { action: "join", mmr: 3000 })).error).toBeUndefined();
    await page.goto("/inhouse");
    await expect(page.getByRole("region", { name: "Banned from inhouse" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await db.inhouseBan.updateMany({
      where: { user: { steamId: STEAM_ID }, liftedAt: null },
      data: { liftedAt: new Date() },
    });
    await act(player, { action: "leave" });
    await player.dispose();
    await db.$disconnect();
  }
});
