import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { SETTING_KEYS, getSetting, setSetting } from "@/lib/settings";
import {
  INHOUSE_BOARD_POST_LEASE_MS,
  createInhouseBoard,
  removeInhouseBoard,
  syncInhouseBoard,
  getInhouseBoardStatus,
  loadBoardStats,
  resetBoardStatsCache,
} from "@/lib/inhouse-board-service";
import { runResultSync } from "@/lib/result-sync-service";
import { getInhouseState } from "@/lib/inhouse-service";
import { makeUser, raceN } from "./factories";

// The pinned Discord queue board: ONE message rewritten in place. What has to
// hold — a stale board is worse than no board, and a chatty one defeats the
// entire point of the feature:
//   * OFF unless an admin posted it (the Setting row IS the switch)
//   * no request at all when the rendered state hasn't moved
//   * at most one edit per throttle window, and a lost race retries later
//   * a deleted message turns the feature off instead of re-posting itself
//   * a webhook pointed at a new channel never edits the old channel's message

const HOOK =
  "https://discord.com/api/webhooks/11111/token-a-inert-value";
const OTHER_HOOK = "https://discord.com/api/webhooks/2222/token-b";
const LEAGUE_HOOK =
  "https://discord.com/api/webhooks/33333/token-league-inert-value";
// A real Discord message id is a 19-digit snowflake — the admin card only ever
// shows a truncated hint of it, which a 5-character fake would not exercise.
const MSG_ID = "1379001234567890123";

vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    getInhouseWebhookUrl: vi.fn(async () => HOOK),
    postWebhookMessage: vi.fn(async () => ({ id: MSG_ID })),
    patchWebhookMessage: vi.fn(async () => "ok" as const),
    deleteWebhookMessage: vi.fn(async () => true),
  };
});
import {
  deleteWebhookMessage,
  getInhouseWebhookUrl,
  patchWebhookMessage,
  postWebhookMessage,
} from "@/lib/discord";
// The routing tests assert on the REAL resolvers (the mock above replaces the
// exported getInhouseWebhookUrl, which is what the service consumes).
const {
  getInhouseWebhookUrl: realGetInhouseWebhookUrl,
  getWebhookUrl: realGetWebhookUrl,
  getInhouseAlertWebhookUrl: realGetInhouseAlertWebhookUrl,
} = await vi.importActual<typeof import("@/lib/discord")>("@/lib/discord");

const mockHook = vi.mocked(getInhouseWebhookUrl);
const mockPost = vi.mocked(postWebhookMessage);
const mockPatch = vi.mocked(patchWebhookMessage);
const mockDelete = vi.mocked(deleteWebhookMessage);

beforeEach(() => {
  delete process.env.VERCEL_ENV;
  // The empty-state stats are memoised in-process on a TTL — without this,
  // one test's league history leaks into the next one's empty board.
  resetBoardStatsCache();
  mockHook.mockReset().mockResolvedValue(HOOK);
  mockPost.mockReset().mockResolvedValue({ id: MSG_ID });
  mockPatch.mockReset().mockResolvedValue("ok");
  mockDelete.mockReset().mockResolvedValue(true);
});

/** Put N present players in the queue. */
async function enqueue(n: number, prefix = "p") {
  for (let i = 0; i < n; i++) {
    const u = await makeUser(`${prefix}${i}`);
    await prisma.inhouseQueueEntry.create({
      data: { userId: u.id, mmr: 3000, lastSeenAt: new Date() },
    });
  }
}

/** Let the throttle window lapse without waiting for real time. */
async function expireThrottle() {
  await setSetting(
    SETTING_KEYS.INHOUSE_BOARD_AT,
    new Date(Date.now() - 3600_000).toISOString(),
  );
}

const boardRow = () => getSetting(SETTING_KEYS.INHOUSE_BOARD);

describe("inhouse board — off by default", () => {
  it("does nothing at all until an admin posts it", async () => {
    await enqueue(4);
    await syncInhouseBoard();
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    expect(await boardRow()).toBeNull();
  });

  it("reports itself as not posted", async () => {
    expect(await getInhouseBoardStatus()).toMatchObject({
      posted: false,
      stranded: false,
    });
  });
});

describe("inhouse board — stable last-game chronology", () => {
  it("does not let an older lobby's retry timestamp replace the latest game", async () => {
    const now = Date.now();
    const older = await prisma.inhouseLobby.create({
      data: {
        status: "COMPLETED",
        createdAt: new Date(now - 2 * 60 * 60_000),
        completedAt: new Date(now - 50 * 60_000),
        matchStartTime: new Date(now - 90 * 60_000),
        durationSecs: 40 * 60,
        winnerTeam: 1,
        radiantTeam: 1,
      },
    });
    const newer = await prisma.inhouseLobby.create({
      data: {
        status: "COMPLETED",
        createdAt: new Date(now - 60 * 60_000),
        completedAt: new Date(now - 20 * 60_000),
        matchStartTime: new Date(now - 50 * 60_000),
        durationSecs: 30 * 60,
        winnerTeam: 2,
        radiantTeam: 1,
      },
    });

    // A delayed settlement/reversal rotates its generic retry cursor. The
    // board must still choose the newer formed game and show its played end.
    await prisma.inhouseLobby.update({
      where: { id: older.id },
      data: { updatedAt: new Date(now + 60_000) },
    });

    const stats = await loadBoardStats(now);
    expect(stats.lastLobbyId).toBe(newer.id);
    expect(stats.lastEndedAtMs).toBe(now - 20 * 60_000);
    expect(stats.lastWinnerSide).toBe("Dire");
  });
});

describe("inhouse board — creation", () => {
  it("does not post or reserve board state from a Vercel preview", async () => {
    process.env.VERCEL_ENV = "preview";

    await expect(createInhouseBoard()).resolves.toEqual({
      ok: false,
      error:
        "Discord posting is disabled in this preview so it cannot alter the live server.",
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(await boardRow()).toBeNull();
  });

  it("preserves copied board state without editing or deleting the live message", async () => {
    await createInhouseBoard();
    const copiedState = await boardRow();
    mockPatch.mockClear();
    mockDelete.mockClear();
    process.env.VERCEL_ENV = "preview";

    await enqueue(1, "preview");
    await syncInhouseBoard();
    await expect(removeInhouseBoard()).resolves.toEqual({
      ok: false,
      error:
        "Discord deletion is disabled in this preview so it cannot alter the live server.",
    });

    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(await boardRow()).toBe(copiedState);
  });

  it("posts once and remembers the message id and webhook", async () => {
    await enqueue(3);
    expect(await createInhouseBoard()).toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(1);

    const stored = JSON.parse((await boardRow())!);
    expect(stored.messageId).toBe(MSG_ID);
    expect(stored.webhookId).toBe("11111");
    expect(stored.digest).toBeTruthy();

    const status = await getInhouseBoardStatus();
    expect(status.posted).toBe(true);
    expect(status.stranded).toBe(false);
    // The admin card must not leak a usable pointer to the message.
    expect(status.messageHint).not.toBe(MSG_ID);
    expect(status.messageHint).toBe("1379…23");
  });

  it("refuses without a webhook", async () => {
    mockHook.mockResolvedValue(null);
    const res = await createInhouseBoard();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/webhook/i);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("refuses to post a second board in the same channel", async () => {
    await createInhouseBoard();
    mockPost.mockClear();
    const res = await createInhouseBoard();
    expect(res.ok).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("retains a visible recovery state when Discord does not confirm an id", async () => {
    mockPost.mockResolvedValue(null);
    await expect(createInhouseBoard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/didn't confirm.*message id/i),
    });

    const stored = JSON.parse((await boardRow())!);
    expect(stored).toMatchObject({
      webhookId: "11111",
      messageId: "",
      reservedAt: null,
    });
    await expect(getInhouseBoardStatus()).resolves.toMatchObject({
      posted: false,
      posting: true,
      postingStuck: true,
    });
  });

  it("also treats a response without a usable message id as ambiguous", async () => {
    mockPost.mockResolvedValue({ id: "" });

    await expect(createInhouseBoard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/didn't confirm.*message id/i),
    });
    await expect(getInhouseBoardStatus()).resolves.toMatchObject({
      posted: false,
      posting: true,
      postingStuck: true,
    });
    expect(await boardRow()).not.toBeNull();
  });

  it("does not overwrite newer board state when an ambiguous response arrives late", async () => {
    const replacement = JSON.stringify({
      webhookId: "11111",
      messageId: "1379009999999999999",
      digest: "replacement-after-post-started",
    });
    mockPost.mockImplementation(async () => {
      // Another admin recovered/replaced the reservation while Discord's POST
      // was in flight. The late request may report ambiguity, but it no longer
      // owns the Setting row and must not turn this tracked board into a stuck
      // reservation.
      await setSetting(SETTING_KEYS.INHOUSE_BOARD, replacement);
      return null;
    });

    await expect(createInhouseBoard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/state changed/i),
    });
    expect(await boardRow()).toBe(replacement);
    await expect(getInhouseBoardStatus()).resolves.toMatchObject({
      posted: true,
      posting: false,
      postingStuck: false,
    });
  });

  it("blocks a retry until an admin clears the possible orphan", async () => {
    mockPost.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: MSG_ID });
    await createInhouseBoard();

    await expect(createInhouseBoard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/interrupted/i),
    });
    expect(mockPost).toHaveBeenCalledTimes(1);

    await expect(removeInhouseBoard()).resolves.toEqual({
      ok: true,
      orphaned: true,
    });
    expect(await boardRow()).toBeNull();

    await expect(createInhouseBoard()).resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(JSON.parse((await boardRow())!).messageId).toBe(MSG_ID);
  });

  it("removes a message that finishes posting after its reservation was cleared", async () => {
    mockPost.mockImplementation(async () => {
      await setSetting(SETTING_KEYS.INHOUSE_BOARD, "");
      return { id: MSG_ID };
    });

    const res = await createInhouseBoard();

    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cancelled/i),
    });
    expect(mockDelete).toHaveBeenCalledWith(HOOK, MSG_ID);
    expect(await boardRow()).toBeNull();
  });
});

describe("inhouse board — interrupted post recovery", () => {
  async function reserveBoard(reservedAt?: string) {
    await setSetting(
      SETTING_KEYS.INHOUSE_BOARD,
      JSON.stringify({
        webhookId: "11111",
        messageId: "",
        digest: "posting:11111",
        ...(reservedAt ? { reservedAt } : {}),
      }),
    );
  }

  it("keeps a fresh reservation locked while Discord may still be posting", async () => {
    await reserveBoard(new Date().toISOString());

    await expect(getInhouseBoardStatus()).resolves.toMatchObject({
      posted: false,
      posting: true,
      postingStuck: false,
    });
    await expect(createInhouseBoard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/already being posted/i),
    });
    await expect(removeInhouseBoard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/still posting/i),
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(await boardRow()).not.toBeNull();
  });

  it("surfaces an expired reservation and clears it only as a possible orphan", async () => {
    await reserveBoard(
      new Date(Date.now() - INHOUSE_BOARD_POST_LEASE_MS - 1).toISOString(),
    );

    await expect(getInhouseBoardStatus()).resolves.toMatchObject({
      posted: false,
      posting: true,
      postingStuck: true,
    });
    await expect(createInhouseBoard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/interrupted/i),
    });
    await expect(removeInhouseBoard()).resolves.toEqual({
      ok: true,
      orphaned: true,
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(await boardRow()).toBeNull();
  });

  it("treats a pre-lease reservation as interrupted and supports explicit recovery", async () => {
    await reserveBoard();

    await expect(getInhouseBoardStatus()).resolves.toMatchObject({
      posting: true,
      postingStuck: true,
    });
    await expect(removeInhouseBoard({ force: true })).resolves.toEqual({
      ok: true,
      orphaned: true,
    });
    expect(await boardRow()).toBeNull();
  });
});

describe("inhouse board — the digest gate", () => {
  it("makes no request when the state hasn't moved", async () => {
    await enqueue(4);
    await createInhouseBoard();
    await expireThrottle();

    await syncInhouseBoard();
    await syncInhouseBoard();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("edits once when a player joins", async () => {
    await enqueue(4);
    await createInhouseBoard();
    await expireThrottle();

    await enqueue(1, "late");
    await syncInhouseBoard();
    expect(mockPatch).toHaveBeenCalledTimes(1);

    // The stored digest now matches reality, so a follow-up poll is free.
    await expireThrottle();
    await syncInhouseBoard();
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it("repaints when the queue EMPTIES — the case no other code path sees", async () => {
    await enqueue(5);
    await createInhouseBoard();
    await expireThrottle();

    await prisma.inhouseQueueEntry.deleteMany({});
    await syncInhouseBoard();
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const [, , payload] = mockPatch.mock.calls[0];
    const embed = (payload.embeds as { title: string }[])[0];
    expect(embed.title).toContain("slots open");
  });

  it("sends an embed, never a plain message", async () => {
    await enqueue(2);
    await createInhouseBoard();
    await expireThrottle();
    await enqueue(1, "x");
    await syncInhouseBoard();

    const [, , payload] = mockPatch.mock.calls[0];
    expect(payload.embeds).toHaveLength(1);
    expect(payload.content).toBeUndefined();
  });
});

describe("inhouse board — the throttle", () => {
  it("collapses a burst of joins into a single edit", async () => {
    await enqueue(2);
    await createInhouseBoard();
    await expireThrottle();

    for (let i = 0; i < 5; i++) {
      await enqueue(1, `burst${i}`);
      await syncInhouseBoard();
    }
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it("catches up on the next poll once the window lapses — the burst tail is never lost", async () => {
    await enqueue(2);
    await createInhouseBoard();
    await expireThrottle();

    await enqueue(1, "a");
    await syncInhouseBoard(); // edit 1
    await enqueue(1, "b");
    await syncInhouseBoard(); // throttled — but the digest still differs
    expect(mockPatch).toHaveBeenCalledTimes(1);

    await expireThrottle();
    await syncInhouseBoard();
    expect(mockPatch).toHaveBeenCalledTimes(2);
    const [, , payload] = mockPatch.mock.calls[1];
    const embed = (payload.embeds as { title: string }[])[0];
    expect(embed.title).toContain("4 / 10"); // the FINAL count, not a stale step
  });

  it("does not burn the throttle when nothing changed", async () => {
    await enqueue(3);
    await createInhouseBoard();
    await expireThrottle();
    const before = await getSetting(SETTING_KEYS.INHOUSE_BOARD_AT);

    await syncInhouseBoard();
    expect(await getSetting(SETTING_KEYS.INHOUSE_BOARD_AT)).toBe(before);
  });
});

describe("inhouse board — failure handling", () => {
  it("turns itself off when the message is gone, and never re-posts", async () => {
    await enqueue(3);
    await createInhouseBoard();
    await expireThrottle();
    await enqueue(1, "z");

    mockPatch.mockResolvedValue("gone");
    await syncInhouseBoard();
    expect(await boardRow()).toBeNull();

    // Subsequent polls are silent — a self-resurrecting message would be the
    // exact channel spam this feature exists to avoid.
    mockPatch.mockClear();
    await expireThrottle();
    await syncInhouseBoard();
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledTimes(1); // only the original create
  });

  it("retries after a transient failure instead of losing the update", async () => {
    await enqueue(3);
    await createInhouseBoard();
    await expireThrottle();
    await enqueue(1, "z");

    mockPatch.mockResolvedValue("failed");
    await syncInhouseBoard();
    expect(await boardRow()).not.toBeNull(); // still on

    mockPatch.mockResolvedValue("ok");
    await expireThrottle();
    await syncInhouseBoard();
    expect(mockPatch).toHaveBeenCalledTimes(2);
    // ...and the retry is now recorded, so it settles.
    await expireThrottle();
    await syncInhouseBoard();
    expect(mockPatch).toHaveBeenCalledTimes(2);
  });

  it("keeps the board while the webhook is temporarily unset", async () => {
    await enqueue(3);
    await createInhouseBoard();
    await expireThrottle();

    mockHook.mockResolvedValue(null);
    await syncInhouseBoard();
    expect(mockPatch).not.toHaveBeenCalled();
    expect(await boardRow()).not.toBeNull();
  });

  it("survives a corrupt row without throwing on a poll", async () => {
    await setSetting(SETTING_KEYS.INHOUSE_BOARD, "{not json");
    await expect(syncInhouseBoard()).resolves.toBeUndefined();
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe("inhouse board — webhook moved to another channel", () => {
  it("forgets the stranded message instead of editing the wrong channel", async () => {
    await enqueue(3);
    await createInhouseBoard();
    await expireThrottle();

    mockHook.mockResolvedValue(OTHER_HOOK);
    await syncInhouseBoard();
    expect(mockPatch).not.toHaveBeenCalled();
    expect(await boardRow()).toBeNull();
  });

  it("flags the mismatch to the admin before anything is dropped", async () => {
    await createInhouseBoard();
    mockHook.mockResolvedValue(OTHER_HOOK);
    expect(await getInhouseBoardStatus()).toMatchObject({
      posted: true,
      stranded: true,
    });
  });

  it("keeps working after a token regeneration (same webhook id)", async () => {
    await enqueue(3);
    await createInhouseBoard();
    await expireThrottle();

    mockHook.mockResolvedValue(
      "https://discord.com/api/webhooks/11111/NEW-token-inert-value",
    );
    await enqueue(1, "z");
    await syncInhouseBoard();
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(await boardRow()).not.toBeNull();
  });
});

describe("inhouse routing — which channel gets what", () => {
  // A Discord webhook is bound to one channel, so with a single webhook the
  // queue board lands wherever league announcements go (this shipped pointing
  // at #welcome). An optional second webhook moves inhouse traffic on its own.

  it("falls back to the league channel when no inhouse webhook is set", async () => {
    await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, LEAGUE_HOOK);
    expect(await realGetInhouseWebhookUrl()).toBe(LEAGUE_HOOK);
    expect((await getInhouseBoardStatus()).separateChannel).toBe(false);
  });

  it("uses the inhouse webhook when one is set, without touching the league one", async () => {
    await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, LEAGUE_HOOK);
    await setSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL, HOOK);

    expect(await realGetInhouseWebhookUrl()).toBe(HOOK);
    expect(await realGetWebhookUrl()).toBe(LEAGUE_HOOK); // league unchanged

    const status = await getInhouseBoardStatus();
    expect(status.separateChannel).toBe(true);
    // The card gets a fingerprint, never the credential.
    expect(status.inhouseMasked).not.toContain("token-a");
    expect(status.inhouseMasked).toContain("•");
  });

  it("strands the board when the inhouse channel changes, rather than editing the wrong one", async () => {
    await setSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL, HOOK);
    await createInhouseBoard();
    await expireThrottle();

    // Admin points inhouse at a different channel.
    mockHook.mockResolvedValue(OTHER_HOOK);
    await enqueue(1, "z");
    await syncInhouseBoard();

    expect(mockPatch).not.toHaveBeenCalled();
    expect(await boardRow()).toBeNull();
  });
});

describe("alerts vs the board — separate channels", () => {
  // The board is read at a glance from the BOTTOM of its channel. One alert
  // posted under it pushes it out of view, which defeats the whole design —
  // so alerts get their own webhook, and the board's channel stays board-only.
  const ALERT_HOOK =
    "https://discord.com/api/webhooks/44444/token-alert-inert-value";

  it("sends alerts to the board's channel when no alert webhook is set", async () => {
    await setSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL, HOOK);
    expect(await realGetInhouseAlertWebhookUrl()).toBe(HOOK);
    expect((await getInhouseBoardStatus()).alertsSeparate).toBe(false);
  });

  it("routes alerts away once an alert webhook exists, leaving the board put", async () => {
    await setSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL, HOOK);
    await setSetting(SETTING_KEYS.INHOUSE_ALERT_WEBHOOK_URL, ALERT_HOOK);

    expect(await realGetInhouseAlertWebhookUrl()).toBe(ALERT_HOOK);
    // The BOARD still resolves its own channel — unchanged.
    expect(await realGetInhouseWebhookUrl()).toBe(HOOK);

    const status = await getInhouseBoardStatus();
    expect(status.alertsSeparate).toBe(true);
    expect(status.alertsMasked).not.toContain("token-alert");
  });

  it("keeps editing the board in its own channel after alerts move away", async () => {
    await setSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL, HOOK);
    await createInhouseBoard();
    await expireThrottle();
    await setSetting(SETTING_KEYS.INHOUSE_ALERT_WEBHOOK_URL, ALERT_HOOK);

    await enqueue(1, "z");
    await syncInhouseBoard();
    // Not stranded, not re-posted — the board's webhook never changed.
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(await boardRow()).not.toBeNull();
  });
});

describe("inhouse board — never on the button-press path", () => {
  it("skips the board when a mutation asks for state, and paints on the next poll", async () => {
    // /api/inhouse answers every mutation with a getInhouseState payload. The
    // request that CHANGES the queue is therefore the one that would render
    // the new digest and win the edit claim — so ACCEPT, on a 45-second clock,
    // would block on Discord. The route passes syncBoard:false; the client's
    // own poll (250ms later via bumpPollRef) carries the board instead.
    await enqueue(3);
    await createInhouseBoard();
    await expireThrottle();
    await enqueue(1, "z");

    await getInhouseState(null, { syncBoard: false });
    expect(mockPatch).not.toHaveBeenCalled();

    await getInhouseState(null);
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });
});

describe("inhouse board — health is honest", () => {
  async function postedBoardWithAChange() {
    await enqueue(3);
    await createInhouseBoard();
    await expireThrottle();
    await enqueue(1, "z");
  }

  it("reports last edit only when Discord actually accepted one", async () => {
    await enqueue(3);
    await createInhouseBoard();
    // Posted but never edited — the throttle key is untouched, so a naive
    // implementation reading it would have shown a bogus time here.
    expect((await getInhouseBoardStatus()).lastEdit).toBeNull();

    await expireThrottle();
    await enqueue(1, "z");
    await syncInhouseBoard();
    expect((await getInhouseBoardStatus()).lastEdit).not.toBeNull();
  });

  it("counts failing edits instead of looking healthy", async () => {
    await postedBoardWithAChange();
    mockPatch.mockResolvedValue("failed");

    await syncInhouseBoard();
    await expireThrottle();
    await syncInhouseBoard();

    const status = await getInhouseBoardStatus();
    expect(status.failures).toBe(2);
    expect(status.lastEdit).toBeNull(); // never succeeded
    expect(status.inSync).toBe(false); // and it says the board is behind
  });

  it("clears the failure count once an edit lands", async () => {
    await postedBoardWithAChange();
    mockPatch.mockResolvedValue("failed");
    await syncInhouseBoard();
    expect((await getInhouseBoardStatus()).failures).toBe(1);

    mockPatch.mockResolvedValue("ok");
    await expireThrottle();
    await syncInhouseBoard();
    const status = await getInhouseBoardStatus();
    expect(status.failures).toBe(0);
    expect(status.inSync).toBe(true);
  });

  it("shows what the queue actually is, so a lying board is visible", async () => {
    await enqueue(3);
    await createInhouseBoard();
    expect((await getInhouseBoardStatus()).liveState).toBe("3/10 queued");

    await enqueue(2, "more");
    const status = await getInhouseBoardStatus();
    expect(status.liveState).toBe("5/10 queued");
    expect(status.inSync).toBe(false); // board still says 3
  });

  it("does not resurrect a board removed while an edit was in flight", async () => {
    await postedBoardWithAChange();
    // The admin hits Remove during the (up to 2.5s) PATCH round trip.
    mockPatch.mockImplementation(async () => {
      await setSetting(SETTING_KEYS.INHOUSE_BOARD, "");
      return "ok";
    });

    await syncInhouseBoard();
    expect(await boardRow()).toBeNull();
  });
});

describe("inhouse board — removal is honest", () => {
  it("keeps the board when Discord refused the delete, so it can be retried", async () => {
    await createInhouseBoard();
    mockDelete.mockResolvedValue(false);

    const res = await removeInhouseBoard();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/still live|try again/i);
    // Still tracked — better a board that keeps updating than a frozen orphan.
    expect(await boardRow()).not.toBeNull();
  });

  it("forces the teardown when the credential is about to change, and says it's orphaned", async () => {
    await createInhouseBoard();
    mockDelete.mockResolvedValue(false);

    const res = await removeInhouseBoard({ force: true });
    expect(res).toMatchObject({ ok: true, orphaned: true });
    expect(await boardRow()).toBeNull();
  });

  it("never pretends to delete a stranded board it cannot reach", async () => {
    await createInhouseBoard();
    mockHook.mockResolvedValue(OTHER_HOOK);

    const res = await removeInhouseBoard();
    // The delete endpoint is scoped to the sending webhook, so it would 404 —
    // which the transport reads as success. Don't route through it at all.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, orphaned: true });
    expect(await boardRow()).toBeNull();
  });

  it("reports a clean removal as clean", async () => {
    await createInhouseBoard();
    expect(await removeInhouseBoard()).toEqual({ ok: true, orphaned: false });
  });

  it("does not erase a newer board recorded while the old message is deleting", async () => {
    await createInhouseBoard();
    const replacement = JSON.stringify({
      webhookId: "11111",
      messageId: "1379009999999999999",
      digest: "replacement",
    });
    mockDelete.mockImplementation(async () => {
      await setSetting(SETTING_KEYS.INHOUSE_BOARD, replacement);
      return true;
    });

    await expect(removeInhouseBoard()).resolves.toEqual({
      ok: true,
      orphaned: false,
    });
    expect(await boardRow()).toBe(replacement);
  });
});

describe("inhouse board — wiring into the sitewide sync", () => {
  // The board is only as fresh as the code that calls it. These pin the two
  // hooks in syncInhouse (result-sync-service) that CLAUDE.md records as
  // invariants — both were previously deletable with the suite still green.

  it("repaints from a page view when the queue is empty and no lobby is up", async () => {
    // The state nothing else observes: resolvers are skipped and nobody is
    // polling the room, so this early-return branch is the only repaint.
    await enqueue(4);
    await createInhouseBoard();
    await expireThrottle();

    await prisma.inhouseQueueEntry.deleteMany({});
    await runResultSync();

    expect(mockPatch).toHaveBeenCalledTimes(1);
    const [, , payload] = mockPatch.mock.calls[0];
    expect((payload.embeds as { title: string }[])[0].title).toContain(
      "slots open",
    );
  });

  it("repaints from a page view while a queue is filling", async () => {
    await enqueue(3);
    await createInhouseBoard();
    await expireThrottle();

    await enqueue(2, "more");
    await runResultSync();

    expect(mockPatch).toHaveBeenCalledTimes(1);
    const [, , payload] = mockPatch.mock.calls[0];
    expect((payload.embeds as { title: string }[])[0].title).toContain(
      "5 / 10",
    );
  });

  it("tells parked clients to poll fast while a queue is FILLING, not just during a lobby", async () => {
    // Without this, sitewide pingers idled at IDLE_POLL_SECONDS (300) for the
    // whole fill — the stretch that decides whether a game happens.
    expect((await runResultSync()).watch).toBe(false);
    await enqueue(2);
    expect((await runResultSync()).watch).toBe(true);
  });

  it("does not hold every client at the fast cadence for a ghost row", async () => {
    const u = await makeUser("ghost");
    await prisma.inhouseQueueEntry.create({
      data: {
        userId: u.id,
        mmr: 3000,
        lastSeenAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    expect((await runResultSync()).watch).toBe(false);
  });
});

describe("inhouse board — removal", () => {
  it("deletes the message and turns the feature off", async () => {
    await createInhouseBoard();
    await removeInhouseBoard();
    expect(mockDelete).toHaveBeenCalledWith(HOOK, MSG_ID);
    expect(await boardRow()).toBeNull();

    await expireThrottle();
    await syncInhouseBoard();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("is safe to call when no board exists", async () => {
    await expect(removeInhouseBoard()).resolves.toEqual({ ok: true });
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("board — posting is claimed BEFORE Discord, not after", () => {
  it("a double submit posts ONE board, never two", async () => {
    // The "already posted in that channel" check sits a multi-second Discord
    // round trip away from the write that records the message id. Without a
    // reservation taken first, two concurrent posts both send and the second
    // setSetting overwrites the first's id — orphaning a board that is pinned
    // in Discord, un-editable and un-deletable, with the next "Post" adding a
    // THIRD beside it.
    mockHook.mockResolvedValue(HOOK);
    mockPost.mockClear();

    const res = await raceN(3, () => createInhouseBoard());
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    // The decisive assertion: exactly one message reached Discord.
    expect(mockPost).toHaveBeenCalledTimes(1);

    const row = await prisma.setting.findUnique({
      where: { key: SETTING_KEYS.INHOUSE_BOARD },
    });
    expect(JSON.parse(row!.value).messageId).toBe(MSG_ID);
  });
});

// ---------------------------------------------------------------------------
// The two COMPARE-AND-SWAPs on the board row. Both re-assert, at the write,
// something read before a Discord round trip — and both are invisible to a
// staged test, because the read-time checks in front of them catch anything
// that landed EARLIER. What has to be produced is the rival landing in the gap:
// after the check, before the write. One of them has no natural gap at all (two
// adjacent queries), so the service yields at a labelled seam instead
// (src/lib/race-hook.ts); the other's gap is the PATCH itself, which the
// transport mock already stands in for.
//
// Both run on SQLite too: no transaction is open at either point, so the
// rival has no lock to block on.
// ---------------------------------------------------------------------------
describe("board — the row is claimed by compare-and-swap, not by a stale read", () => {
  afterEach(() => setRaceHook(null));

  it("an edit in flight never clobbers a board that was removed AND re-posted", async () => {
    await enqueue(3);
    await createInhouseBoard(); // board #1
    await expireThrottle();
    await enqueue(1, "z"); // the digest moves, so this poll will PATCH

    const NEW_MSG = "1379009876543210987";
    // The admin removes the board and posts a fresh one during the (up to
    // 2.5s) round trip. The row that comes back is a DIFFERENT board — not the
    // empty row a plain Remove leaves, which an updateMany cannot resurrect
    // anyway. This is the shape that actually needs the guard.
    mockPatch.mockImplementation(async () => {
      await removeInhouseBoard();
      mockPost.mockResolvedValueOnce({ id: NEW_MSG });
      await createInhouseBoard();
      return "ok";
    });

    await syncInhouseBoard();

    // Still describing the message that is actually pinned in Discord. Writing
    // the old state back would point the row at a DELETED message — the next
    // poll 404s, reads that as "gone", and turns the feature off — while the
    // board the admin just posted is left pinned with nothing tracking it.
    const row = JSON.parse((await boardRow())!);
    expect(row.messageId).toBe(NEW_MSG);
  });

  it("stands down when a rival claims the row first, instead of posting a second board", async () => {
    // A settled board in the OLD channel. The webhook has since been pointed
    // somewhere else, so taking that row over is legitimate — this is the one
    // case the read-time checks let through.
    await enqueue(3);
    mockHook.mockResolvedValue(OTHER_HOOK);
    await createInhouseBoard();
    mockHook.mockResolvedValue(HOOK);
    mockPost.mockClear();

    const RIVAL_MSG = "1379005555555555555";
    let fired = false;
    setRaceHook(
      onceAt("inhouseBoard.claimBoardRow.beforeTakeover", async () => {
        fired = true;
        // A second admin's "Post queue board" gets there first and COMPLETES —
        // so the row this caller read a moment ago is now a live board in the
        // channel it was about to post into.
        mockPost.mockResolvedValueOnce({ id: RIVAL_MSG });
        await createInhouseBoard();
      }),
    );

    const res = await createInhouseBoard();
    expect(fired).toBe(true); // the seam was reached — not a vacuous pass
    expect(res.ok).toBe(false);
    // The decisive assertion: exactly ONE message reached Discord. Taking the
    // rival's row over sends a second one, and the row can only ever track one
    // of them — the other is pinned forever, un-editable and un-deletable.
    expect(mockPost).toHaveBeenCalledTimes(1);
    const row = JSON.parse((await boardRow())!);
    expect(row.messageId).toBe(RIVAL_MSG);
  });
});
