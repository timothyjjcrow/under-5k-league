import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { leaseAlive, LEASE_MS, validReply } from "../src/protocol.mjs";

const SITE_SECRET = "test-site-secret-".repeat(3);
const WORKER_SECRET = "test-worker-secret-".repeat(3);
const REQUEST = { action: "status", spec: { key: "inhouse:fixture:1" } };

async function fixture(t) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.mjs", import.meta.url)),
    compatibilityDate: "2026-07-30",
    durableObjects: { LOBBY_RELAY: { className: "LobbyRelay", useSQLite: true } },
    bindings: { DOTA_LOBBY_BOT_SECRET: SITE_SECRET, DOTA_RELAY_WORKER_SECRET: WORKER_SECRET },
  });
  t.after(() => mf.dispose());
  const post = (body = REQUEST, overrides = {}) => mf.dispatchFetch("https://relay.test/lobby", {
    method: "POST",
    headers: { Authorization: `Bearer ${SITE_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...overrides,
  });
  const connect = async (instance = randomUUID(), secret = WORKER_SECRET) => {
    const response = await mf.dispatchFetch("https://relay.test/connect", {
      headers: { Authorization: `Bearer ${secret}`, Upgrade: "websocket", "X-Bot-Instance": instance },
    });
    if (!response.webSocket) return { response };
    const ws = response.webSocket;
    ws.accept();
    const messages = [];
    const waiters = [];
    ws.addEventListener("message", (event) => {
      if (waiters.length) waiters.shift()(event.data);
      else messages.push(event.data);
    });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve));
    const nextRequest = async () => JSON.parse(await next());
    return { response, ws, next, nextRequest, messages };
  };
  return { mf, post, connect };
}

async function assertResponse(response, status, body) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), body);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
}

test("separate authentication protects both control and bot connection", async (t) => {
  const { post, connect, mf } = await fixture(t);
  await assertResponse(await post(REQUEST, { headers: { Authorization: `Bearer ${WORKER_SECRET}`, "Content-Type": "application/json" } }), 401, { code: "AUTH" });
  await assertResponse((await connect(randomUUID(), SITE_SECRET)).response, 401, { code: "AUTH" });
  await assertResponse(await post(), 409, { code: "OFFLINE" });
  await assertResponse(await mf.dispatchFetch("https://relay.test/health"), 401, { code: "AUTH" });
});

test("control input rejects unsupported actions, malformed and oversized bodies", async (t) => {
  const { post } = await fixture(t);
  for (const body of [{ action: "unknown" }, null, [], { action: "active", spec: {} }, { action: "create", spec: [] }])
    await assertResponse(await post(body), 400, { code: "INVALID" });
  await assertResponse(await post(REQUEST, { body: "{" }), 400, { code: "INVALID" });
  await assertResponse(await post(REQUEST, { body: JSON.stringify({ action: "create", spec: { padding: "x".repeat(8192) } }) }), 400, { code: "INVALID" });
});

test("dispatch correlates a bounded command and forwards only a valid reply", async (t) => {
  const { post, connect } = await fixture(t);
  const bot = await connect();
  assert.equal(bot.response.status, 101);
  const pending = post();
  const command = await bot.nextRequest();
  assert.deepEqual(command.request, REQUEST);
  assert.match(command.id, /^[0-9a-f-]{36}$/);
  assert.ok(command.expiresAt > Date.now() && command.expiresAt <= Date.now() + 10_000);
  bot.ws.send(JSON.stringify({ id: command.id, status: 200, body: { state: "ready", lobbyId: "12345" } }));
  await assertResponse(await pending, 200, { state: "ready", lobbyId: "12345" });
  const pong = bot.next();
  bot.ws.send("ping");
  assert.equal(await pong, "pong");
});

test("health and active responses retain only their explicit schemas", async (t) => {
  const { post, connect, mf } = await fixture(t);
  const bot = await connect();
  const pending = mf.dispatchFetch("https://relay.test/health", {
    method: "POST", headers: { Authorization: `Bearer ${SITE_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "health" }),
  });
  const command = await bot.nextRequest();
  const health = { online: true, steamId: "76561198000000001", activeKey: "eu:inhouse:fixture:1", lobbyId: null, gameMode: null, serverRegion: 3, leagueId: 54321 };
  bot.ws.send(JSON.stringify({ id: command.id, status: 200, body: health }));
  await assertResponse(await pending, 200, health);
  const activePending = post({ action: "active" });
  const active = await bot.nextRequest();
  bot.ws.send(JSON.stringify({ id: active.id, status: 200, body: { key: "eu:inhouse:fixture:1" } }));
  await assertResponse(await activePending, 200, { key: "eu:inhouse:fixture:1" });
});

test("one shared relay keeps US and EU requests distinct when database IDs match", async (t) => {
  const { post, connect } = await fixture(t);
  const bot = await connect();
  const us = { action: "status", spec: { key: "inhouse:same-id:1", serverRegion: 2, leagueId: 12345 } };
  const eu = { action: "status", spec: { key: "eu:inhouse:same-id:1", serverRegion: 3, leagueId: 54321 } };
  const usPending = post(us);
  const euPending = post(eu);
  const commands = [await bot.nextRequest(), await bot.nextRequest()];
  assert.notEqual(commands[0].id, commands[1].id);
  assert.deepEqual(commands.map((command) => command.request).sort((a, b) => a.spec.serverRegion - b.spec.serverRegion), [us, eu]);
  // Responses may return in the opposite order; each original HTTP caller
  // must receive only its own command's response.
  for (const command of commands.reverse())
    bot.ws.send(JSON.stringify({ id: command.id, status: 200, body: { state: "ready", lobbyId: command.request.spec.serverRegion === 3 ? "33333" : "22222" } }));
  await assertResponse(await usPending, 200, { state: "ready", lobbyId: "22222" });
  await assertResponse(await euPending, 200, { state: "ready", lobbyId: "33333" });
});

test("malformed bot reply fails closed and never leaks extra fields", async (t) => {
  const { post, connect } = await fixture(t);
  const bot = await connect();
  const pending = post();
  const command = await bot.nextRequest();
  bot.ws.send(JSON.stringify({ id: command.id, status: 500, body: { code: "STATE", secret: "must-not-leak" } }));
  await assertResponse(await pending, 409, { code: "STATE" });
  const nextPending = post();
  const next = await bot.nextRequest();
  bot.ws.send(JSON.stringify({ id: next.id, status: 409, body: { code: "ROSTER" } }));
  await assertResponse(await nextPending, 409, { code: "ROSTER" });
});

test("a different live bot instance cannot replace the host", async (t) => {
  const { post, connect } = await fixture(t);
  const bot = await connect();
  await assertResponse((await connect()).response, 409, { code: "BUSY" });
  const pending = post();
  const command = await bot.nextRequest();
  bot.ws.send(JSON.stringify({ id: command.id, status: 200, body: { state: "idle" } }));
  await assertResponse(await pending, 200, { state: "idle" });
});

test("same-instance reconnect cancels pending commands without replay", async (t) => {
  const { post, connect } = await fixture(t);
  const instance = randomUUID();
  const original = await connect(instance);
  const pending = post({ action: "create", spec: { key: "inhouse:fixture:1" } });
  const originalCommand = await original.nextRequest();
  const replacement = await connect(instance);
  assert.equal(replacement.response.status, 101);
  await assertResponse(await pending, 409, { code: "OFFLINE" });
  const nextPending = post();
  const next = await replacement.nextRequest();
  assert.equal(next.request.action, "status");
  assert.notEqual(next.id, originalCommand.id);
  // A stale reply from a new connection cannot complete a replaced request.
  replacement.ws.send(JSON.stringify({ id: originalCommand.id, status: 200, body: { state: "ready" } }));
  replacement.ws.send(JSON.stringify({ id: next.id, status: 200, body: { state: "idle" } }));
  await assertResponse(await nextPending, 200, { state: "idle" });
  assert.equal(replacement.messages.length, 0);
});

test("disconnect cancels pending commands and reconnection never replays them", async (t) => {
  const { post, connect } = await fixture(t);
  const bot = await connect();
  const pending = post({ action: "start", spec: { key: "inhouse:fixture:1" } });
  await bot.nextRequest();
  bot.ws.close(1000, "Test disconnect");
  await assertResponse(await pending, 409, { code: "OFFLINE" });
  const replacement = await connect();
  const nextPending = post();
  const next = await replacement.nextRequest();
  assert.equal(next.request.action, "status");
  replacement.ws.send(JSON.stringify({ id: next.id, status: 200, body: { state: "starting" } }));
  await assertResponse(await nextPending, 200, { state: "starting" });
});

test("ten-second timeout is terminal, even when the bot replies late", { timeout: 15_000 }, async (t) => {
  const { post, connect } = await fixture(t);
  const bot = await connect();
  const pending = post({ action: "start", spec: { key: "inhouse:fixture:1" } });
  const command = await bot.nextRequest();
  await assertResponse(await pending, 409, { code: "OFFLINE" });
  bot.ws.send(JSON.stringify({ id: command.id, status: 200, body: { state: "started" } }));
  const nextPending = post();
  const next = await bot.nextRequest();
  assert.equal(next.request.action, "status");
  assert.notEqual(next.id, command.id);
  bot.ws.send(JSON.stringify({ id: next.id, status: 200, body: { state: "started" } }));
  await assertResponse(await nextPending, 200, { state: "started" });
});

test("at most 64 requests are dispatched concurrently", async (t) => {
  const { post, connect } = await fixture(t);
  const bot = await connect();
  const pending = Array.from({ length: 64 }, () => post());
  for (let i = 0; i < 64; i++) await bot.nextRequest();
  await assertResponse(await post(), 409, { code: "BUSY" });
  bot.ws.close(1000, "Test complete");
  for (const response of await Promise.all(pending)) await assertResponse(response, 409, { code: "OFFLINE" });
});

test("lease expiration includes hibernation heartbeat timestamps and retires old sockets", () => {
  const instance = randomUUID();
  const now = 200_000;
  assert.equal(leaseAlive({ instance, connectedAt: now - LEASE_MS }, null, now), false);
  assert.equal(leaseAlive({ instance, connectedAt: now - LEASE_MS }, now - 30_000, now), true);
  assert.equal(leaseAlive({ instance, connectedAt: now - LEASE_MS, lastMessageAt: now - 500 }, null, now), true);
  assert.equal(leaseAlive({ instance, connectedAt: now, retired: true }, now, now), false);
});

test("health validation rejects missing identity fields and unsafe response content", () => {
  const id = randomUUID();
  assert.equal(validReply({ id, status: 200, body: { online: true } }, "health"), false);
  assert.equal(validReply({ id, status: 409, body: { code: "AUTH", input: {} } }, "status"), false);
  assert.equal(validReply({ id, status: 200, body: { state: "ready", lobbyId: "not-an-id" } }, "status"), false);
  for (const key of ["asia:inhouse:fixture:1", "eu:us:inhouse:fixture:1", "EU:season:fixture:1"])
    assert.equal(validReply({ id, status: 200, body: { key } }, "active"), false);
});
