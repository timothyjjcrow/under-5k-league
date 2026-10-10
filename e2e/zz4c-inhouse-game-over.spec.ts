import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import path from "node:path";

// "Game over — queue again" and positions, in a real browser: the observer
// picks positions beside Join, sees them in the draft with each side's
// missing positions, then marks the finished game over and is back in the
// queue while its result is still on the way — and a player from that game,
// refused the queue a moment before, can now join. An admin then gives up on
// the pending result. Runs after zz4/zz4b: it forms its own lobby.

const BASE = "http://localhost:3210";
// Explicitly pinned to Playwright's disposable database, never an .env URL.
const db = new PrismaClient({
  datasources: { db: { url: `file:${path.resolve("prisma/e2e.db")}` } },
});

async function apiPlayer(
  name: string,
  steamId: string,
  admin = false,
): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.get(
    `/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}${admin ? "&admin=1" : ""}&redirect=/inhouse`,
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
  return { ok: res.ok(), json: await res.json() };
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

test("positions in the draft, then Game over frees the ten before the result lands", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const errors = trackPageErrors(page);
  // "Game over" and the admin give-up both confirm.
  page.on("dialog", (d) => d.accept());

  // Nine API players with known positions. The two highest MMRs captain:
  // team 1 plays Pos 4/5 only, and team 2 (which picks first) plays Pos 1
  // only, so team 2's missing positions are 2, 3, 4 and 5.
  const roles = [
    ["4", "5"],
    ["1"],
    ["2"],
    ["3"],
    ["4"],
    ["5"],
    ["2", "3"],
    ["1", "3"],
    [],
  ];
  const players: APIRequestContext[] = [];
  for (let i = 0; i < 9; i++) {
    const ctx = await apiPlayer(`GO Player ${i}`, `7656119000000310${i}`);
    players.push(ctx);
    const joined = await act(ctx, {
      action: "join",
      mmr: 5000 - i * 100,
      roles: roles[i],
    });
    expect(joined.ok).toBe(true);
  }

  // The observer picks positions beside Join (toggles with real names), most
  // wanted first: Offlane, then Mid. The join saves them in that order.
  await page.goto(
    "/api/auth/dev?name=GO+Observer&steamId=76561190000003099&redirect=/inhouse",
  );
  const pos2 = page.getByRole("button", { name: /^Pos 2 · Mid/ });
  await expect(pos2).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: /^Pos 3 · Offlane/ }).click();
  await pos2.click();
  await expect(pos2).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Pos 2 · Mid, choice 2" }),
  ).toBeVisible();
  await expect(page.getByText("Offlane first, then Mid")).toBeVisible();
  await page.getByLabel("MMR").fill("1500");
  await page.getByRole("button", { name: /Join queue/ }).click();

  // The tenth join formed the lobby. Everyone accepts and votes MMR.
  await expect(page.getByText("Match found. You in?")).toBeVisible();
  await page.getByRole("button", { name: "ACCEPT MATCH" }).click();
  for (const ctx of players) {
    expect((await act(ctx, { action: "accept" })).ok).toBe(true);
  }
  await expect(page.getByText("Choose your captains")).toBeVisible();
  await page.getByRole("button", { name: /Highest MMR/ }).click();
  for (const ctx of players) {
    expect((await act(ctx, { action: "vote", method: "MMR" })).ok).toBe(true);
  }

  // The draft: every side says what it still lacks, and the pool marks who
  // would fill a gap for the team on the clock.
  await expect(page.getByText(/Draft pool/)).toBeVisible();
  await expect(page.getByText("Needs", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^fills Pos /).first()).toBeVisible();
  // The observer's saved positions are what captains see.
  const me = await act(players[0], { action: "state" });
  type PoolPlayer = { userId: string; name: string; roles: string };
  const pool = (me.json.lobby as { pool: PoolPlayer[] }).pool;
  expect(pool.find((p) => p.name === "GO Observer")?.roles).toBe("3,2");

  // An admin drives the picks to READY (the last pool player auto-assigns).
  const admin = await apiPlayer("GO Admin", "76561190000003098", true);
  for (let guard = 0; guard < 12; guard++) {
    const s = await act(admin, { action: "state" });
    type Game = { id: string; status: string; pool: { userId: string }[] };
    const l = (s.json.otherLobbies as Game[])[0];
    if (!l || l.status !== "DRAFTING") break;
    expect(
      (await act(admin, { action: "pick", userId: l.pool[0].userId, lobbyId: l.id }))
        .ok,
    ).toBe(true);
  }
  await expect(page.getByText("Teams are set!")).toBeVisible();

  // Teams just locked: too early for "Game over" (the result scan's window is
  // shut), and a player in the game can't queue.
  await expect(
    page.getByRole("button", { name: "Game over — queue again" }),
  ).toHaveCount(0);
  const refused = await act(players[2], { action: "join", mmr: 0 });
  expect(refused.ok).toBe(false);
  expect(refused.json.error).toMatch(/already in a live inhouse/);

  // The game has been going a while: open the scan window as time would.
  const live = await act(players[2], { action: "state" });
  const lobbyId = (live.json.lobby as { id: string }).id;
  await db.inhouseLobby.update({
    where: { id: lobbyId },
    data: { createdAt: new Date(Date.now() - 20 * 60_000) },
  });
  await page.reload();
  await page.setViewportSize({ width: 375, height: 812 });

  // Game over: the observer is back in the queue at once, and the game sits
  // on one folded line while OpenDota publishes it (its checks wait until
  // they're out of the queue: a ready check can open any second).
  await page.getByRole("button", { name: "Game over — queue again" }).click();
  await expect(page.getByText("You’re queued")).toBeVisible();
  await expect(page.getByText(/result on the way/i).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check OpenDota now" }),
  ).toHaveCount(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // A player from that game, refused a moment ago, joins now; the slot is
  // free and the game is pending, not live.
  const rejoined = await act(players[2], { action: "join", mmr: 0 });
  expect(rejoined.ok).toBe(true);
  expect(rejoined.json.liveGames).toBe(0);
  const pending = rejoined.json.pendingResults as { id: string }[];
  expect(pending.map((p) => p.id)).toEqual([lobbyId]);

  // Out of the queue, the observer gets the card's own checks back.
  await page.getByRole("button", { name: /Leave queue/ }).click();
  await expect(page.getByText("You’re queued")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Check OpenDota now" }),
  ).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // An admin gives up on the result from the same card; nobody is requeued
  // by it (only the two who joined themselves are queued).
  const adminPage = await (await browser.newContext({ baseURL: BASE })).newPage();
  const adminErrors = trackPageErrors(adminPage);
  adminPage.on("dialog", (d) => d.accept());
  await adminPage.goto(
    "/api/auth/dev?name=GO+Admin+UI&steamId=76561190000003097&admin=1&redirect=/inhouse",
  );
  await adminPage
    .getByRole("button", { name: /^Admin: give up on #\d+'s result$/ })
    .click();
  await expect(adminPage.getByText("Result on the way")).toHaveCount(0);
  const row = await db.inhouseLobby.findUniqueOrThrow({
    where: { id: lobbyId },
    select: { status: true, endReason: true, finishedAt: true },
  });
  expect(row.status).toBe("CANCELLED");
  expect(row.endReason).toMatch(/while waiting for the result/);
  expect(row.finishedAt).not.toBeNull();

  // The observer's card goes with it on their next poll (the idle rate, 10s).
  await expect(
    page.getByRole("button", { name: "Check OpenDota now" }),
  ).toHaveCount(0, { timeout: 20_000 });

  // Clean up the queue for the specs after this one.
  await act(players[2], { action: "leave" });

  expect(errors).toEqual([]);
  expect(adminErrors).toEqual([]);
  for (const ctx of players) await ctx.dispose();
  await admin.dispose();
  await adminPage.context().close();
  await db.$disconnect();
});
