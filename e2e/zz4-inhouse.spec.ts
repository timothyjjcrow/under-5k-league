import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

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
  const res = await ctx.post("/api/inhouse", {
    data: body,
    headers: { Origin: "http://localhost:3210" },
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

/** Optional review artifacts; keep CI's timed ready checks free of capture work. */
async function captureRoom(page: Page, stage: string) {
  const directory = process.env.INHOUSE_UI_CAPTURE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const viewport = page.viewportSize();
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.getByRole("region", { name: "Live inhouse room" }).screenshot({
      path: path.join(directory, `${stage}-${width}.png`),
    });
  }
  if (viewport) await page.setViewportSize(viewport);
}

test("queue join/leave works and the page fits a phone", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(
    "/api/auth/dev?name=IH+Observer&steamId=76561190000002000&redirect=/inhouse",
  );

  // Queue view with the seeded demo entries visible but away (dimmed chips).
  await expect(
    page.getByRole("heading", { name: "Inhouse queue", exact: true }),
  ).toBeVisible();
  const progress = page.getByRole("progressbar", {
    name: "Inhouse queue progress",
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "0");

  await page.getByLabel("MMR").fill("4500");
  await page.getByRole("button", { name: /Join queue/ }).click();
  await expect(progress).toHaveAttribute("aria-valuenow", "1");
  await expect(page.getByRole("button", { name: /Leave queue/ })).toBeVisible();
  await captureRoom(page, "queue");

  // The whole page must fit the phone — no horizontal page scroll.
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: /Leave queue/ }).click();
  await expect(progress).toHaveAttribute("aria-valuenow", "0");

  expect(errors).toEqual([]);
});

test("full lobby lifecycle: accept → vote → draft → ready → in progress", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const errors = trackPageErrors(page);
  let statePolls = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/inhouse") &&
      request.postData()?.includes('"action":"state"')
    )
      statePolls += 1;
  });
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
  await expect(page.getByText("Match found. You in?")).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();

  // A signed-out spectator sees the separate next-game path and is never told
  // they are "next in line" for a queue they have not joined.
  const spectatorBrowser = await browser.newContext({ baseURL: BASE });
  const spectatorPage = await spectatorBrowser.newPage();
  const spectatorErrors = trackPageErrors(spectatorPage);
  await spectatorPage.goto("/inhouse");
  await expect(
    spectatorPage.getByRole("heading", { name: "Queue for the next game" }),
  ).toBeVisible();
  await expect(
    spectatorPage.getByText("Spectating · join the next-game queue above."),
  ).toBeVisible();
  await expect(spectatorPage.getByText(/you're next in line/i)).toHaveCount(0);

  await page.getByRole("button", { name: "ACCEPT MATCH" }).click();
  await expect(page.getByText(/Accepted — waiting/)).toBeVisible();
  await captureRoom(page, "ready-check");

  // …and the nine API accepts flip the lobby into the captain vote.
  for (const ctx of players) {
    const accepted = await act(ctx, { action: "accept" });
    expect(accepted.ok).toBe(true);
  }

  // Captain vote opens, clock ticking.
  await expect(page.getByText("Choose your captains")).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();
  await captureRoom(page, "captain-vote");

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
  await captureRoom(page, "draft");
  await page
    .getByRole("button", { name: /^Select .* to draft$/ })
    .first()
    .click();
  await page.getByRole("button", { name: /^Draft / }).click();

  // Administrators have a browser recovery control for a captain whose tab is
  // disconnected or stuck. It is deliberately NOT `isOnClock`: the admin can
  // act, but must not receive the captain's chime/title/"Your pick" alert.
  const adminBrowser = await browser.newContext({ baseURL: BASE });
  const adminPage = await adminBrowser.newPage();
  const adminErrors = trackPageErrors(adminPage);
  await adminPage.goto(
    "/api/auth/dev?name=IH+Admin&steamId=76561190000002999&admin=1&redirect=/inhouse",
  );
  await expect(adminPage.getByText(/Admin recovery:/)).toBeVisible();
  expect(await adminPage.title()).not.toContain("(!) Your pick");
  await adminPage
    .getByRole("button", { name: /^Select .* to draft$/ })
    .first()
    .click();
  const adminDraft = adminPage.getByRole("button", {
    name: /^Admin: draft .* for /,
  });
  await adminDraft.click();
  // Wait for the mutation response before issuing another pick through the API
  // context, otherwise the two recovery actions can race for the same turn.
  await expect(adminDraft).toHaveCount(0);

  // Drive the remaining picks through the same signed-in admin context; the
  // final pool player auto-assigns, so READY arrives without dead-air clock.
  const admin = adminBrowser.request;
  for (let guard = 0; guard < 10; guard++) {
    const s = await act(admin, { action: "state" });
    const l = s.json.lobby as null | {
      status: string;
      pool: { userId: string }[];
    };
    if (!l || l.status !== "DRAFTING") break;
    const picked = await act(admin, {
      action: "pick",
      userId: l.pool[0].userId,
    });
    expect(picked.ok).toBe(true);
  }

  // Teams locked — the setup card tells players how to make the Dota lobby
  // and which voice channel to join (their team's is highlighted).
  await expect(page.getByText("Teams are set!")).toBeVisible();
  await expect(page.getByText("How to play this game")).toBeVisible();
  await expect(page.getByTitle("Copy lobby name")).toContainText(
    "GGD2L Inhouse",
  );
  await expect(page.getByTitle("Copy password")).toContainText("ggd2l");
  await expect(page.getByTitle("Copy league ticket")).toContainText(
    "Under 5K In-House League",
  );
  await expect(
    page.getByText(
      /without this ticket, the game will not appear on OpenDota/i,
    ),
  ).toBeVisible();
  await expect(page.getByText(/inhouse team [12]/).first()).toBeVisible();

  // --- Betting: the 45s window opens on this same transition ---------------
  // The panel has to sit ABOVE the setup card — it is the one thing that has
  // to be read before everyone leaves for the Dota client.
  await expect(page.getByLabel("Betting pot")).toBeVisible();
  // Nobody has staked yet, so the observer's own bet is the whole pool and
  // NOTHING is covered — the button must say so before it is pressed, which is
  // the honesty this design turns on.
  const chip = page.getByRole("button", { name: /^Bet 10 Cred on/ });
  await expect(chip).toBeVisible();
  await chip.click();

  // The slip lands and is immutable — the chips go away rather than offering a
  // raise that the server would refuse. Anchor on "Your bet:" rather than the
  // bare amount: the success toast says "10 Cred on Radiant — your slip is in
  // the pot" at the same moment, and a looser matcher is a strict-mode flake
  // that only fires while the toast is still on screen.
  await expect(page.getByText(/Your bet: 10 Cred on/)).toBeVisible();
  // Betting into an empty pool must SAY it is not live — the whole design
  // rests on nobody discovering that after the fact.
  await expect(page.getByText(/It needs a taker/)).toBeVisible();
  await captureRoom(page, "setup");

  // The pot panel is the widest thing added to this room — two side-by-side
  // pool bars, a slip list with player names, and a chip row — and the room's
  // only overflow tripwire covers the QUEUE view, four phases earlier. Check
  // the phase that actually holds it, at the narrowest real phone.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByLabel("Betting pot")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(
    page.getByRole("button", { name: /^Bet 10 Cred on/ }),
  ).toHaveCount(0);
  // …and it shows in the pool bar's accessible name, which is the only place a
  // screen reader learns the pot exists at all.
  await expect(
    page.getByLabel(/: 10 Cred staked, 0 of it covered/),
  ).toBeVisible();

  // A second bet is refused server-side even if the UI is bypassed — the
  // single-shot rule is the double-spend guard, not a rendering decision.
  const second = await act(players[0], { action: "bet", stake: 10 });
  const secondAgain = await act(players[0], { action: "bet", stake: 10 });
  expect(second.ok).toBe(true);
  expect(secondAgain.ok).toBe(false);

  // The observer (team 1 captain) starts the game from the UI. Start must NOT
  // close betting — nobody should be the person who closed the ante.
  await page.getByRole("button", { name: /Start the game/ }).click();

  // Live view: pulsing banner, elapsed clock, auto-detect controls, rosters.
  await expect(page.getByText("Game in progress")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Auto-detect result/ }),
  ).toBeVisible();
  await expect(page.getByText("Radiant").first()).toBeVisible();
  await expect(page.getByText("Dire").first()).toBeVisible();
  // Starting early must keep the pot live for its original 45-second window,
  // including prompt coverage updates for a player who already placed a bet.
  const pollsWhenStarted = statePolls;
  await expect
    .poll(() => statePolls, { timeout: 6_000 })
    .toBeGreaterThanOrEqual(pollsWhenStarted + 2);
  await captureRoom(page, "in-progress");

  // A normal bystander can still line up while this game is live. Signed-out
  // visitors get a sign-in path; after signing in they can join, see an honest
  // NEXT-game queue, and leave again without touching the active lobby.
  await expect(
    spectatorPage.getByRole("heading", { name: "Queue for the next game" }),
  ).toBeVisible();
  const signInForNext = spectatorPage.getByRole("link", {
    name: "Sign in for next game",
  });
  await expect(signInForNext).toHaveAttribute("href", "/login?next=/inhouse");

  await spectatorPage.goto(
    "/api/auth/dev?name=IH+Next+Player&steamId=76561190000002997&redirect=/inhouse",
  );
  await spectatorPage.getByLabel("MMR").fill("4200");
  await spectatorPage
    .getByRole("button", { name: /Join next-game queue/ })
    .click();
  await expect(
    spectatorPage.getByRole("heading", { name: "Next-game queue" }),
  ).toBeVisible();
  await expect(
    spectatorPage.getByText("Ready check after this game"),
  ).toBeVisible();
  await expect(
    spectatorPage.getByRole("progressbar", {
      name: "Next-game queue progress",
    }),
  ).toBeVisible();
  await spectatorPage.getByRole("button", { name: "Leave queue" }).click();
  await expect(
    spectatorPage.getByRole("heading", { name: "Queue for the next game" }),
  ).toBeVisible();
  expect(spectatorErrors).toEqual([]);
  await spectatorBrowser.close();

  // Clean up: admin scraps the lobby so a re-run starts from a clean queue.
  // A PLAIN cancel is now refused — this lobby is IN_PROGRESS with confirmed
  // bets, and cancelling a live game is otherwise an admin undo for a losing
  // bet. Assert the refusal rather than just forcing past it: it is the one
  // guard this feature added to previously hardened code, and a silent
  // regression there is worth catching in a browser too.
  const refused = await act(admin, { action: "cancel" });
  expect(refused.ok).toBe(false);

  // …and drive the real recovery through the BROWSER, because the refusal above
  // is only half the story: one 10-Cred bet makes a live lobby un-cancellable,
  // which holds the single active-lobby slot and stops the whole league forming
  // a game. If the only way out is a hand-written API call, the feature has a
  // liveness bug however green the service tests are.
  await page.goto(
    "/api/auth/dev?name=IH+Admin+UI&steamId=76561190000002998&admin=1&redirect=/inhouse",
  );

  // The two destructive controls must never share a pixel: while a plain cancel
  // is guaranteed to refuse, it is not rendered at all.
  await expect(
    page.getByRole("button", { name: "Admin: cancel this lobby" }),
  ).toHaveCount(0);
  const forceTrigger = page.getByRole("button", {
    name: /force-cancel this live game/i,
  });
  await expect(forceTrigger).toBeVisible();
  await forceTrigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The confirm has to state what dies — the /admin rule. It names the real pot.
  await expect(
    dialog.getByText(/Cred across .* refunded in full/),
  ).toBeVisible();

  const confirmBtn = dialog.getByRole("button", {
    name: /Force-cancel|Scrap/i,
  });
  await expect(confirmBtn).toBeDisabled();

  // Focus starts inside the dialog, wraps in both directions, Escape restores
  // the trigger, and the document cannot scroll behind the destructive choice.
  const field = dialog.getByRole("textbox");
  const keepGame = dialog.getByRole("button", { name: "Keep the game" });
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe(
    "hidden",
  );
  await field.press("Shift+Tab");
  await expect(keepGame).toBeFocused();
  await keepGame.press("Tab");
  await expect(field).toBeFocused();
  await field.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(forceTrigger).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe(
    "hidden",
  );

  // Reopen to exercise the typed destructive action itself.
  await forceTrigger.click();
  await expect(dialog).toBeVisible();

  // The token is the lobby's own code, quoted in the prompt. A wrong code must
  // not arm it, and Enter must not complete it — reflex-confirming a control
  // that refunds ten people's stakes is the exact thing being prevented.
  const prompt = await dialog.getByText(/Type the lobby code/).innerText();
  const code = /(\d{3,})/.exec(prompt)?.[1] ?? "";
  expect(code).not.toEqual("");

  await field.fill(code.slice(0, -1) + (code.endsWith("0") ? "1" : "0"));
  await expect(confirmBtn).toBeDisabled();
  await field.fill(code);
  await expect(confirmBtn).toBeEnabled();
  await field.press("Enter");
  await expect(dialog).toBeVisible(); // Enter is preventDefault'ed — still armed.

  await confirmBtn.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The slot is free again: the room falls back to the queue view.
  await expect(
    page.getByRole("heading", { name: "Inhouse queue", exact: true }),
  ).toBeVisible();
  // …and the server agrees there is no active lobby holding it.
  const after = await act(admin, { action: "state" });
  expect(after.json.lobby).toBeNull();

  expect(errors).toEqual([]);
  expect(adminErrors).toEqual([]);

  for (const ctx of players) await ctx.dispose();
  await adminBrowser.close();
});
