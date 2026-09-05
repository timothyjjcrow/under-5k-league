import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { RelayClient, relayConnection } from "./relay-client.mjs";

const secret = "unit-test-secret-".repeat(4);
async function connected(t, handle, options = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const connection = once(server, "connection");
  const client = new RelayClient({
    connection: relayConnection(`http://127.0.0.1:${server.address().port}`, secret, true),
    handle, log: () => {}, reconnectMs: 10, ...options,
  });
  client.start();
  const [socket, request] = await connection;
  socket.on("message", (text) => { if (text.toString() === "ping") socket.send("pong"); });
  t.after(async () => { client.stop(); for (const peer of server.clients) peer.terminate(); await new Promise((r) => server.close(r)); });
  return { server, client, socket, request };
}
function receive(socket) {
  return new Promise((resolve) => {
    const listener = (data) => {
      if (data.toString() === "ping") return;
      socket.off("message", listener);
      resolve(JSON.parse(data.toString()));
    };
    socket.on("message", listener);
  });
}
function packet(request = { action: "health" }) {
  return { id: randomUUID(), expiresAt: Date.now() + 10_000, request };
}
test("relay destinations require HTTPS and never encode credentials in URLs", () => {
  assert.equal(relayConnection(undefined, undefined), null);
  assert.equal(relayConnection("https://bot.example", secret).url, "wss://bot.example/connect");
  for (const origin of ["http://bot.example", "https://user:pass@bot.example", "https://bot.example/path", "https://bot.example?token=x", "https://bot.example#x"])
    assert.throws(() => relayConnection(origin, secret), /valid HTTPS/);
  assert.throws(() => relayConnection("https://bot.example", "short"), /private/);
});
test("authenticated outbound relay handles a command once even if its ID is duplicated", async (t) => {
  let calls = 0;
  const { socket, request } = await connected(t, () => { calls++; return { status: 200, body: { state: "creating" } }; });
  assert.equal(request.headers.authorization, `Bearer ${secret}`);
  assert.match(request.headers["x-bot-instance"], /^[a-f0-9-]{36}$/);
  const command = packet({ action: "create", spec: {} });
  let result = receive(socket); socket.send(JSON.stringify(command));
  assert.deepEqual(await result, { id: command.id, status: 200, body: { state: "creating" } });
  result = receive(socket); socket.send(JSON.stringify(command)); await result;
  assert.equal(calls, 1);
});
test("expired and excessively future commands are ignored before touching the controller", async (t) => {
  const actions = [];
  const { socket } = await connected(t, (r) => { actions.push(r.action); return { status: 200, body: { state: "idle" } }; });
  socket.send(JSON.stringify({ ...packet({ action: "create" }), expiresAt: Date.now() - 1 }));
  socket.send(JSON.stringify({ ...packet({ action: "start" }), expiresAt: Date.now() + 60_000 }));
  const result = receive(socket); socket.send(JSON.stringify(packet({ action: "status" }))); await result;
  assert.deepEqual(actions, ["status"]);
});
test("controller exceptions are sanitized without exposing their message", async (t) => {
  const { socket } = await connected(t, () => { throw new Error("sensitive upstream payload"); });
  const result = receive(socket); socket.send(JSON.stringify(packet()));
  assert.deepEqual((await result).body, { code: "INVALID" });
});
test("reconnect preserves process identity and never replays a completed command", async (t) => {
  let calls = 0;
  const { server, client, socket, request } = await connected(t, () => { calls++; return { status: 200, body: { state: "starting" } }; });
  const command = packet({ action: "start" });
  let reply = receive(socket); socket.send(JSON.stringify(command)); await reply;
  const reconnected = once(server, "connection"); socket.terminate();
  const [next, nextRequest] = await reconnected;
  next.on("message", (data) => { if (data.toString() === "ping") next.send("pong"); });
  assert.equal(nextRequest.headers["x-bot-instance"], request.headers["x-bot-instance"]);
  reply = receive(next); next.send(JSON.stringify(command)); await reply;
  assert.equal(calls, 1);
  client.stop();
});
