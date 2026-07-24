import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

// The inhouse's full browser lifecycle: queue → ready check (accept) →
// captain vote → live draft → ready → in progress — one real page (the
// "observer", who captains team 1) plus nine API-driven players. Runs
// zz-last: it forms and cancels a lobby, which must not race the earlier
// phase-sensitive league specs.
//
// The seeded demo queue entries are ALREADY AWAY (prisma/seed.ts backdates
// their heartbeat), so the ten fresh players here form a clean lobby.

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
  const res = await ctx.post("/api/inhouse", { data: body });
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

test("queue join/leave works and the page fits a phone", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(
    "/api/auth/dev?name=IH+Observer&steamId=76561190000002000&redirect=/inhouse",
  );

  // Queue view with the seeded demo entries visible but away (dimmed chips).
  await expect(page.getByText(/INHOUSE QUEUE/i)).toBeVisible();
  await expect(page.getByText(/0\s*\/\s*10/).first()).toBeVisible();

  await page.getByLabel("MMR").fill("4500");
  await page.getByRole("button", { name: /Join queue/ }).click();
  await expect(page.getByText(/1\s*\/\s*10/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Leave queue/ })).toBeVisible();

  // The whole page must fit the phone — no horizontal page scroll.
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: /Leave queue/ }).click();
  await expect(page.getByText(/0\s*\/\s*10/).first()).toBeVisible();

  expect(errors).toEqual([]);
});

test("full lobby lifecycle: accept → vote → draft → ready → in progress", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  page.on("dialog", (d) => d.accept()); // the Start-game confirm

  // Nine API players queue up (MMRs below the observer's, so the observer
  // captains team 1 when the vote lands on Highest MMR).
  const players: APIRequestContext[] = [];
  for (let i = 0; i < 9; i++) {
    const ctx = await apiPlayer(`IH Player ${i}`, `7656119000000210${i}`);
    players.push(ctx);
    const joined = await act(ctx, { action: "join", mmr: 5000 - i * 100 });
    expect(joined.ok).toBe(true);
  }

  // The observer joins through the real UI as the tenth — the lobby forms.
  await page.goto(
    "/api/auth/dev?name=IH+Observer&steamId=76561190000002000&redirect=/inhouse",
  );
  await page.getByLabel("MMR").fill("6000");
  await page.getByRole("button", { name: /Join queue/ }).click();

  // Ready check opens — the observer accepts through the real UI…
  await expect(
    page.getByText("Match found — accept to play!"),
  ).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();
  await page.getByRole("button", { name: "ACCEPT MATCH" }).click();
  await expect(page.getByText(/Accepted — waiting/)).toBeVisible();

  // …and the nine API accepts flip the lobby into the captain vote.
  for (const ctx of players) {
    const accepted = await act(ctx, { action: "accept" });
    expect(accepted.ok).toBe(true);
  }

  // Captain vote opens, clock ticking.
  await expect(page.getByText("How should captains be picked?")).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();

  // Observer votes through the UI; the nine API votes resolve it early.
  await page.getByRole("button", { name: /Highest MMR/ }).click();
  for (const ctx of players) {
    const voted = await act(ctx, { action: "vote", method: "MMR" });
    expect(voted.ok).toBe(true);
  }

  // Draft view: observer captains Radiant; Dire (lower seed) picks first.
  await expect(page.getByText(/On the clock/)).toBeVisible();
  await expect(page.getByText(/Draft pool/)).toBeVisible();

  // Dire's captain (the 5000-MMR API player) makes the first pick.
  const state = await act(players[0], { action: "state" });
  const lobby = state.json.lobby as {
    pool: { userId: string; name: string }[];
  };
  const firstPick = await act(players[0], {
    action: "pick",
    userId: lobby.pool[0].userId,
  });
  expect(firstPick.ok).toBe(true);

  // Now it's the observer's turn — pick through the real UI.
  await expect(page.getByText("Your pick").first()).toBeVisible();
  await page
    .getByRole("button", { name: /^Select .* to draft$/ })
    .first()
    .click();
  await page.getByRole("button", { name: /^Draft / }).click();

  // Drive the remaining picks as an admin (admins may pick for whichever
  // captain is on the clock; the final pool player auto-assigns, so READY
  // arrives without a last dead-air clock).
  const admin = await pwRequest.newContext({ baseURL: BASE });
  await admin.get(
    "/api/auth/dev?name=IH+Admin&steamId=76561190000002999&admin=1&redirect=/inhouse",
  );
  for (let guard = 0; guard < 10; guard++) {
    const s = await act(admin, { action: "state" });
    const l = s.json.lobby as null | {
      status: string;
      pool: { userId: string }[];
    };
    if (!l || l.status !== "DRAFTING") break;
    const picked = await act(admin, { action: "pick", userId: l.pool[0].userId });
    expect(picked.ok).toBe(true);
  }

  // Teams locked — the setup card tells players how to make the Dota lobby
  // and which voice channel to join (their team's is highlighted).
  await expect(page.getByText("Teams are set!")).toBeVisible();
  await expect(page.getByText("How to play this game")).toBeVisible();
  await expect(page.getByText(/GGD2L #\d{4}/).first()).toBeVisible();
  await expect(page.getByText(/inhouse team [12]/).first()).toBeVisible();

  // The observer (team 1 captain) starts the game from the UI.
  await page.getByRole("button", { name: /Start the game/ }).click();

  // Live view: pulsing banner, elapsed clock, auto-detect controls, rosters.
  await expect(page.getByText("Game in progress")).toBeVisible();
  await expect(page.getByRole("button", { name: /Auto-detect result/ })).toBeVisible();
  await expect(page.getByText("Radiant").first()).toBeVisible();
  await expect(page.getByText("Dire").first()).toBeVisible();

  // Clean up: admin scraps the lobby so a re-run starts from a clean queue.
  const cancelled = await act(admin, { action: "cancel" });
  expect(cancelled.ok).toBe(true);

  expect(errors).toEqual([]);

  for (const ctx of players) await ctx.dispose();
  await admin.dispose();
});
