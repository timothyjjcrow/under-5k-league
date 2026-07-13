import { getSetting, setSetting } from "./settings";

// A global "session epoch". Every issued session JWT carries the epoch it was
// minted under; a session is rejected once its epoch falls BELOW the current
// one. Advancing the epoch therefore invalidates every previously-issued
// session at once — a break-glass for a suspected token leak / mass compromise
// (logout only clears one device's cookie and can't revoke a stolen token).
//
// Stored in the Setting table; cached in-process for a few seconds so the
// per-request auth check almost never hits the DB. The cache means a bump can
// take up to TTL to propagate across warm instances, which is fine for a
// break-glass. Existing sessions (epoch 0 / no claim) are grandfathered until
// the first bump — no forced re-login just from deploying this.

const KEY = "sessionEpoch";
const TTL_MS = 30_000;

let cache: { value: number; at: number } | null = null;

function parse(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function getSessionEpoch(nowMs: number): Promise<number> {
  if (cache && nowMs - cache.at < TTL_MS) return cache.value;
  const value = parse(await getSetting(KEY));
  cache = { value, at: nowMs };
  return value;
}

/** Advance the epoch, invalidating all outstanding sessions. Returns the new value. */
export async function bumpSessionEpoch(): Promise<number> {
  const next = parse(await getSetting(KEY)) + 1;
  await setSetting(KEY, String(next));
  cache = null; // force a fresh read on the next check
  return next;
}
