import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import worker, {
  reportPass,
  SchedulerAlertState,
  type SchedulerEnv,
} from "../../ops/cloudflare-automation-worker/src/index";
import {
  ALERT_AFTER_FAILURES,
  EMPTY_ALERT_STATE,
  failureDetail,
  nextAlertStep,
  productionLeague,
  recordSchedulerEvent,
  schedulerAlertRule,
  type AlertState,
  type AlertStorage,
} from "../../ops/cloudflare-automation-worker/src/alerts";

const US_URL = "https://us.ggd2l.com/api/cron/automation";
const EU_URL = "https://eu.ggd2l.com/api/cron/automation";
const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789";
const OTHER_WEBHOOK = "https://discord.com/api/webhooks/223456789012345678/abcdefghijklmnopqrstuvwxyz0123456789";
const SECRET = "C8kP2vR7xM4qT9wL6nH3dF5sJ0yB1zUa";
const TIM = "112233445566778899";
// 2026-10-18 14:00Z: outside the 09:00Z reboot window.
const T0 = Date.UTC(2026, 9, 18, 14, 0);
const MINUTE = 60_000;
const RULE = schedulerAlertRule(T0);

function memoryStorage() {
  const data = new Map<string, unknown>();
  const writes: string[] = [];
  const storage: AlertStorage = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => {
      writes.push(key);
      data.set(key, structuredClone(value));
    },
  };
  return { storage, data, writes };
}

type Sent = { url: string; body: { content: string; allowed_mentions: { parse: unknown[]; users?: string[] } } };
function discord(status = 204) {
  const sent: Sent[] = [];
  let next = status;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: next });
  });
  return {
    fetcher: fetcher as unknown as typeof fetch,
    sent,
    setStatus: (code: number) => {
      next = code;
    },
  };
}

const fail = (at: number, detail = "HTTP 530: the tunnel to the box is down") => ({ ok: false, at, detail });
const pass = (at: number) => ({ ok: true, at });

function run(events: { ok: boolean; at: number; detail?: string }[], start: AlertState = EMPTY_ALERT_STATE) {
  let state = start;
  const posts: (string | null)[] = [];
  for (const event of events) {
    const step = nextAlertStep(state, event, schedulerAlertRule(event.at));
    posts.push(step.post);
    state = step.state;
  }
  return { state, posts };
}

describe("scheduler alert rules", () => {
  it("posts once after three failures in a row, then nothing while the league stays down", () => {
    const { posts, state } = run([0, 1, 2, 3, 4].map((i) => fail(T0 + i * MINUTE)));
    expect(ALERT_AFTER_FAILURES).toBe(3);
    expect(posts).toEqual([null, null, "down", null, null]);
    expect(state).toMatchObject({ failing: 5, alerted: true, since: T0, postedAt: T0 + 2 * MINUTE });
  });

  it("never alerts on failures that are not in a row", () => {
    const events = [fail(T0), fail(T0 + MINUTE), pass(T0 + 2 * MINUTE), fail(T0 + 3 * MINUTE), fail(T0 + 4 * MINUTE)];
    const { posts, state } = run(events);
    expect(posts.every((post) => post === null)).toBe(true);
    expect(state).toMatchObject({ failing: 2, since: T0 + 3 * MINUTE, alerted: false });
  });

  it("recovers only after two passes in a row, so a flapping league posts nothing more", () => {
    const down = [0, 1, 2].map((i) => fail(T0 + i * MINUTE));
    const flap = [pass(T0 + 3 * MINUTE), fail(T0 + 4 * MINUTE), pass(T0 + 5 * MINUTE), fail(T0 + 6 * MINUTE)];
    const back = [pass(T0 + 7 * MINUTE), pass(T0 + 8 * MINUTE), pass(T0 + 9 * MINUTE)];
    const { posts, state } = run([...down, ...flap, ...back]);
    expect(posts).toEqual([null, null, "down", null, null, null, null, null, "recovered", null]);
    expect(state).toEqual(EMPTY_ALERT_STATE);
  });

  it("reminds once a day while still failing", () => {
    const day = 24 * 60 * MINUTE;
    const events = [0, 1, 2].map((i) => fail(T0 + i * MINUTE));
    events.push(fail(T0 + 2 * MINUTE + day - MINUTE), fail(T0 + 2 * MINUTE + day), fail(T0 + 2 * MINUTE + day + MINUTE));
    expect(run(events).posts).toEqual([null, null, "down", null, "still-down", null]);
  });

  it("keeps the state a failed post would have changed, so the next run retries it", () => {
    const two = run([fail(T0), fail(T0 + MINUTE)]).state;
    const third = nextAlertStep(two, fail(T0 + 2 * MINUTE), RULE);
    expect(third.post).toBe("down");
    expect(third.ifPostFails.alerted).toBe(false);
    expect(nextAlertStep(third.ifPostFails, fail(T0 + 3 * MINUTE), RULE).post).toBe("down");

    const alerted = run([0, 1, 2, 3].map((i) => fail(T0 + i * MINUTE))).state;
    const once = nextAlertStep(alerted, pass(T0 + 4 * MINUTE), RULE).state;
    const twice = nextAlertStep(once, pass(T0 + 5 * MINUTE), RULE);
    expect(twice.post).toBe("recovered");
    expect(twice.ifPostFails.alerted).toBe(true);
    expect(nextAlertStep(twice.ifPostFails, pass(T0 + 6 * MINUTE), RULE).post).toBe("recovered");
  });

  it("waits out the 09:00 UTC reboot window, then applies the normal rule to the same streak", () => {
    const at = (minute: number) => Date.UTC(2026, 9, 18, 9, minute);
    expect(schedulerAlertRule(at(0)).after).toBe(10);
    expect(schedulerAlertRule(at(14)).after).toBe(10);
    expect(schedulerAlertRule(at(15)).after).toBe(3);
    expect(schedulerAlertRule(Date.UTC(2026, 9, 18, 8, 59)).after).toBe(3);
    // A four-minute reboot posts nothing.
    expect(run([1, 2, 3, 4].map((m) => fail(at(m)))).posts).toEqual([null, null, null, null]);
    // A longer outage alerts at its tenth failure inside the window ...
    expect(run([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((m) => fail(at(m)))).posts.at(-1)).toBe("down");
    // ... or at the first failure past it.
    expect(run([8, 9, 10, 11, 12, 13, 14, 15].map((m) => fail(at(m)))).posts).toEqual([
      null, null, null, null, null, null, null, "down",
    ]);
  });

  it("describes a failed pass only by its kind, never by its text", () => {
    expect(failureDetail(new Error("Automation returned HTTP 530"))).toBe("HTTP 530: the tunnel to the box is down");
    expect(failureDetail(new Error("Automation returned HTTP 418"))).toBe("HTTP 418");
    expect(failureDetail(new Error("Automation request failed"))).toMatch(/^no answer/);
    expect(failureDetail(new Error("AUTOMATION_SECRET must contain 32-512 non-whitespace characters"))).toBe(
      "an invalid AUTOMATION_SECRET in the Worker",
    );
    expect(failureDetail(new Error(`fetch failed for ${US_URL} using ${SECRET}`))).toBe("an unexpected error");
    expect(failureDetail("not an error")).toBe("an unexpected error");
  });

  it("alerts only for the two production routes", () => {
    expect(productionLeague(US_URL)).toBe("us");
    expect(productionLeague(EU_URL)).toBe("eu");
    for (const url of ["https://league.example/api/cron/automation", "https://us.ggd2l.com/api/cron/automation?x=1", undefined, ""]) {
      expect(productionLeague(url)).toBeNull();
    }
  });
});

describe("the alert state object", () => {
  const env = { AUTOMATION_URL: US_URL, ALERT_DISCORD_WEBHOOK_URL: WEBHOOK };

  it("says hello once per webhook, then posts the outage and the recovery, pinging nobody", async () => {
    const { storage } = memoryStorage();
    const out = discord();
    for (let i = 0; i < 3; i += 1) await recordSchedulerEvent(storage, env, fail(T0 + i * MINUTE), out.fetcher);
    await recordSchedulerEvent(storage, env, pass(T0 + 3 * MINUTE), out.fetcher);
    await recordSchedulerEvent(storage, env, pass(T0 + 4 * MINUTE), out.fetcher);

    expect(out.sent.map((s) => s.url)).toEqual([WEBHOOK, WEBHOOK, WEBHOOK]);
    const [hello, down, back] = out.sent.map((s) => s.body);
    expect(hello.content).toMatch(/^👋 Alerts are on for \*\*GGD2L US\*\*/);
    expect(down.content).toMatch(/^🔴 \*\*GGD2L US\*\* is failing: its last 3 scheduled runs in a row failed, since <t:\d+:f>\./);
    expect(down.content).toContain("Latest: HTTP 530: the tunnel to the box is down.");
    expect(back.content).toMatch(/^🟢 \*\*GGD2L US\*\* is back: 2 scheduled runs in a row passed\./);
    for (const body of [hello, down, back]) expect(body.allowed_mentions).toEqual({ parse: [] });

    // A new webhook (another channel) gets its own hello.
    await recordSchedulerEvent(storage, { ...env, ALERT_DISCORD_WEBHOOK_URL: OTHER_WEBHOOK }, pass(T0 + 5 * MINUTE), out.fetcher);
    expect(out.sent.at(-1)?.body.content).toMatch(/^👋/);
    expect(out.sent).toHaveLength(4);
  });

  it("writes nothing on a healthy minute once the hello is out", async () => {
    const { storage, writes } = memoryStorage();
    const out = discord();
    await recordSchedulerEvent(storage, env, pass(T0), out.fetcher);
    expect(writes).toEqual(["hello"]);
    for (let i = 1; i <= 5; i += 1) await recordSchedulerEvent(storage, env, pass(T0 + i * MINUTE), out.fetcher);
    expect(writes).toEqual(["hello"]);
    expect(out.sent).toHaveLength(1);
  });

  it("pings only the configured user, and only for a failure", async () => {
    const { storage } = memoryStorage();
    const out = discord();
    const pinging = { ...env, ALERT_PING_USER_ID: TIM };
    for (let i = 0; i < 3; i += 1) await recordSchedulerEvent(storage, pinging, fail(T0 + i * MINUTE), out.fetcher);
    for (let i = 3; i < 5; i += 1) await recordSchedulerEvent(storage, pinging, pass(T0 + i * MINUTE), out.fetcher);
    const [hello, down, back] = out.sent.map((s) => s.body);
    expect(hello.allowed_mentions).toEqual({ parse: [] });
    expect(down.content.startsWith(`<@${TIM}> 🔴`)).toBe(true);
    expect(down.allowed_mentions).toEqual({ parse: [], users: [TIM] });
    expect(back.allowed_mentions).toEqual({ parse: [] });
    expect(back.content).not.toContain("<@");

    // A malformed id pings nobody.
    const other = memoryStorage();
    const quiet = discord();
    for (let i = 0; i < 3; i += 1) {
      await recordSchedulerEvent(other.storage, { ...env, ALERT_PING_USER_ID: "@everyone" }, fail(T0 + i * MINUTE), quiet.fetcher);
    }
    expect(quiet.sent.at(-1)?.body.allowed_mentions).toEqual({ parse: [] });
    expect(quiet.sent.at(-1)?.body.content).not.toContain("everyone");
  });

  it("retries a post Discord refused at the next run", async () => {
    const { storage } = memoryStorage();
    const out = discord();
    await recordSchedulerEvent(storage, env, pass(T0), out.fetcher);
    await recordSchedulerEvent(storage, env, fail(T0 + MINUTE), out.fetcher);
    await recordSchedulerEvent(storage, env, fail(T0 + 2 * MINUTE), out.fetcher);
    out.setStatus(500);
    expect(await recordSchedulerEvent(storage, env, fail(T0 + 3 * MINUTE), out.fetcher)).toEqual({ posted: "down", delivered: false });
    out.setStatus(204);
    expect(await recordSchedulerEvent(storage, env, fail(T0 + 4 * MINUTE), out.fetcher)).toEqual({ posted: "down", delivered: true });
    expect(await recordSchedulerEvent(storage, env, fail(T0 + 5 * MINUTE), out.fetcher)).toEqual({ posted: null, delivered: false });
    expect(out.sent.filter((s) => s.body.content.startsWith("🔴"))).toHaveLength(2);
  });

  it("escapes the detail it posts", async () => {
    const { storage } = memoryStorage();
    const out = discord();
    for (let i = 0; i < 3; i += 1) {
      await recordSchedulerEvent(storage, env, fail(T0 + i * MINUTE, "[click](https://evil.test) @everyone"), out.fetcher);
    }
    const down = out.sent.at(-1)!.body.content;
    expect(down).toContain("\\[click\\]\\(https:\u200b//evil.test\\) \\@everyone");
    expect(down).not.toContain("[click](");
  });

  it("does nothing off the production routes or without a valid webhook", async () => {
    for (const bad of [
      { AUTOMATION_URL: "https://league.example/api/cron/automation", ALERT_DISCORD_WEBHOOK_URL: WEBHOOK },
      { AUTOMATION_URL: US_URL },
      { AUTOMATION_URL: US_URL, ALERT_DISCORD_WEBHOOK_URL: "https://evil.test/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz" },
      { AUTOMATION_URL: US_URL, ALERT_DISCORD_WEBHOOK_URL: `${WEBHOOK}?wait=true` },
    ]) {
      const { storage, writes } = memoryStorage();
      const out = discord();
      for (let i = 0; i < 4; i += 1) await recordSchedulerEvent(storage, bad, fail(T0 + i * MINUTE), out.fetcher);
      expect(out.sent).toEqual([]);
      expect(writes).toEqual([]);
    }
  });

  it("takes one event at a time and refuses anything that is not one", async () => {
    const { storage } = memoryStorage();
    const out = discord();
    let blocked = 0;
    const blockConcurrencyWhile = <T,>(callback: () => Promise<T>): Promise<T> => {
      blocked += 1;
      return callback();
    };
    const object = new SchedulerAlertState({ storage, blockConcurrencyWhile }, env, out.fetcher);
    const post = (body: unknown, method = "POST") =>
      object.fetch(new Request("https://alert-state/event", { method, body: method === "POST" ? JSON.stringify(body) : undefined }));
    expect((await post({ ok: true, at: T0 }, "GET")).status).toBe(405);
    for (const bad of [null, { ok: "yes", at: T0 }, { ok: false, at: -1 }, { ok: false, at: T0, detail: "x".repeat(201) }]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(blocked).toBe(0);
    const response = await post({ ok: true, at: T0 });
    expect(await response.json()).toEqual({ posted: "hello", delivered: true });
    expect(blocked).toBe(1);
  });
});

describe("the scheduled handler", () => {
  function namespace(respond: () => Promise<Response> = async () => Response.json({ posted: null, delivered: false })) {
    const events: unknown[] = [];
    const names: string[] = [];
    const ns = {
      idFromName: (name: string) => {
        names.push(name);
        return `id:${name}`;
      },
      get: () => ({
        fetch: async (_input: string, init?: RequestInit) => {
          events.push(JSON.parse(String(init?.body)));
          return respond();
        },
      }),
    };
    return { ns, events, names };
  }
  const baseEnv = (ns: SchedulerEnv["ALERT_STATE"], extra: Partial<SchedulerEnv> = {}): SchedulerEnv => ({
    AUTOMATION_URL: US_URL,
    AUTOMATION_SECRET: SECRET,
    AUTOMATION_PAUSED: "false",
    ALERT_DISCORD_WEBHOOK_URL: WEBHOOK,
    ALERT_STATE: ns,
    ...extra,
  });

  it("reports a failed pass by its kind and still fails the cron event", async () => {
    const { ns, events, names } = namespace();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 530 }));
    try {
      await expect(worker.scheduled(null, baseEnv(ns), null)).rejects.toThrow("Automation returned HTTP 530");
    } finally {
      fetchSpy.mockRestore();
    }
    expect(names).toEqual(["us"]);
    expect(events).toEqual([{ ok: false, at: expect.any(Number), detail: "HTTP 530: the tunnel to the box is down" }]);
  });

  it("reports a clean pass", async () => {
    const { ns, events } = namespace();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, status: "SUCCEEDED" }));
    try {
      await expect(worker.scheduled(null, baseEnv(ns), null)).resolves.toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(events).toEqual([{ ok: true, at: expect.any(Number) }]);
  });

  it("counts nothing while paused, and touches no state without a webhook", async () => {
    const paused = namespace();
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await worker.scheduled(null, baseEnv(paused.ns, { AUTOMATION_PAUSED: "true" }), null);
    } finally {
      log.mockRestore();
    }
    expect(paused.events).toEqual([]);

    const unset = namespace();
    await reportPass(baseEnv(unset.ns, { ALERT_DISCORD_WEBHOOK_URL: undefined }), new Error("x"), T0);
    await reportPass(baseEnv(unset.ns, { AUTOMATION_URL: "https://league.example/api/cron/automation" }), null, T0);
    expect(unset.events).toEqual([]);
  });

  it("never lets the alert state change the pass's outcome", async () => {
    const broken = namespace(async () => {
      throw new Error("Durable Object exceeded its free limit");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, status: "SUCCEEDED" }));
    try {
      await expect(worker.scheduled(null, baseEnv(broken.ns), null)).resolves.toBeUndefined();
      await expect(reportPass(baseEnv(undefined), null, T0)).resolves.toBeUndefined();
      expect(errors.mock.calls.map((call) => call[0])).toEqual(["ALERT_STATE_UNAVAILABLE", "ALERT_STATE_UNBOUND"]);
    } finally {
      fetchSpy.mockRestore();
      errors.mockRestore();
    }
  });
});

describe("Wrangler configuration", () => {
  it.each(["", ".paused", ".europe", ".europe.paused"])("binds one SQLite alert object and keeps the alert secrets optional (%s)", (variant) => {
    const config = JSON.parse(
      readFileSync(path.resolve(process.cwd(), `ops/cloudflare-automation-worker/wrangler${variant}.jsonc`), "utf8"),
    ) as Record<string, unknown>;
    expect(config.durable_objects).toEqual({
      bindings: [{ name: "ALERT_STATE", class_name: "SchedulerAlertState" }],
    });
    // SQLite-backed: the only kind the Workers Free plan allows.
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["SchedulerAlertState"] }]);
    // A required secret would make `scheduler:pause` fail until it is put; a
    // pause must always deploy.
    expect(config.secrets).toEqual({ required: ["AUTOMATION_SECRET"] });
    expect(JSON.stringify(config)).not.toMatch(/discord|webhook/i);
  });
});
