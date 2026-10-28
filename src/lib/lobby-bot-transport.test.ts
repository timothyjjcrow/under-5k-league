import { describe, expect, it } from "vitest";
import {
  BotReplyUnreadableError,
  connectionRefused,
  MAX_BOT_REPLY_BYTES,
  readBotReply,
} from "./lobby-bot-transport";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

/** A body streamed in `parts` chunks, with no Content-Length to go by. */
function streamed(text: string, parts = 4, status = 200) {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / parts);
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(at, at + size));
        at += size;
      },
    }),
    { status },
  );
}

describe("readBotReply", () => {
  it("reads a reply or an error code on the bot's three statuses", async () => {
    expect(await readBotReply(json({ state: "ready" }))).toEqual({
      status: 200,
      body: { state: "ready" },
    });
    for (const status of [400, 409])
      expect(await readBotReply(json({ code: "BUSY" }, { status }))).toEqual({
        status,
        body: { code: "BUSY" },
      });
  });

  // The bot's early leave (2026-10-27): a started job may carry `left`. The
  // transport passes the body through untouched; parseLobbyLifecycle
  // (dota-lobby.ts) reads the flag strictly.
  it("passes a started job's left flag through with its match id", async () => {
    const body = { state: "started", matchId: "8123456789", left: true, over: true };
    expect(await readBotReply(json(body))).toEqual({ status: 200, body });
  });

  it.each([401, 404, 413, 500, 502, 524])(
    "refuses status %i: outside the bot's contract",
    async (status) => {
      await expect(readBotReply(json({ code: "X" }, { status }))).rejects.toBeInstanceOf(
        BotReplyUnreadableError,
      );
    },
  );

  it("reads a streamed body up to the cap, and refuses one past it", async () => {
    const fits = JSON.stringify({ state: "ready", pad: "x".repeat(MAX_BOT_REPLY_BYTES - 40) });
    expect(fits.length).toBeLessThanOrEqual(MAX_BOT_REPLY_BYTES);
    expect((await readBotReply(streamed(fits))).body.state).toBe("ready");
    const tooBig = JSON.stringify({ state: "ready", pad: "x".repeat(MAX_BOT_REPLY_BYTES) });
    await expect(readBotReply(streamed(tooBig))).rejects.toBeInstanceOf(
      BotReplyUnreadableError,
    );
  });

  it("refuses a declared length past the cap before reading anything", async () => {
    let pulled = false;
    const response = new Response(
      new ReadableStream({
        pull() {
          pulled = true;
        },
      }),
      { status: 200, headers: { "Content-Length": String(MAX_BOT_REPLY_BYTES + 1) } },
    );
    await expect(readBotReply(response)).rejects.toBeInstanceOf(BotReplyUnreadableError);
    expect(pulled).toBe(false);
  });

  it.each(["not json", "[1,2]", "null", '"ready"', "12"])(
    "refuses a body that isn't one JSON object (%j)",
    async (text) => {
      await expect(readBotReply(streamed(text, 1))).rejects.toBeInstanceOf(
        BotReplyUnreadableError,
      );
    },
  );

  it("refuses a body that isn't UTF-8", async () => {
    const response = new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 });
    await expect(readBotReply(response)).rejects.toBeInstanceOf(BotReplyUnreadableError);
  });
});

describe("connectionRefused", () => {
  const failed = (cause: unknown) =>
    Object.assign(new TypeError("fetch failed"), { cause });

  it("is a refused connection: nothing was listening", () => {
    expect(connectionRefused(failed({ code: "ECONNREFUSED" }))).toBe(true);
    // Node tried more than one address, and every one refused.
    expect(
      connectionRefused(
        failed({ errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }] }),
      ),
    ).toBe(true);
  });

  it("is never a timeout, a reset or anything that may have been delivered", () => {
    for (const cause of [
      { code: "ECONNRESET" },
      { code: "UND_ERR_SOCKET" },
      { errors: [{ code: "ECONNREFUSED" }, { code: "ETIMEDOUT" }] },
      { errors: [] },
      "ECONNREFUSED",
      undefined,
    ])
      expect(connectionRefused(failed(cause)), JSON.stringify(cause)).toBe(false);
    expect(connectionRefused(new DOMException("timed out", "TimeoutError"))).toBe(false);
    expect(connectionRefused(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(connectionRefused(null)).toBe(false);
  });
});
