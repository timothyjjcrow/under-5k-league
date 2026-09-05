import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export function relayConnection(origin, secret, allowLocal = false) {
  if (!origin && !secret) return null;
  try {
    const url = new URL(origin);
    const local = allowLocal && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        typeof secret !== "string" || secret.length < 32 || secret.length > 512 || /\s/.test(secret))
      throw new Error();
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/connect";
    return { url: url.href, secret };
  } catch {
    throw new Error("Set a valid HTTPS DOTA_LOBBY_RELAY_URL and private DOTA_RELAY_WORKER_SECRET.");
  }
}

/** Outbound only. Reconnect the socket, but never replay lobby commands. */
export class RelayClient {
  constructor({ connection, handle, log = console.log, now = Date.now, heartbeatMs = 30_000, reconnectMs = 3000 }) {
    this.connection = connection;
    this.handle = handle;
    this.log = log;
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.reconnectMs = reconnectMs;
    this.instance = randomUUID();
    this.seen = new Map();
    this.stopped = false;
    this.connected = false;
    this.failures = 0;
  }
  start() {
    if (!this.connection || this.stopped) return;
    const socket = new WebSocket(this.connection.url, {
      headers: { Authorization: `Bearer ${this.connection.secret}`, "X-Bot-Instance": this.instance },
      handshakeTimeout: 10_000,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: 12 * 1024,
    });
    this.socket = socket;
    socket.on("open", () => {
      this.connected = true;
      this.failures = 0;
      this.lastPong = this.now();
      this.log("[dota-bot] Website relay connected");
      socket.send("ping");
      this.heartbeat = setInterval(() => {
        if (this.now() - this.lastPong > this.heartbeatMs * 2) return socket.terminate();
        if (socket.readyState === WebSocket.OPEN) socket.send("ping");
      }, this.heartbeatMs);
    });
    socket.on("message", (data, binary) => {
      if (binary) return socket.close(1003, "Text messages required");
      const text = data.toString("utf8");
      if (text === "pong") { this.lastPong = this.now(); return; }
      let packet;
      try { packet = JSON.parse(text); } catch { return socket.close(1008, "Invalid request"); }
      if (!packet || typeof packet.id !== "string" || !/^[a-f0-9-]{36}$/.test(packet.id) ||
          !Number.isSafeInteger(packet.expiresAt) || packet.expiresAt <= this.now() ||
          packet.expiresAt > this.now() + 15_000 || !packet.request ||
          typeof packet.request !== "object" || Array.isArray(packet.request)) return;
      for (const [id, reply] of this.seen) if (reply.expiresAt <= this.now()) this.seen.delete(id);
      let reply = this.seen.get(packet.id);
      if (!reply) {
        if (this.seen.size >= 1024) return socket.close(1008, "Too many requests");
        let result;
        try { result = this.handle(packet.request); }
        catch { result = { status: 400, body: { code: "INVALID" } }; }
        reply = { expiresAt: packet.expiresAt, message: JSON.stringify({ id: packet.id, ...result }) };
        this.seen.set(packet.id, reply);
      }
      if (socket.readyState === WebSocket.OPEN && packet.expiresAt > this.now()) socket.send(reply.message);
    });
    socket.on("error", () => {}); // The close handler logs a fixed, secret-free message.
    socket.on("close", () => {
      this.connected = false;
      clearInterval(this.heartbeat);
      if (this.stopped) return;
      if (this.failures === 0) this.log("[dota-bot] Website relay disconnected; reconnecting");
      const delay = Math.min(30_000, this.reconnectMs * 2 ** Math.min(this.failures++, 4));
      this.retry = setTimeout(() => this.start(), delay);
    });
  }
  stop() {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.socket?.terminate();
  }
}
