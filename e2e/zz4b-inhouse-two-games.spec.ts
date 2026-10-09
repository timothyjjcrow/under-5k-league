import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

// Two inhouse games at once: twenty players form two lobbies, each player
// sees their own game with the other folded away, a spectator on a phone sees
// both, and an admin scraps each game by name. Runs after zz4-inhouse (which
// leaves its ten re-queued but away) and cleans up after itself, so the
// history spec after it starts from no live game.

const BASE = "http://localhost:3210";

/** Dev-login a fresh user and return an authed API context. */
async function apiPlayer(
  name: string,
  steamId: string,
): Promise<APIRequestContext> {
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
  return { ok: res.ok(), json: await res.json() };
}

/** Uncaught client errors crash silently in raw-HTML checks — track them. */
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

type Game = { slot: number; readyCheck: { acceptedCount: number } | null };

test("twenty players play two games at once, each in its own room", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const errors = trackPageErrors(page);
  // The admin cancels at the end.
  page.on("dialog", (d) => d.accept());

  // Nineteen API players queue: the first ten form game 1.
  const players: APIRequestContext[] = [];
  for (let i = 0; i < 19; i++) {
    const ctx = await apiPlayer(
      `2G Player ${i}`,
      `76561190000004${String(i).padStart(3, "0")}`,
    );
    players.push(ctx);
    const joined = await act(ctx, { action: "join", mmr: 4000 - i * 50 });
    expect(joined.ok).toBe(true);
  }

  // The observer arrives with game 1 live and a second slot free.
  await page.goto(
    "/api/auth/dev?name=2G+Observer&steamId=76561190000004100&redirect=/inhouse",
  );
  await expect(
    page.getByText(
      "This game is underway. Ten in the queue start another game alongside it.",
    ),
  ).toBeVisible();
  await page.getByLabel("MMR").fill("3000");
  await page.getByRole("button", { name: /Join next-game queue/ }).click();

  // The twentieth join forms game 2: the observer's own ready check, named,
  // with game 1 folded to one line under it.
  await expect(page.getByText("Match found. You in?")).toBeVisible();
  await expect(page.getByText("Your lobby · Game 2")).toBeVisible();
  await expect(page.getByText(/is also live · Accept/)).toBeVisible();
  await page.getByRole("button", { name: "ACCEPT MATCH" }).click();
  await expect(page.getByText(/Accepted — waiting/)).toBeVisible();

  // The accept landed in game 2 alone (players[0] plays game 1).
  const seen = await act(players[0], { action: "state" });
  const mine = seen.json.lobby as Game;
  const other = (seen.json.otherLobbies as Game[])[0];
  expect(seen.json.liveGames).toBe(2);
  expect([mine.slot, mine.readyCheck?.acceptedCount]).toEqual([1, 0]);
  expect([other.slot, other.readyCheck?.acceptedCount]).toEqual([2, 1]);

  // A spectator on a phone sees both games, named, and the page fits.
  const spectatorBrowser = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 390, height: 844 },
  });
  const spectatorPage = await spectatorBrowser.newPage();
  const spectatorErrors = trackPageErrors(spectatorPage);
  await spectatorPage.goto(
    "/api/auth/dev?name=2G+Watcher&steamId=76561190000004101&redirect=/inhouse",
  );
  await expect(
    spectatorPage.getByText(
      "Both games are underway. The next ready check starts when one finishes.",
    ),
  ).toBeVisible();
  await expect(
    spectatorPage.getByRole("heading", { name: /^Game 1/ }),
  ).toBeVisible();
  await expect(
    spectatorPage.getByRole("heading", { name: /^Game 2/ }),
  ).toBeVisible();
  expect(await horizontalOverflow(spectatorPage)).toBeLessThanOrEqual(0);
  expect(spectatorErrors).toEqual([]);
  await spectatorBrowser.close();

  // Clean up through the browser: an admin scraps each game by name.
  await page.goto(
    "/api/auth/dev?name=2G+Admin&steamId=76561190000004102&admin=1&redirect=/inhouse",
  );
  await page.getByRole("button", { name: "Admin: cancel Game 1" }).click();
  // A lone game 2 is still named: its channels and lobby aren't game 1's.
  await expect(
    page.getByRole("button", { name: "Admin: cancel Game 2" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Admin: cancel Game 2" }).click();
  await expect(
    page.getByRole("heading", { name: "Inhouse queue", exact: true }),
  ).toBeVisible();
  const after = await act(page.request, { action: "state" });
  expect(after.json.liveGames).toBe(0);

  expect(errors).toEqual([]);
  for (const ctx of players) await ctx.dispose();
});
