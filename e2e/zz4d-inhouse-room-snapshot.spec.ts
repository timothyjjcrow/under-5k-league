import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { trackPageErrors } from "../e2e-mid/helpers";

// The room snapshot (inhouse-room-cache.ts) seen from the browser: the server
// answers room polls from a per-instance copy of the room while the room
// version stands, and every change publishes a new version before its
// response. So nothing a player sees may ever go backwards:
//
// - after each pick, the drafted player never reappears in any tab's pool
//   (two captains and a queued player watching), over at least five polls;
// - a captain who picked never gets "(!) Your pick" back in the tab title
//   until their next turn;
// - the other captain's first poll after the pick shows it;
// - the ready check's accepted count never goes down in any tab;
// - after an admin cancel, a requeued player's own tab shows them present on
//   its next poll.
//
// Runs after zz4c (which leaves no live game and an empty queue) and cleans
// up after itself for zz5.

const BASE = "http://localhost:3210";
const TITLE_FLAG = "(!) Your pick";

type Json = Record<string, unknown>;
type PlayerView = { userId: string; name: string };
type LobbyView = {
  id: string;
  status: string;
  pickTeam: number | null;
  pool: PlayerView[];
  readyCheck: { acceptedCount: number } | null;
};
type StateView = {
  lobby: LobbyView | null;
  otherLobbies: LobbyView[];
  queue: { userId: string; away: boolean }[];
  me: { userId: string | null; inQueue: boolean; isOnClock: boolean };
};

/** One /api/inhouse reply a tab received, by when its request started. */
type Reply = { start: number; action: string; body: Json; state: StateView };

/** Dev-login a fresh user and return an authed API context. */
async function apiPlayer(name: string, steamId: string, admin = false): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.get(
    `/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}${admin ? "&admin=1" : ""}&redirect=/inhouse`,
  );
  expect(res.ok()).toBe(true);
  return ctx;
}

async function act(ctx: APIRequestContext, body: Json): Promise<{ ok: boolean; json: Json }> {
  const res = await ctx.post("/api/inhouse", { data: body, headers: { Origin: BASE } });
  return { ok: res.ok(), json: await res.json() };
}

/** Every room reply this tab receives, and every tab title it shows. */
async function watchedTab(browser: Browser, name: string, steamId: string) {
  const context = await browser.newContext({ baseURL: BASE });
  // The tab title, sampled in the page (a title that flips back and forth
  // between two polls is still caught at this rate).
  await context.addInitScript(() => {
    const w = window as unknown as { __titles: [number, string][] };
    w.__titles = [];
    let last = "";
    setInterval(() => {
      if (document.title !== last) {
        last = document.title;
        w.__titles.push([Date.now(), last]);
      }
    }, 25);
  });
  const page = await context.newPage();
  const errors = trackPageErrors(page);
  const replies: Reply[] = [];
  page.on("response", async (res) => {
    const req = res.request();
    if (req.method() !== "POST" || !res.url().endsWith("/api/inhouse")) return;
    let body: Json;
    try {
      body = JSON.parse(req.postData() ?? "{}") as Json;
    } catch {
      return;
    }
    try {
      if (!res.ok()) return;
      const state = (await res.json()) as StateView;
      replies.push({ start: req.timing().startTime, action: String(body.action ?? ""), body, state });
    } catch {
      // The page navigated away mid-response.
    }
  });
  await page.goto(`/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}&redirect=/inhouse`);
  await expect(page.getByRole("progressbar").first()).toBeVisible();
  return { page, context, errors, replies, request: context.request };
}
type Tab = Awaited<ReturnType<typeof watchedTab>>;

/** The game a reply shows (the viewer's own, or the one they watch). */
const gameIn = (s: StateView, id: string) =>
  [s.lobby, ...s.otherLobbies].find((l) => l?.id === id) ?? null;

/** Polls (not actions) this tab started after `t`. */
const pollsAfter = (tab: Tab, t: number) =>
  tab.replies.filter((r) => r.action === "state" && r.start > t);

/**
 * Publish a new room version with nothing changed (the fixture fence
 * publishes). The tabs long-poll: each held request answers on a publish,
 * so this makes every tab poll once, and lets the checks below count polls.
 * Spaced past the room's 1s gap between requests.
 */
async function nudge(ctx: APIRequestContext) {
  expect((await ctx.post("/api/test/cache")).ok()).toBe(true);
}
/** Until every tab has `n` polls started after `t`, nudging between looks. */
async function pollsEach(ctx: APIRequestContext, tabs: Tab[], t: number, n: number) {
  for (const tab of tabs) {
    await expect
      .poll(
        async () => {
          if (pollsAfter(tab, t).length < n) await nudge(ctx);
          return pollsAfter(tab, t).length;
        },
        { timeout: 30_000, intervals: [1_250] },
      )
      .toBeGreaterThanOrEqual(n);
  }
}

async function titlesAfter(page: Page, t: number): Promise<string[]> {
  const all = await page.evaluate(
    () => (window as unknown as { __titles: [number, string][] }).__titles,
  );
  return all.filter(([at]) => at > t).map(([, title]) => title);
}

test("the room never goes backwards: picks, titles, accepts and a requeue", async ({ browser }) => {
  test.setTimeout(300_000);

  // Two captains (the two highest MMRs) and a queued player who watches, in
  // real tabs; eight more players through the API.
  const capA = await watchedTab(browser, "SN Captain A", "76561190000006000");
  const capB = await watchedTab(browser, "SN Captain B", "76561190000006001");
  const watcher = await watchedTab(browser, "SN Watcher", "76561190000006002");
  const tabs = [capA, capB, watcher];
  const others: APIRequestContext[] = [];
  for (let i = 0; i < 8; i++) {
    others.push(await apiPlayer(`SN Player ${i}`, `7656119000000601${i}`));
  }
  const admin = await apiPlayer("SN Admin", "76561190000006099", true);

  for (const [i, ctx] of others.entries()) {
    expect((await act(ctx, { action: "join", mmr: 4000 - i * 50 })).ok).toBe(true);
  }
  expect((await act(capB.request, { action: "join", mmr: 4900 })).ok).toBe(true);
  expect((await act(capA.request, { action: "join", mmr: 4950 })).ok).toBe(true);
  // The ten form a game; the watcher queues for the next one.
  const formed = await act(capA.request, { action: "state" });
  const lobbyId = (formed.json.lobby as LobbyView).id;
  expect((formed.json.lobby as LobbyView).status).toBe("READY_CHECK");
  expect((await act(watcher.request, { action: "join", mmr: 3000 })).ok).toBe(true);
  // The tabs joined through the API, so each still holds the empty queue it
  // loaded (a spectator's slow rate): load the room as it is now.
  for (const tab of tabs) {
    await tab.page.reload();
    await expect
      .poll(() => tab.replies.some((r) => gameIn(r.state, lobbyId)?.status === "READY_CHECK"), {
        timeout: 15_000,
      })
      .toBe(true);
  }

  // ---- the ready check: the count only ever goes up, in every tab ---------
  const accepted = (tab: Tab) => {
    const seen = tab.replies
      .map((r) => gameIn(r.state, lobbyId))
      .filter((l): l is LobbyView => l?.status === "READY_CHECK" && !!l.readyCheck);
    return seen.length ? seen[seen.length - 1].readyCheck!.acceptedCount : 0;
  };
  const accepters = [...others, capB.request, capA.request];
  for (const [k, ctx] of accepters.entries()) {
    expect((await act(ctx, { action: "accept", lobbyId })).ok).toBe(true);
    if (k < accepters.length - 1) {
      // Every tab polls past this accept before the next one lands.
      for (const tab of tabs) {
        await expect.poll(() => accepted(tab), { timeout: 15_000 }).toBeGreaterThanOrEqual(k + 1);
      }
    }
  }
  for (const tab of tabs) {
    const counts = [...tab.replies]
      .sort((a, b) => a.start - b.start)
      .map((r) => gameIn(r.state, lobbyId))
      .filter((l): l is LobbyView => l?.status === "READY_CHECK" && !!l.readyCheck)
      .map((l) => l.readyCheck!.acceptedCount);
    expect(counts.length).toBeGreaterThan(5);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i], `accepted count went down: ${counts.join(",")}`).toBeGreaterThanOrEqual(
        counts[i - 1],
      );
    }
  }

  // ---- the captain vote: everyone backs the two highest MMRs --------------
  for (const ctx of accepters) {
    expect((await act(ctx, { action: "vote", method: "MMR", lobbyId })).ok).toBe(true);
  }
  await expect(capA.page.getByText(/Draft pool/)).toBeVisible({ timeout: 15_000 });

  // ---- the draft ------------------------------------------------------------
  const captainTab = async (pickTeam: number) => {
    for (const tab of [capA, capB]) {
      const s = (await act(tab.request, { action: "state" })).json as StateView;
      if (s.me.isOnClock && s.lobby?.pickTeam === pickTeam) return tab;
    }
    return null;
  };
  let picks = 0;
  const picked = new Set<Reply>();
  for (let guard = 0; guard < 12; guard++) {
    const now = (await act(admin, { action: "state" })).json as StateView;
    const game = gameIn(now, lobbyId);
    if (!game || game.status !== "DRAFTING" || game.pickTeam == null) break;
    const picker = await captainTab(game.pickTeam);
    expect(picker, "a captain is on the clock").not.toBeNull();
    const other = picker === capA ? capB : capA;

    // The picker's tab shows its turn, then the captain drafts through it.
    await expect(picker!.page.getByText("Your pick").first()).toBeVisible({ timeout: 15_000 });
    await picker!.page.getByRole("button", { name: /^Select .* to draft$/ }).first().click();
    const draftButton = picker!.page.getByRole("button", { name: /^Draft / });
    await draftButton.click();
    await expect(draftButton).toHaveCount(0);
    await expect
      .poll(() => picker!.replies.some((r) => r.action === "pick" && !picked.has(r)), { timeout: 15_000 })
      .toBe(true);
    const pickedAt = Date.now();
    const pickReply = picker!.replies.find((r) => r.action === "pick" && !picked.has(r))!;
    picked.add(pickReply);
    const draftedId = String(pickReply.body.userId ?? "");
    expect(draftedId).not.toBe("");
    expect(gameIn(pickReply.state, lobbyId)?.pool.map((p) => p.userId) ?? []).not.toContain(draftedId);
    picks += 1;
    const stillOnClock = pickReply.state.me.isOnClock;

    // The other captain's first poll that starts after the pick shows it.
    await pollsEach(admin, [other], pickedAt, 1);
    const first = gameIn(pollsAfter(other, pickedAt)[0].state, lobbyId);
    if (first?.status === "DRAFTING") {
      expect(first.pool.map((p) => p.userId)).not.toContain(draftedId);
    }

    // Five polls in every tab: the drafted player never comes back.
    await pollsEach(admin, tabs, pickedAt, 5);
    for (const tab of tabs) {
      for (const reply of pollsAfter(tab, pickedAt)) {
        const seen = gameIn(reply.state, lobbyId);
        expect(seen?.pool.map((p) => p.userId) ?? []).not.toContain(draftedId);
      }
    }
    // And the picker's title never asks for the pick again until their
    // next turn.
    if (!stillOnClock) {
      const flagged = (await titlesAfter(picker!.page, pickedAt)).filter((t) => t.includes(TITLE_FLAG));
      expect(flagged).toEqual([]);
    }
  }
  expect(picks).toBeGreaterThanOrEqual(6);
  await expect(capA.page.getByText("Teams are set!")).toBeVisible({ timeout: 15_000 });

  // ---- an admin cancel: a requeued player is present on their next poll ----
  const cancelled = await act(admin, { action: "cancel", lobbyId });
  expect(cancelled.ok).toBe(true);
  const cancelledAt = Date.now();
  await pollsEach(admin, [capA], cancelledAt, 1);
  const back = pollsAfter(capA, cancelledAt)[0].state;
  expect(back.me.inQueue).toBe(true);
  expect(back.queue.find((q) => q.userId === back.me.userId)?.away).toBe(false);

  // Clean up the queue for the specs after this one.
  for (const ctx of [...others, capA.request, capB.request, watcher.request]) {
    await act(ctx, { action: "leave" });
  }
  for (const tab of tabs) tab.errors();
  for (const ctx of [...others, admin]) await ctx.dispose();
  for (const tab of tabs) await tab.context.close();
});
