import { DurableObject } from "cloudflare:workers";
import {
  MAX_BYTES, MAX_PENDING, REQUEST_TIMEOUT_MS, INSTANCE_PATTERN,
  validControlRequest, validReply, leaseAlive,
} from "./protocol.mjs";

const encoder = new TextEncoder();
const json = (status, body) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
const failed = (code = "OFFLINE", status = 409) => json(status, { code });

async function authorized(request, secret) {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512 || /\s/.test(secret)) return false;
  const supplied = request.headers.get("Authorization") ?? "";
  if (supplied.length > 520) return false;
  const [given, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${secret}`)),
  ]);
  return crypto.subtle.timingSafeEqual(given, expected);
}

async function readJson(request) {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim() !== "application/json") throw new Error();
  if (Number(request.headers.get("Content-Length")) > MAX_BYTES || !request.body) throw new Error();
  const reader = request.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error();
      chunks.push(value);
    }
  } catch {
    // Cancel rather than buffer the rest of an oversized request.
    await reader.cancel().catch(() => {});
    throw new Error();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.search || !["/connect", "/lobby", "/health"].includes(url.pathname)) return failed("INVALID", 404);
    const connect = url.pathname === "/connect";
    if (!await authorized(request, connect ? env.DOTA_RELAY_WORKER_SECRET : env.DOTA_LOBBY_BOT_SECRET)) return failed("AUTH", 401);
    if (connect) {
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
          !INSTANCE_PATTERN.test(request.headers.get("X-Bot-Instance") ?? "")) return failed("INVALID", 400);
    } else {
      if (request.method !== "POST") return failed("INVALID", 405);
      try {
        const control = await readJson(request);
        if (!validControlRequest(control) || (url.pathname === "/health" && control.action !== "health")) return failed("INVALID", 400);
        // Reconstruct after bounded validation; no incoming secret headers reach the DO.
        request = new Request(`https://relay.internal/lobby`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(control),
        });
      } catch { return failed("INVALID", 400); }
    }
    try {
      return await env.LOBBY_RELAY.getByName("inhouse").fetch(request);
    } catch { return failed(); }
  },
};

export default worker;

/** The bot connects outbound; no inbound port or tunnel is needed on its host.
 * Idle sockets hibernate. Requests exist only in memory for at most ten seconds;
 * they are never stored or replayed after a disconnect, replacement or restart.
 */
export class LobbyRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  finish(id, status, body) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(json(status, body));
  }

  retire(ws, reason) {
    const attachment = ws.deserializeAttachment() ?? {};
    ws.serializeAttachment({ ...attachment, retired: true });
    for (const [id, pending] of this.pending)
      if (pending.ws === ws) this.finish(id, 409, { code: "OFFLINE" });
    try { ws.close(4001, reason); } catch {}
  }

  liveSocket() {
    let live = null;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      const pongAt = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
      if (ws.readyState !== WebSocket.OPEN || !leaseAlive(attachment, pongAt, Date.now())) {
        this.retire(ws, "Connection lease expired");
      } else if (live) {
        this.retire(ws, "Duplicate connection");
      } else live = ws;
    }
    return live;
  }

  async fetch(request) {
    const ws = this.liveSocket();
    if (new URL(request.url).pathname === "/connect") {
      const instance = request.headers.get("X-Bot-Instance");
      if (!INSTANCE_PATTERN.test(instance ?? "")) return failed("INVALID", 400);
      if (ws) {
        if (ws.deserializeAttachment().instance !== instance) return failed("BUSY");
        this.retire(ws, "Connection replaced");
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ instance, connectedAt: Date.now(), lastMessageAt: Date.now(), retired: false });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!ws) return failed();
    if (this.pending.size >= MAX_PENDING) return failed("BUSY");
    let control;
    try {
      control = await request.json();
      if (!validControlRequest(control)) return failed("INVALID", 400);
    } catch { return failed("INVALID", 400); }
    // Reading the body yields. A replacement/disconnect can occur in that gap.
    if (ws !== this.liveSocket()) return failed();
    if (this.pending.size >= MAX_PENDING) return failed("BUSY");
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + REQUEST_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, 409, { code: "OFFLINE" }), REQUEST_TIMEOUT_MS);
      this.pending.set(id, { ws, action: control.action, expiresAt, resolve, timer });
      try { ws.send(JSON.stringify({ id, expiresAt, request: control })); }
      catch { this.retire(ws, "Connection failed"); }
    });
  }

  webSocketMessage(ws, message) {
    if (ws !== this.liveSocket()) return;
    if (typeof message !== "string" || encoder.encode(message).byteLength > MAX_BYTES) {
      this.retire(ws, "Invalid response");
      return;
    }
    let reply;
    try { reply = JSON.parse(message); } catch { this.retire(ws, "Invalid response"); return; }
    const pending = this.pending.get(reply?.id);
    // Correlate to the exact connection, not merely a process or request ID.
    if (!pending || pending.ws !== ws) return;
    if (Date.now() >= pending.expiresAt) {
      this.finish(reply.id, 409, { code: "OFFLINE" });
      return;
    }
    if (!validReply(reply, pending.action)) {
      this.finish(reply.id, 409, { code: "STATE" });
      return;
    }
    const attachment = ws.deserializeAttachment();
    ws.serializeAttachment({ ...attachment, lastMessageAt: Date.now() });
    this.finish(reply.id, reply.status, reply.body);
  }

  webSocketClose(ws) { this.retire(ws, "Connection closed"); }
  webSocketError(ws) { this.retire(ws, "Connection failed"); }
}
