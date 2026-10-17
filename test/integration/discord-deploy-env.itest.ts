import { createServer, type Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  deleteWebhookMessage,
  deliverPendingLeagueAnnouncements,
  patchWebhookMessage,
  postWebhookMessage,
  sendDiscordMessage,
} from "@/lib/discord";
import { SETTING_KEYS, setSetting } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import {
  enqueueLeagueAnnouncement,
  LEAGUE_ANNOUNCEMENT_STATUS,
} from "@/lib/league-announcement-outbox";

// The self-hosted Discord gate over REAL HTTP. A rehearsal or on-demand copy
// of a league runs with `LEAGUE_DEPLOY_ENV=staging` against a restored copy of
// production data, and that data can still hold a live webhook. The unit test
// proves the predicate; this proves every webhook path actually consults it,
// by pointing the league's webhook at a loopback stand-in for Discord and
// counting what reaches it. The positive control (`production` delivers)
// keeps "nothing arrived" from passing because the stand-in was unreachable.

type Recorded = { method: string; url: string };

let server: Server;
let base: string;
let recorded: Recorded[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      recorded.push({ method: req.method ?? "", url: req.url ?? "" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "1379001234567890123" }));
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
  vi.stubEnv("VERCEL_ENV", undefined);
  recorded = [];
  // resetDb() in setup.ts has already wiped Settings; point the real
  // getWebhookUrl() at the stand-in the same way an admin would.
  await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, hookUrl());
});

afterEach(() => vi.unstubAllEnvs());

function hookUrl() {
  return `${base}/api/webhooks/1111/tok-secret`;
}

const MSG = "1379001234567890123";

describe("Discord writes on a self-hosted staging deployment", () => {
  it("makes no webhook request and enqueues nothing", async () => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "staging");

    expect(await sendDiscordMessage("Rehearsal event")).toBe(false);
    expect(
      await sendDiscordMessage("Rehearsal event", undefined, { durable: false }),
    ).toBe(false);
    expect(await postWebhookMessage(hookUrl(), { content: "board" })).toBeNull();
    expect(await patchWebhookMessage(hookUrl(), MSG, { content: "board" })).toBe(
      "failed",
    );
    expect(await deleteWebhookMessage(hookUrl(), MSG)).toBe(false);

    expect(await prisma.leagueAnnouncement.count()).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it("leaves outbox work copied from production pending and unsent", async () => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "staging");
    const queued = await enqueueLeagueAnnouncement({
      content: "Copied pending production event",
    });

    await expect(deliverPendingLeagueAnnouncements({ limit: 1 })).resolves.toEqual({
      attempted: 0,
      delivered: 0,
      pending: true,
      blocked: "DISCORD_MUTATIONS_DISABLED",
    });
    expect(
      await prisma.leagueAnnouncement.findUnique({ where: { id: queued.id } }),
    ).toMatchObject({ status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING, attempts: 0 });
    expect(recorded).toHaveLength(0);
  });

  it("fails closed for a declared value that is not exactly production", async () => {
    for (const value of ["", "prod", "Production"]) {
      vi.stubEnv("LEAGUE_DEPLOY_ENV", value);
      expect(await postWebhookMessage(hookUrl(), { content: "board" })).toBeNull();
    }
    expect(recorded).toHaveLength(0);
  });

  it("delivers once the deployment declares production (positive control)", async () => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "production");

    expect(await sendDiscordMessage("Live event")).toBe(true);
    expect(await postWebhookMessage(hookUrl(), { content: "board" })).toEqual({
      id: MSG,
    });

    expect(recorded.map((r) => r.method)).toEqual(["POST", "POST"]);
    expect(
      recorded.every((r) => r.url.startsWith("/api/v10/webhooks/1111/")),
    ).toBe(true);
  });
});
