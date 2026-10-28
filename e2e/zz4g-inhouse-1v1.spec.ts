import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
} from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import path from "node:path";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
  untilHydrated,
} from "../e2e-mid/helpers";

// The 1v1 mid card on /inhouse, in a real browser at a phone's width. The e2e
// server has no lobby bot (playwright.config.ts sets no DOTA_LOBBY_BOT_URL or
// in-house ticket), and 1v1s are bot only: the card offers no Join and says
// why, and a join through the API is refused the same way. A 1v1 written
// straight to the database (a pair formed while a bot could host) shows as the
// joiner's own, with the panel's "can't host here" line and the setup clock;
// the joiner calls it off and the card says so. Then a recorded 1v1 shows on
// the 1v1 leaderboard and as the joiner's last result. Runs after the zz4
// specs (no live 5v5 game, an empty queue) and removes its own 1v1 rows, so
// the specs behind it see the room as it found it.

const BASE = "http://localhost:3210";
// Explicitly pinned to Playwright's disposable database, never an .env URL.
const db = new PrismaClient({
  datasources: { db: { url: `file:${path.resolve("prisma/e2e.db")}` } },
});

const WAITER = { name: "Duel Waiter", steamId: "76561190000009501" };
const JOINER = { name: "Duel Joiner", steamId: "76561190000009502" };

async function apiPlayer(name: string, steamId: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.get(
    `/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}&redirect=/inhouse`,
  );
  expect(res.ok()).toBe(true);
  return ctx;
}

async function act(
  ctx: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await ctx.post("/api/inhouse", {
    data: body,
    headers: { Origin: BASE },
  });
  return { ok: res.ok(), json: (await res.json()) as Record<string, unknown> };
}

async function userIds(): Promise<string[]> {
  const users = await db.user.findMany({
    where: { steamId: { in: [WAITER.steamId, JOINER.steamId] } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

async function removeOwnDuelRows() {
  const ids = await userIds();
  if (ids.length === 0) return;
  await db.inhouseDuel.deleteMany({
    where: { OR: [{ radiantUserId: { in: ids } }, { direUserId: { in: ids } }] },
  });
  await db.inhouseDuelQueueEntry.deleteMany({ where: { userId: { in: ids } } });
}

test.afterAll(async () => {
  await removeOwnDuelRows();
  // Every room instance rebuilds its snapshot without the rows just removed.
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  await ctx.post("/api/test/cache");
  await ctx.dispose();
  await db.$disconnect();
});

const NO_BOT = "1v1s start once the lobby bot can host here.";

test("with no lobby bot the 1v1 card offers no Join; a 1v1 is called off, and a recorded 1v1 tops the 1v1 board", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const assertNoPageErrors = trackPageErrors(page);
  // "Call it off" confirms.
  page.on("dialog", (d) => d.accept());
  await page.setViewportSize({ width: 390, height: 844 });

  // No bot: a join is refused in the card's own words.
  const waiter = await apiPlayer(WAITER.name, WAITER.steamId);
  const refused = await act(waiter, { action: "duelJoin" });
  expect(refused.ok).toBe(false);
  expect(refused.json.error).toBe(NO_BOT);
  expect(await db.inhouseDuelQueueEntry.count()).toBe(0);

  // The joiner opens /inhouse: the 1v1 card sits below the 5v5 room, with
  // the no-bot line in Join's place.
  await page.goto(
    `/api/auth/dev?name=${encodeURIComponent(JOINER.name)}&steamId=${JOINER.steamId}&redirect=/inhouse`,
  );
  const card = page.getByRole("region", { name: "1v1 mid", exact: true });
  await expect(card.getByRole("heading", { name: "1v1 mid", exact: true })).toBeVisible();
  await expect(card.getByText("Play a quick 1v1 Solo Mid.")).toBeVisible();
  await expect(card.getByText(NO_BOT)).toBeVisible();
  await expect(card.getByRole("button", { name: "Join 1v1", exact: true })).toHaveCount(0);

  // A pair formed while a bot could host, written straight to the database.
  const [joiner, waiterUser] = await Promise.all([
    db.user.findFirstOrThrow({ where: { steamId: JOINER.steamId }, select: { id: true } }),
    db.user.findFirstOrThrow({ where: { steamId: WAITER.steamId }, select: { id: true } }),
  ]);
  const paired = await db.inhouseDuel.create({
    data: { status: "READY", radiantUserId: joiner.id, direUserId: waiterUser.id },
    select: { id: true },
  });
  expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
  await page.goto("/inhouse");

  // The joiner's 1v1: the opponent, the panel's "can't host here" line (never
  // by-hand steps), and the setup clock.
  await expect(card.getByRole("heading", { name: "Your 1v1" })).toBeVisible();
  await expect(card.getByRole("link", { name: WAITER.name })).toBeVisible();
  await expect(card.getByText(/The lobby bot can't host 1v1s here right now\./)).toBeVisible();
  await expect(card.getByRole("timer", { name: /1v1 setup time/ })).toBeVisible();
  // The waiter's own room reply shows the same 1v1.
  const waiterState = await act(waiter, { action: "state" });
  const waiterDuel = waiterState.json.duel as { me: { duelId: string | null } };
  expect(waiterDuel.me.duelId).toBe(paired.id);
  await expectNoHorizontalOverflow(page, "/inhouse with a 1v1 at 390px");

  // The joiner calls it off: the 1v1 ends without a result, and the card
  // says what happened instead of the 1v1 just vanishing.
  const callOff = card.getByRole("button", { name: "Call it off" });
  await untilHydrated(page, callOff);
  await callOff.click();
  await expect(page.getByText("1v1 called off")).toBeVisible();
  await expect(card.getByText("Your 1v1 was called off.")).toBeVisible();
  await expect(card.getByRole("heading", { name: "Your 1v1" })).toHaveCount(0);
  const called = await db.inhouseDuel.findUnique({
    where: { id: paired.id },
    select: { status: true, endReason: true },
  });
  expect(called?.status).toBe("CANCELLED");
  expect(called?.endReason).toMatch(/^Called off by Duel Joiner/);

  // A recorded 1v1 (the joiner won as Radiant), written straight to the
  // database: the 1v1 leaderboard ranks it, and the joiner's card says so.
  const now = new Date();
  await db.inhouseDuel.create({
    data: {
      status: "COMPLETED",
      radiantUserId: joiner.id,
      direUserId: waiterUser.id,
      createdAt: new Date(now.getTime() - 15 * 60_000),
      startedAt: new Date(now.getTime() - 12 * 60_000),
      finishedAt: new Date(now.getTime() - 2 * 60_000),
      completedAt: now,
      winnerTeam: 1,
      dotaMatchId: "8990000951",
      durationSecs: 540,
    },
  });
  expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
  await page.goto("/inhouse");

  const board = page.getByRole("region", { name: "1v1 mid leaderboard" });
  await expect(
    board.getByRole("heading", { name: "1v1 mid leaderboard", exact: true }),
  ).toBeVisible();
  const rows = board.getByRole("row");
  // The header, then both players (provisional after one 1v1), winner first.
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText(JOINER.name);
  await expect(rows.nth(1)).toContainText("1,016");
  await expect(rows.nth(2)).toContainText(WAITER.name);
  // The newer result says more than the earlier call-off.
  await expect(card.getByText(`You beat ${WAITER.name}`)).toBeVisible();
  await expect(card.getByText("Your 1v1 was called off.")).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "/inhouse with the 1v1 board at 390px");

  assertNoPageErrors();
});
