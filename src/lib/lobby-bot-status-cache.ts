/**
 * One short-lived read of the lobby bot's status per game, shared by every
 * panel of that game in this server process.
 *
 * Every player's and admin's panel of a game re-reads the bot every few
 * seconds while it sets a lobby up (LOBBY_PANEL_POLL_MS). Without this, each
 * of those reads is its own bot request (through the relay until the bot is on
 * the box, which has a daily request quota); with it, a game costs about one
 * bot read per `LOBBY_BOT_STATUS_TTL_MS`, however many panels are open.
 *
 * - **Single flight:** a read already on its way is shared, never repeated.
 * - **Short TTL:** a settled read (answer or error) serves for
 *   `LOBBY_BOT_STATUS_TTL_MS`, then the next caller reads again.
 * - **Writes win:** a create, start, release or invite stores its own reply
 *   (`storeLobbyBotStatus`), so the next read shows what the action did. An
 *   older read still on its way never overwrites it: it settles only the
 *   entry it created.
 * - **Held on `globalThis`:** one `next start` process loads lib modules more
 *   than once (route handlers and server actions are separate module
 *   instances), and both must share one cache.
 * - **Bot replies only.** Per-viewer fields (`self`, the invite scope) are
 *   computed by the caller from the cached reply, never cached.
 */

/** How long a settled bot status read serves every panel of its game. */
export const LOBBY_BOT_STATUS_TTL_MS = 2_000;

/** Past this many entries, settled ones past their TTL are swept. */
const SWEEP_ABOVE = 64;

type Entry = {
  promise: Promise<unknown>;
  /** When the read settled (epoch ms), or null while it is on its way. */
  settledAt: number | null;
};

const STORE = Symbol.for("ggd2l.lobbyBotStatusCache");

function entries(): Map<string, Entry> {
  const holder = globalThis as typeof globalThis & {
    [STORE]?: Map<string, Entry>;
  };
  return (holder[STORE] ??= new Map());
}

function fresh(entry: Entry, nowMs: number) {
  return (
    entry.settledAt === null ||
    nowMs - entry.settledAt < LOBBY_BOT_STATUS_TTL_MS
  );
}

function sweep(map: Map<string, Entry>, nowMs: number) {
  if (map.size <= SWEEP_ABOVE) return;
  for (const [key, entry] of map)
    if (!fresh(entry, nowMs)) map.delete(key);
}

/**
 * The cached read for `key`, or a new one from `read` when there is none or
 * it is older than the TTL. Concurrent callers share one `read`.
 */
export function cachedLobbyBotStatus<T>(
  key: string,
  read: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const map = entries();
  const hit = map.get(key);
  if (hit && fresh(hit, now())) return hit.promise as Promise<T>;
  const entry: Entry = { promise: Promise.resolve(), settledAt: null };
  const settle = () => {
    // Only the entry this read created: a write may have replaced it.
    if (map.get(key) === entry) entry.settledAt = now();
  };
  const promise = read().then(
    (value) => {
      settle();
      return value;
    },
    (error: unknown) => {
      settle();
      throw error;
    },
  );
  entry.promise = promise;
  sweep(map, now());
  map.set(key, entry);
  return promise;
}

/** A write's reply: what the next read of `key` serves until the TTL ends. */
export function storeLobbyBotStatus<T>(
  key: string,
  value: T,
  now: () => number = Date.now,
): void {
  entries().set(key, { promise: Promise.resolve(value), settledAt: now() });
}

/** Forget `key`: the next read asks the bot (a write whose outcome is unknown). */
export function dropLobbyBotStatus(key: string): void {
  entries().delete(key);
}

/** Tests only: start from an empty cache. */
export function resetLobbyBotStatusCacheForTests(): void {
  entries().clear();
}
