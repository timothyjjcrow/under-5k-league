import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page, type Response } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// Hard-wire writes to this suite's disposable SQLite database, never an
// inherited DATABASE_URL. Each test owns and removes only its fixture rows.
const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
const ADMIN_STEAM_ID = "76561190000991881";
const VIEWER_STEAM_ID = "76561190000991882";
const GAME_IDS = {
  pending: "9900018801",
  ready: "9900018802",
  retryable: "9900018803",
  review: "9900018804",
  ignored: "9900018805",
};

function savedPayload(gameId: string, marker: string) {
  return JSON.stringify({
    match_id: Number(gameId), start_time: 1_790_000_000,
    duration: 2400, radiant_win: true,
    players: Array.from({ length: 10 }, (_, index) => ({
      account_id: 123456780 + index,
      personaname: index === 0 ? marker : "Fixture player",
    })),
  });
}

test.afterAll(async () => {
  await db.$disconnect();
});

async function withImportCandidates(
  run: (payloadMarker: string) => Promise<void>,
) {
  const season = await db.season.findFirstOrThrow({
    where: { isActive: true },
    select: { id: true },
  });
  const suffix = randomUUID();
  const candidateIds = Object.keys(GAME_IDS).map(
    (state) => `import-progress-${suffix}-${state}`,
  );
  const userIds = [`import-progress-${suffix}-admin`, `import-progress-${suffix}-viewer`];
  const payloadMarker = `PROVIDER_PAYLOAD_MUST_STAY_SERVER_ONLY_${suffix}`;
  const now = new Date();
  const retryAt = new Date(now.getTime() + 30 * 60_000);
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
  // A unique value inside valid JSON catches accidental payload rendering or
  // serialization into the page's RSC/hydration scripts, not only visible text.

  try {
    await db.$transaction([
      db.user.createMany({
        data: [
          { id: userIds[0], steamId: ADMIN_STEAM_ID, name: "Import progress admin", role: "ADMIN" },
          { id: userIds[1], steamId: VIEWER_STEAM_ID, name: "Import progress viewer", role: "USER" },
        ],
      }),
      db.importCandidate.createMany({
        data: [
          {
            id: candidateIds[0], seasonId: season.id, dotaMatchId: GAME_IDS.pending,
            status: "PENDING", attempts: 1, reason: "PROVIDER_UNAVAILABLE",
            nextAttemptAt: retryAt, expiresAt,
          },
          {
            id: candidateIds[1], seasonId: season.id, dotaMatchId: GAME_IDS.ready,
            status: "READY", attempts: 0, payload: savedPayload(GAME_IDS.ready, payloadMarker), fetchedAt: now, expiresAt,
          },
          {
            id: candidateIds[2], seasonId: season.id, dotaMatchId: GAME_IDS.retryable,
            status: "RETRYABLE", attempts: 2, reason: "FIXTURE_CHANGED",
            payload: savedPayload(GAME_IDS.retryable, payloadMarker), fetchedAt: now, nextAttemptAt: retryAt, expiresAt,
          },
          {
            id: candidateIds[3], seasonId: season.id, dotaMatchId: GAME_IDS.review,
            status: "NEEDS_REVIEW", attempts: 8, reason: "NO_SAFE_FIXTURE",
            payload: savedPayload(GAME_IDS.review, payloadMarker), fetchedAt: now, nextAttemptAt: retryAt, expiresAt,
          },
          {
            id: candidateIds[4], seasonId: season.id, dotaMatchId: GAME_IDS.ignored,
            status: "IGNORED", reason: "BEFORE_SEASON", payload: savedPayload(GAME_IDS.ignored, payloadMarker),
            fetchedAt: now, expiresAt,
          },
        ],
      }),
    ]);
    await run(payloadMarker);
  } finally {
    await db.$transaction([
      db.adminAction.deleteMany({ where: { actorId: { in: userIds } } }),
      db.importSuppression.deleteMany({ where: { seasonId: season.id, dotaMatchId: { in: Object.values(GAME_IDS) } } }),
      db.importCandidate.deleteMany({ where: { id: { in: candidateIds } } }),
      db.user.deleteMany({ where: { id: { in: userIds } } }),
    ]);
  }
}

async function expectPayloadPrivate(
  page: Page,
  response: Response | null,
  payloadMarker: string,
) {
  expect(response, "navigation returned a document response").not.toBeNull();
  expect(await response!.text()).not.toContain(payloadMarker);
  expect(await page.content()).not.toContain(payloadMarker);
}

test("admins see saved import states without downloading provider payloads", async ({ page }) => {
  await withImportCandidates(async (payloadMarker) => {
    const noErrors = trackPageErrors(page);
    const response = await page.goto(
      `/api/auth/dev?name=Import+progress+admin&steamId=${ADMIN_STEAM_ID}&admin=1&redirect=/admin`,
    );
    const panel = page.getByRole("region", { name: "Saved import progress" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("4 games are waiting");
    await expect(panel).toContainText("Downloaded details survive interrupted syncs.");
    await expect(panel.getByRole("listitem")).toHaveCount(4);

    const row = (gameId: string) => panel.getByRole("listitem").filter({
      has: page.getByText(`Game ${gameId}`, { exact: true }),
    });
    await expect(row(GAME_IDS.pending)).toContainText("Waiting for game details");
    await expect(row(GAME_IDS.pending)).toContainText("1 attempt · Details not available yet");
    await expect(row(GAME_IDS.pending)).toContainText("provider unavailable");
    await expect(row(GAME_IDS.pending)).toContainText("Retry after");
    await expect(row(GAME_IDS.ready)).toContainText("Downloaded; awaiting matching");
    await expect(row(GAME_IDS.ready)).toContainText("0 attempts · Details saved");
    await expect(row(GAME_IDS.retryable)).toContainText("Waiting to retry");
    await expect(row(GAME_IDS.retryable)).toContainText("2 attempts · Details saved");
    await expect(row(GAME_IDS.retryable)).toContainText("Retry after");
    await expect(row(GAME_IDS.review)).toContainText("Review needed");
    await expect(row(GAME_IDS.review)).toContainText("8 attempts · Details saved");
    await expect(row(GAME_IDS.review)).toContainText("no safe fixture");
    await expect(row(GAME_IDS.review)).not.toContainText("Retry after");
    await expect(page.getByText(`Game ${GAME_IDS.ignored}`, { exact: true })).toHaveCount(0);
    await expectPayloadPrivate(page, response, payloadMarker);

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await panel.scrollIntoViewIfNeeded();
      await expect(row(GAME_IDS.review)).toBeVisible();
      await expectNoHorizontalOverflow(page, `saved import progress at ${width}px`);
    }
    const reloaded = await page.reload();
    await expect(row(GAME_IDS.ready)).toContainText("Details saved");
    await expect(row(GAME_IDS.review)).toContainText("Review needed");
    await expectPayloadPrivate(page, reloaded, payloadMarker);
    noErrors();
  });
});

test("anonymous visitors cannot read saved import progress", async ({ page }) => {
  await withImportCandidates(async (payloadMarker) => {
    const response = await page.goto("/admin");
    await expect(page).toHaveURL(/\/login\?next=\/admin$/);
    await expect(page.getByRole("region", { name: "Saved import progress" })).toHaveCount(0);
    for (const gameId of Object.values(GAME_IDS)) {
      expect(await response!.text()).not.toContain(gameId);
    }
    await expectPayloadPrivate(page, response, payloadMarker);
  });
});

test("ordinary signed-in users cannot read saved import progress", async ({ page }) => {
  await withImportCandidates(async (payloadMarker) => {
    const response = await page.goto(
      `/api/auth/dev?name=Import+progress+viewer&steamId=${VIEWER_STEAM_ID}&redirect=/admin`,
    );
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Admin access required", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Saved import progress" })).toHaveCount(0);
    for (const gameId of Object.values(GAME_IDS)) {
      expect(await response!.text()).not.toContain(gameId);
    }
    await expectPayloadPrivate(page, response, payloadMarker);
  });
});

test("admin retries saved details and ignores an unwanted game with a durable reason", async ({ page }) => {
  await withImportCandidates(async (payloadMarker) => {
    const noErrors = trackPageErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/api/auth/dev?name=Import+progress+admin&steamId=${ADMIN_STEAM_ID}&admin=1&redirect=/admin`);
    const panel = page.getByRole("region", { name: "Saved import progress" });
    const review = panel.getByRole("listitem").filter({ has: page.getByText(`Game ${GAME_IDS.review}`, { exact: true }) });
    await expect(review).toContainText("Review needed");
    await review.getByRole("button", { name: "Retry next sync", exact: true }).click();
    await expect(review).toContainText("Downloaded; awaiting matching");
    await expect(review).toContainText("0 attempts · Details saved");
    const retried = await db.importCandidate.findFirstOrThrow({ where: { dotaMatchId: GAME_IDS.review } });
    expect(retried).toMatchObject({ status: "READY", attempts: 0, nextAttemptAt: null, revision: 1 });
    expect(retried.payload).toContain(payloadMarker);

    const unwanted = panel.getByRole("listitem").filter({ has: page.getByText(`Game ${GAME_IDS.pending}`, { exact: true }) });
    await unwanted.getByText("Ignore this game", { exact: true }).click();
    const reason = unwanted.getByRole("textbox", { name: "Reason for ignoring", exact: true });
    await expect(reason).toHaveAttribute("required", "");
    await reason.fill("Practice lobby outside the official fixture");
    await unwanted.getByRole("button", { name: "Ignore game", exact: true }).click();
    await expect(unwanted).toHaveCount(0);
    await expect(panel).toContainText("3 games are waiting");
    expect(await db.importSuppression.findFirst({ where: { dotaMatchId: GAME_IDS.pending } })).toMatchObject({
      reason: "Practice lobby outside the official fixture",
    });
    expect(await db.adminAction.findFirst({ where: { action: "ignoreImportCandidate", summary: { contains: GAME_IDS.pending } } })).toMatchObject({
      actorName: "Import progress admin", summary: expect.stringContaining("Practice lobby outside the official fixture"),
    });
    const reloaded = await page.reload();
    await expect(panel.getByRole("listitem")).toHaveCount(3);
    await expect(review).toContainText("Details saved");
    await expectPayloadPrivate(page, reloaded, payloadMarker);
    await expectNoHorizontalOverflow(page, "import recovery controls on mobile");
    noErrors();
  });
});

test("all review items remain reachable beyond 25 candidates and paging preserves other admin filters", async ({ page }) => {
  await withImportCandidates(async (payloadMarker) => {
    const seed = await db.importCandidate.findFirstOrThrow({ where: { dotaMatchId: GAME_IDS.pending } });
    const suffix = randomUUID();
    const extraRows = Array.from({ length: 51 }, (_, index) => {
      const dotaMatchId = String(9900020000 + index);
      return {
        id: `import-pages-${suffix}-${index}`,
        seasonId: seed.seasonId,
        dotaMatchId,
        status: index < 25 ? "READY" : "NEEDS_REVIEW",
        reason: index < 25 ? null : "PROVIDER_UNAVAILABLE",
        payload: savedPayload(dotaMatchId, payloadMarker),
        fetchedAt: new Date("2020-01-01T00:00:00Z"),
        updatedAt: new Date(2020, 0, 1, 0, 0, index),
        expiresAt: seed.expiresAt,
      };
    });
    try {
      await db.importCandidate.createMany({ data: extraRows });
      await page.goto(`/api/auth/dev?name=Import+progress+admin&steamId=${ADMIN_STEAM_ID}&admin=1&redirect=${encodeURIComponent("/admin?newsPage=2")}`);
      const panel = page.getByRole("region", { name: "Saved import progress" });
      const paging = panel.getByRole("navigation", { name: "Import progress pages" });
      await expect(panel).toContainText("55 games are waiting");
      await expect(panel.getByRole("listitem")).toHaveCount(25);
      for (const row of await panel.getByRole("listitem").all()) {
        await expect(row).toContainText("Review needed");
      }
      const seen = new Set(await panel.getByText(/^Game \d+$/).allTextContents());
      for (const target of [2, 3]) {
        const next = paging.getByRole("link", { name: "Next import items", exact: true });
        await expect(next).toHaveAttribute("href", `/admin?newsPage=2&importPage=${target}#adm-sync`);
        await next.click();
        await expect(paging).toContainText(`Page ${target} of 3`);
        for (const name of await panel.getByText(/^Game \d+$/).allTextContents()) seen.add(name);
      }
      expect(seen.size).toBe(55);
      for (const extra of extraRows) expect(seen.has(`Game ${extra.dotaMatchId}`)).toBe(true);
      await expect(paging.getByRole("link", { name: "Next import items", exact: true })).toHaveCount(0);
      await paging.getByRole("link", { name: "Previous import items", exact: true }).click();
      await expect(paging).toContainText("Page 2 of 3");
      expect(await page.content()).not.toContain(payloadMarker);
    } finally {
      await db.importCandidate.deleteMany({ where: { id: { in: extraRows.map((row) => row.id) } } });
    }
  });
});
