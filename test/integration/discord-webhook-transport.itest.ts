import { createServer, type Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
// The real `after` (it throws outside a request scope, which is every test
// here), wrapped so one test can capture the task a request would run after
// its response.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn(actual.after) };
});
import { after } from "next/server";
import {
  deleteNewsFromDiscord,
  deleteWebhookMessage,
  deliverPendingLeagueAnnouncements,
  draftLiveAnnouncementGroup,
  editNewsOnDiscord,
  patchWebhookMessage,
  postNewsToDiscord,
  postWebhookMessage,
  sendDiscordMessage,
} from "@/lib/discord";
import { SETTING_KEYS, setSetting } from "@/lib/settings";
import { createInhouseBoard } from "@/lib/inhouse-board-service";
import { getInhouseState, joinQueue } from "@/lib/inhouse-service";
import { makeUser, sessionFor } from "./factories";
import { prisma } from "@/lib/prisma";
import {
  enqueueLeagueAnnouncement,
  expireLeagueAnnouncementGroup,
  LEAGUE_ANNOUNCEMENT_STATUS,
  resumeLeagueAnnouncements,
} from "@/lib/league-announcement-outbox";

// The queue board's transport, exercised over REAL HTTP against a stand-in for
// Discord. Module mocks can prove the service's decisions but not the wire
// format, and every one of these details is a silent failure if wrong:
//
//  * `?wait=true` on the POST — without it Discord answers 204 with no body,
//    there is no message id, and the message can never be edited again.
//  * the PATCH path (`…/messages/{id}`) and the v10 pin.
//  * `allowed_mentions` on the PATCH as well as the POST. Discord rebuilds a
//    message's mentions from scratch on every edit using DEFAULT allowances,
//    ignoring what the original send asked for — so a board carrying a Steam
//    persona of "@everyone" would mass-ping the server on its next repaint.
//  * which HTTP statuses are permanent (stop) vs transient (retry).

type Recorded = {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
};

let server: Server;
let base: string;
let recorded: Recorded[] = [];
/** Set per-test to control what the fake Discord answers. */
let respond: (r: Recorded) => { status: number; body?: unknown; delayMs?: number };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      const entry = { method: req.method ?? "", url: req.url ?? "", body };
      recorded.push(entry);
      const out = respond(entry);
      const send = () => {
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body ?? {}));
      };
      if (out.delayMs) setTimeout(send, out.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  delete process.env.VERCEL_ENV;
  recorded = [];
  respond = () => ({ status: 200, body: { id: "1379001234567890123" } });
  // resetDb() in setup.ts has already wiped Settings; point the real
  // getWebhookUrl() at our stand-in the same way an admin would.
  await setSetting(
    SETTING_KEYS.DISCORD_WEBHOOK_URL,
    `${base}/api/webhooks/1111/tok-secret`,
  );
});

/** The webhook the service would resolve — tests call the transport directly. */
function hookUrl() {
  return `${base}/api/webhooks/1111/tok-secret`;
}

describe("sendDiscordMessage", () => {
  const USER_ID = "123456789012345678";
  const ROLE_ID = "223456789012345678";

  it("persists first, then materializes its allowlist into real mentions", async () => {
    expect(
      await sendDiscordMessage("Captain, please respond.", {
        users: [USER_ID, USER_ID],
        roles: [ROLE_ID],
      }),
    ).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].body).toMatchObject({
      content: `<@${USER_ID}> <@&${ROLE_ID}> Captain, please respond.`,
      allowed_mentions: {
        parse: [],
        users: [USER_ID],
        roles: [ROLE_ID],
      },
    });
    expect(await prisma.leagueAnnouncement.findFirst()).toMatchObject({
      content: "Captain, please respond.",
      status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
      attempts: 1,
    });
  });

  it("returns durable acceptance when Discord is down, then the wrapper retries", async () => {
    respond = () => ({ status: 503 });
    expect(await sendDiscordMessage("Durable result")).toBe(true);
    const pending = await prisma.leagueAnnouncement.findFirstOrThrow();
    expect(pending).toMatchObject({
      content: "Durable result",
      status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
      attempts: 1,
      // The status code, never the response body or the webhook URL.
      lastErrorCode: "DISCORD_503",
    });
    // The bearer credential and arbitrary transport response are never stored.
    expect(JSON.stringify(pending)).not.toContain("tok-secret");

    respond = () => ({ status: 204 });
    await expect(
      deliverPendingLeagueAnnouncements({
        now: new Date(pending.availableAt.getTime() + 1),
        limit: 1,
      }),
    ).resolves.toEqual({ attempted: 1, delivered: 1, pending: false });
  });

  it("pauses on a deleted webhook and resumes on the next one, in order", async () => {
    // Discord answers 404 (Unknown Webhook) once the webhook is deleted.
    respond = () => ({ status: 404, body: { code: 10015 } });
    expect(await sendDiscordMessage("Reschedule proposed")).toBe(true);
    expect(await sendDiscordMessage("Reschedule accepted")).toBe(true);
    // One request: the second post waits behind the paused first.
    expect(recorded).toHaveLength(1);
    expect(
      await prisma.leagueAnnouncement.findMany({
        orderBy: { createdAt: "asc" },
        select: { status: true, lastErrorCode: true },
      }),
    ).toEqual([
      { status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING, lastErrorCode: "DISCORD_404" },
      { status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING, lastErrorCode: null },
    ]);

    respond = () => ({ status: 204 });
    await setSetting(
      SETTING_KEYS.DISCORD_WEBHOOK_URL,
      `${base}/api/webhooks/2222/new-secret`,
    );
    expect(await resumeLeagueAnnouncements()).toBe(2);
    await deliverPendingLeagueAnnouncements({ limit: 2 });
    expect(recorded.slice(1).map((r) => [r.url, r.body?.content])).toEqual([
      ["/api/v10/webhooks/2222/new-secret", "Reschedule proposed"],
      ["/api/v10/webhooks/2222/new-secret", "Reschedule accepted"],
    ]);
  });

  it("skips a post Discord refuses (400) instead of blocking the queue", async () => {
    respond = (r) =>
      r.body?.content === "Malformed" ? { status: 400 } : { status: 204 };
    expect(await sendDiscordMessage("Malformed")).toBe(true);
    expect(await sendDiscordMessage("Next result")).toBe(true);
    expect(recorded.map((r) => r.body?.content)).toEqual([
      "Malformed",
      "Next result",
    ]);
    expect(
      await prisma.leagueAnnouncement.findMany({
        orderBy: { createdAt: "asc" },
        select: { status: true, lastErrorCode: true },
      }),
    ).toEqual([
      {
        status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
        lastErrorCode: "DISCORD_400",
      },
      { status: LEAGUE_ANNOUNCEMENT_STATUS.SENT, lastErrorCode: null },
    ]);
  });

  it("drops a live-draft post still waiting when the draft ends", async () => {
    respond = () => ({ status: 503 });
    const group = draftLiveAnnouncementGroup("season-1");
    expect(
      await sendDiscordMessage("The draft is LIVE", undefined, {
        expiryGroup: group,
      }),
    ).toBe(true);
    const queued = await prisma.leagueAnnouncement.findFirstOrThrow();
    expect(queued.dedupeKey?.startsWith(group)).toBe(true);

    expect(await expireLeagueAnnouncementGroup(group)).toBe(1);
    respond = () => ({ status: 204 });
    await deliverPendingLeagueAnnouncements({
      now: new Date(queued.availableAt.getTime() + 60_000),
      limit: 1,
    });
    expect(recorded).toHaveLength(1);
    expect(await prisma.leagueAnnouncement.findFirstOrThrow()).toMatchObject({
      status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
      lastErrorCode: "EXPIRED",
    });
  });

  it("supports a true direct transport check without creating outbox work", async () => {
    respond = () => ({ status: 503 });
    expect(
      await sendDiscordMessage("Webhook health check", undefined, {
        durable: false,
      }),
    ).toBe(false);
    expect(await prisma.leagueAnnouncement.count()).toBe(0);

    respond = () => ({ status: 204 });
    expect(
      await sendDiscordMessage("Webhook health check", undefined, {
        durable: false,
      }),
    ).toBe(true);
    expect(await prisma.leagueAnnouncement.count()).toBe(0);
  });

  it("passes a stable dedupe key through the durable boundary", async () => {
    const options = { dedupeKey: "match-result:match-42:2-0" };
    expect(await sendDiscordMessage("Final 2–0", undefined, options)).toBe(true);
    expect(await sendDiscordMessage("Final 2–0", undefined, options)).toBe(true);
    expect(await prisma.leagueAnnouncement.count()).toBe(1);
    expect(recorded).toHaveLength(1);
    expect(await prisma.leagueAnnouncement.findFirst()).toMatchObject(options);
  });

  it("returns false and persists nothing when no league webhook exists", async () => {
    const previous = process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, "");
    try {
      expect(await sendDiscordMessage("Nowhere to send")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DISCORD_WEBHOOK_URL;
      else process.env.DISCORD_WEBHOOK_URL = previous;
    }
    expect(await prisma.leagueAnnouncement.count()).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it("does not enqueue, claim, or send Discord work from a Vercel preview", async () => {
    process.env.VERCEL_ENV = "preview";

    expect(await sendDiscordMessage("Preview-only event")).toBe(false);
    expect(await prisma.leagueAnnouncement.count()).toBe(0);

    const queued = await enqueueLeagueAnnouncement({
      content: "Copied pending production event",
    });
    await expect(
      deliverPendingLeagueAnnouncements({ limit: 1 }),
    ).resolves.toEqual({
      attempted: 0,
      delivered: 0,
      pending: true,
      blocked: "DISCORD_MUTATIONS_DISABLED",
    });
    expect(await prisma.leagueAnnouncement.findUnique({ where: { id: queued.id } }))
      .toMatchObject({
        status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
        attempts: 0,
      });
    expect(recorded).toHaveLength(0);
  });

  it("reports durable work as blocked when its webhook is removed", async () => {
    await enqueueLeagueAnnouncement({ content: "Already accepted" });
    const previous = process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, "");
    try {
      await expect(deliverPendingLeagueAnnouncements({ limit: 1 })).resolves.toEqual({
        attempted: 0,
        delivered: 0,
        pending: true,
        blocked: "WEBHOOK_UNAVAILABLE",
      });
    } finally {
      if (previous === undefined) delete process.env.DISCORD_WEBHOOK_URL;
      else process.env.DISCORD_WEBHOOK_URL = previous;
    }
    expect(recorded).toHaveLength(0);
  });

  it("afterResponse queues the post and leaves Discord for after the response", async () => {
    // Inside a request, after() takes the delivery attempt: the request that
    // queued the posts returns before Discord is contacted at all.
    const scheduled: (() => Promise<unknown>)[] = [];
    vi.mocked(after)
      .mockImplementationOnce((task) => {
        scheduled.push(task as () => Promise<unknown>);
      })
      .mockImplementationOnce((task) => {
        scheduled.push(task as () => Promise<unknown>);
      });
    respond = () => ({ status: 204, delayMs: 50 });

    expect(
      await sendDiscordMessage("Teams post", undefined, { afterResponse: true }),
    ).toBe(true);
    expect(
      await sendDiscordMessage("Recap post", undefined, { afterResponse: true }),
    ).toBe(true);
    expect(recorded).toHaveLength(0);
    expect(
      await prisma.leagueAnnouncement.findMany({
        orderBy: { createdAt: "asc" },
        select: { content: true, status: true, attempts: true },
      }),
    ).toEqual([
      { content: "Teams post", status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING, attempts: 0 },
      { content: "Recap post", status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING, attempts: 0 },
    ]);

    // after() runs its tasks concurrently. The queue still delivers both, in
    // order, without leaving the second post for the minute worker.
    expect(scheduled).toHaveLength(2);
    await Promise.all(scheduled.map((task) => task()));
    expect(recorded.map((r) => r.body?.content)).toEqual([
      "Teams post",
      "Recap post",
    ]);
    expect(
      await prisma.leagueAnnouncement.count({
        where: { status: LEAGUE_ANNOUNCEMENT_STATUS.SENT },
      }),
    ).toBe(2);
  });

  it("afterResponse outside a request delivers inline, like a plain send", async () => {
    expect(
      await sendDiscordMessage("Worker post", undefined, { afterResponse: true }),
    ).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(await prisma.leagueAnnouncement.findFirst()).toMatchObject({
      content: "Worker post",
      status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
    });
  });

  it("afterResponse keeps the post queued when the late attempt fails", async () => {
    let scheduled: (() => Promise<unknown>) | null = null;
    vi.mocked(after).mockImplementationOnce((task) => {
      scheduled = task as () => Promise<unknown>;
    });
    respond = () => ({ status: 503 });

    expect(
      await sendDiscordMessage("Durable draft post", undefined, {
        afterResponse: true,
      }),
    ).toBe(true);
    await scheduled!();
    const pending = await prisma.leagueAnnouncement.findFirstOrThrow();
    expect(pending).toMatchObject({
      content: "Durable draft post",
      status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
      attempts: 1,
      lastErrorCode: "DISCORD_503",
    });

    // The worker's drain picks it up once Discord is back.
    respond = () => ({ status: 204 });
    await expect(
      deliverPendingLeagueAnnouncements({
        now: new Date(pending.availableAt.getTime() + 1),
        limit: 1,
      }),
    ).resolves.toEqual({ attempted: 1, delivered: 1, pending: false });
  });

  it("rejects invalid payloads and persistence failures before webhook I/O", async () => {
    expect(await sendDiscordMessage("   ")).toBe(false);
    expect(await sendDiscordMessage("x".repeat(2_001))).toBe(false);
    expect(
      await sendDiscordMessage("x".repeat(1_980), { users: [USER_ID] }),
    ).toBe(false);

    const create = vi
      .spyOn(prisma.leagueAnnouncement, "create")
      .mockRejectedValueOnce(new Error("database unavailable"));
    try {
      expect(await sendDiscordMessage("Cannot persist")).toBe(false);
    } finally {
      create.mockRestore();
    }
    expect(recorded).toHaveLength(0);
    expect(await prisma.leagueAnnouncement.count()).toBe(0);
  });
});

/** Let the board's spam floor lapse without waiting out real seconds. */
async function expireThrottle() {
  await setSetting(
    SETTING_KEYS.INHOUSE_BOARD_AT,
    new Date(Date.now() - 3600_000).toISOString(),
  );
}

describe("postWebhookMessage", () => {
  it("asks for the message back with ?wait=true and returns its id", async () => {
    const res = await postWebhookMessage(hookUrl(), { embeds: [{ title: "hi" }] });
    expect(res).toEqual({ id: "1379001234567890123" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("/api/v10/webhooks/1111/tok-secret?wait=true");
  });

  it("suppresses every mention on the way in", async () => {
    await postWebhookMessage(hookUrl(), { embeds: [{ title: "@everyone" }] });
    expect(recorded[0].body?.allowed_mentions).toEqual({ parse: [] });
  });

  it("returns null when Discord answers without a usable id", async () => {
    respond = () => ({ status: 200, body: {} });
    expect(await postWebhookMessage(hookUrl(), { content: "x" })).toBeNull();
  });

  it("returns null on a rejected post rather than throwing", async () => {
    respond = () => ({ status: 400, body: { message: "nope" } });
    expect(await postWebhookMessage(hookUrl(), { content: "x" })).toBeNull();
  });
});

describe("patchWebhookMessage", () => {
  const MSG = "1379001234567890123";

  it("edits the right message on the versioned path", async () => {
    expect(await patchWebhookMessage(hookUrl(), MSG, { embeds: [{ title: "n" }] })).toBe(
      "ok",
    );
    expect(recorded[0].method).toBe("PATCH");
    expect(recorded[0].url).toBe(
      `/api/v10/webhooks/1111/tok-secret/messages/${MSG}`,
    );
  });

  it("RE-suppresses mentions on every edit — Discord re-parses them from scratch", async () => {
    await patchWebhookMessage(hookUrl(), MSG, {
      embeds: [{ description: "In queue: @everyone" }],
    });
    expect(recorded[0].body?.allowed_mentions).toEqual({ parse: [] });
  });

  it("treats a deleted message as permanent, so it stops trying", async () => {
    respond = () => ({ status: 404, body: { code: 10008 } });
    expect(await patchWebhookMessage(hookUrl(), MSG, { content: "x" })).toBe("gone");
  });

  it("treats a revoked or rotated token as permanent too", async () => {
    respond = () => ({ status: 401, body: { code: 50027 } });
    expect(await patchWebhookMessage(hookUrl(), MSG, { content: "x" })).toBe("gone");
    respond = () => ({ status: 403, body: {} });
    expect(await patchWebhookMessage(hookUrl(), MSG, { content: "x" })).toBe("gone");
  });

  it("treats rate limits and outages as transient, so the next poll retries", async () => {
    respond = () => ({ status: 429, body: { retry_after: 1.5 } });
    expect(await patchWebhookMessage(hookUrl(), MSG, { content: "x" })).toBe("failed");
    respond = () => ({ status: 500, body: {} });
    expect(await patchWebhookMessage(hookUrl(), MSG, { content: "x" })).toBe("failed");
  });

  it("gives up quickly instead of hanging the inhouse poll", async () => {
    respond = () => ({ status: 200, delayMs: 4000 });
    const started = Date.now();
    expect(await patchWebhookMessage(hookUrl(), MSG, { content: "x" })).toBe("failed");
    expect(Date.now() - started).toBeLessThan(3500);
  }, 10_000);

  it("reports a transient failure when the host is unreachable, never throws", async () => {
    // The caller resolves the webhook now, so "no webhook" is the service's
    // guard (inhouse-board.itest) — what the transport still owes us is that a
    // dead host degrades to "failed" (retry later) instead of blowing up a poll.
    const dead = "http://127.0.0.1:1/api/webhooks/1111/tok";
    expect(await patchWebhookMessage(dead, MSG, { content: "x" })).toBe("failed");
    expect(recorded).toHaveLength(0);
  });
});

describe("the board over a real queue", () => {
  /** Every embed the fake Discord has been asked to render, in order. */
  const boards = () =>
    recorded
      .filter(
        (r) =>
          (r.method === "POST" || r.method === "PATCH") && !!r.body?.embeds,
      )
      .map(
        (r) =>
          (r.body?.embeds as { title: string; description: string }[])?.[0],
      )
      .filter(Boolean);

  it("tracks a queue filling up, with one message and no duplicates", async () => {
    await createInhouseBoard();
    expect(boards()[0].title).toContain("slots open");

    // Six players join for real, each followed by the poll their client would
    // make — which is what carries the board forward on the hot path.
    for (let i = 0; i < 6; i++) {
      const u = await makeUser(`queuer${i}`);
      expect((await joinQueue(sessionFor(u), 3000)).ok).toBe(true);
      await expireThrottle();
      await getInhouseState(sessionFor(u));
    }

    const seen = boards();
    // Exactly one BOARD post, ever — everything after it edits that message.
    // (Plain-content POSTs are the separate queue-filling ping, which is
    // supposed to be a real, notifying message.)
    expect(
      recorded.filter((r) => r.method === "POST" && r.body?.embeds),
    ).toHaveLength(1);
    expect(
      recorded
        .filter((r) => r.method === "PATCH")
        .every((r) => r.url.endsWith("/messages/1379001234567890123")),
    ).toBe(true);

    const last = seen[seen.length - 1];
    expect(last.title).toBe("Searching for Match — 6 / 10");
    expect(last.description).toContain("## Four more.");
    
    expect(last.description).toContain("[Take a slot →]");

    // Eyeball what the channel actually shows.
    console.log(`\n${last.title}\n${last.description}\n`);
  }, 20_000);

  it("goes quiet when nothing is happening", async () => {
    const u = await makeUser("idler");
    await joinQueue(sessionFor(u), 3000);
    await createInhouseBoard();
    const after = recorded.length;

    await expireThrottle();
    await getInhouseState(sessionFor(u));
    await expireThrottle();
    await getInhouseState(sessionFor(u));
    expect(recorded).toHaveLength(after); // not one request
  });

  it("costs nothing at all when the board was never posted", async () => {
    const u = await makeUser("nobody");
    await joinQueue(sessionFor(u), 3000);
    await getInhouseState(sessionFor(u));
    expect(recorded).toHaveLength(0);
  });
});

describe("deleteWebhookMessage", () => {
  it("deletes on the versioned message path", async () => {
    respond = () => ({ status: 204 });
    expect(await deleteWebhookMessage(hookUrl(), "42")).toBe(true);
    expect(recorded[0].method).toBe("DELETE");
    expect(recorded[0].url).toBe("/api/v10/webhooks/1111/tok-secret/messages/42");
  });

  it("counts an already-deleted message as success", async () => {
    respond = () => ({ status: 404, body: { code: 10008 } });
    expect(await deleteWebhookMessage(hookUrl(), "42")).toBe(true);
  });

  it("reports a real failure", async () => {
    respond = () => ({ status: 500 });
    expect(await deleteWebhookMessage(hookUrl(), "42")).toBe(false);
  });
});

// League news keeps its Discord message id so edits and deletes reach the
// copy, and pings @everyone only when the admin ticked the box.
describe("news posts on the league webhook", () => {
  it("posts with ?wait=true on v10, keeps the id, and pings nobody by default", async () => {
    const res = await postNewsToDiscord("📣 **Week 3** @everyone @here", false);
    expect(res).toEqual({ ok: true, id: "1379001234567890123" });
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("/api/v10/webhooks/1111/tok-secret?wait=true");
    expect(recorded[0].body).toEqual({
      content: "📣 **Week 3** @everyone @here",
      allowed_mentions: { parse: [] },
    });
  });

  it("opens with @everyone and allows only that ping when the admin asked", async () => {
    await postNewsToDiscord("📣 **Week 3**", true);
    expect(recorded[0].body).toEqual({
      content: "@everyone\n📣 **Week 3**",
      allowed_mentions: { parse: ["everyone"] },
    });
  });

  it("reports a missing webhook apart from a failed post", async () => {
    respond = () => ({ status: 500 });
    expect(await postNewsToDiscord("x", false)).toEqual({
      ok: false,
      reason: "failed",
    });
    await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, "");
    const envWebhook = process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    try {
      expect(await postNewsToDiscord("x", false)).toEqual({
        ok: false,
        reason: "no-webhook",
      });
      expect(await editNewsOnDiscord("42", "x")).toBe("no-webhook");
      expect(await deleteNewsFromDiscord("42")).toBe("failed");
    } finally {
      if (envWebhook !== undefined) process.env.DISCORD_WEBHOOK_URL = envWebhook;
    }
    expect(recorded).toHaveLength(1);
  });

  it("edits in place without re-pinging, and deletes the copy", async () => {
    expect(await editNewsOnDiscord("42", "@everyone fixed")).toBe("ok");
    expect(recorded[0].method).toBe("PATCH");
    expect(recorded[0].url).toBe("/api/v10/webhooks/1111/tok-secret/messages/42");
    expect(recorded[0].body?.allowed_mentions).toEqual({ parse: [] });

    respond = () => ({ status: 204 });
    expect(await deleteNewsFromDiscord("42")).toBe("deleted");
    expect(recorded[1].method).toBe("DELETE");
    expect(recorded[1].url).toBe("/api/v10/webhooks/1111/tok-secret/messages/42");
  });

  it("reports a 404 as gone, not deleted: another webhook may have sent it", async () => {
    respond = () => ({ status: 404, body: { code: 10008 } });
    expect(await deleteNewsFromDiscord("42")).toBe("gone");
    respond = () => ({ status: 500 });
    expect(await deleteNewsFromDiscord("42")).toBe("failed");
  });
});
