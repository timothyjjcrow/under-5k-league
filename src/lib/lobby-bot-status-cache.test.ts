import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cachedLobbyBotStatus,
  dropLobbyBotStatus,
  LOBBY_BOT_STATUS_TTL_MS,
  resetLobbyBotStatusCacheForTests,
  storeLobbyBotStatus,
} from "./lobby-bot-status-cache";
import { sourceFile } from "../../test/support/source-files";

afterEach(() => resetLobbyBotStatusCacheForTests());

/** A read that resolves (or rejects) only when told to. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("cachedLobbyBotStatus", () => {
  it("shares one read among concurrent callers of the same key", async () => {
    const pending = deferred<string>();
    const read = vi.fn(() => pending.promise);
    const a = cachedLobbyBotStatus("game", read);
    const b = cachedLobbyBotStatus("game", read);
    pending.resolve("ready");
    expect(await Promise.all([a, b])).toEqual(["ready", "ready"]);
    expect(read).toHaveBeenCalledOnce();
  });

  it("serves a settled read until its TTL ends, then reads again", async () => {
    let now = 1_000;
    const clock = () => now;
    const read = vi.fn(async () => `read at ${now}`);
    expect(await cachedLobbyBotStatus("game", read, clock)).toBe("read at 1000");
    now += LOBBY_BOT_STATUS_TTL_MS - 1;
    expect(await cachedLobbyBotStatus("game", read, clock)).toBe("read at 1000");
    expect(read).toHaveBeenCalledOnce();
    now += 1;
    expect(await cachedLobbyBotStatus("game", read, clock)).toBe(
      `read at ${1_000 + LOBBY_BOT_STATUS_TTL_MS}`,
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps each key apart", async () => {
    const read = vi.fn(async () => "x");
    await cachedLobbyBotStatus("one", read);
    await cachedLobbyBotStatus("two", read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares a failure for the TTL too, then asks again", async () => {
    let now = 0;
    const clock = () => now;
    const read = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(cachedLobbyBotStatus("game", read, clock)).rejects.toThrow("offline");
    await expect(cachedLobbyBotStatus("game", read, clock)).rejects.toThrow("offline");
    expect(read).toHaveBeenCalledOnce();
    now += LOBBY_BOT_STATUS_TTL_MS;
    await expect(cachedLobbyBotStatus("game", read, clock)).rejects.toThrow("offline");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("serves a write's reply next, and an older read still on its way never overwrites it", async () => {
    let now = 0;
    const clock = () => now;
    const old = deferred<string>();
    const first = cachedLobbyBotStatus("game", () => old.promise, clock);
    // An action's reply lands while that read is still out.
    storeLobbyBotStatus("game", "creating", clock);
    old.resolve("idle");
    // The caller that asked before the action gets its own (older) answer…
    expect(await first).toBe("idle");
    // …but the cache keeps the action's.
    const read = vi.fn(async () => "never");
    expect(await cachedLobbyBotStatus("game", read, clock)).toBe("creating");
    expect(read).not.toHaveBeenCalled();
    // The write's entry ages out like any read.
    now += LOBBY_BOT_STATUS_TTL_MS;
    expect(await cachedLobbyBotStatus("game", read, clock)).toBe("never");
  });

  it("asks again at once after a drop", async () => {
    const read = vi.fn(async () => "fresh");
    storeLobbyBotStatus("game", "stale");
    dropLobbyBotStatus("game");
    expect(await cachedLobbyBotStatus("game", read)).toBe("fresh");
    expect(read).toHaveBeenCalledOnce();
  });

  // One `next start` process loads lib modules more than once (route
  // handlers and server actions are separate module instances): a second
  // copy of this module must find the first one's entries.
  it("keeps its entries on globalThis, shared by every copy of the module", async () => {
    storeLobbyBotStatus("game", "ready");
    vi.resetModules();
    const again = await import("./lobby-bot-status-cache");
    const read = vi.fn(async () => "never");
    expect(await again.cachedLobbyBotStatus("game", read)).toBe("ready");
    expect(read).not.toHaveBeenCalled();
    expect(sourceFile("src/lib/lobby-bot-status-cache.ts").text).toMatch(
      /Symbol\.for\("ggd2l\.lobbyBotStatusCache"\)/,
    );
  });
});
