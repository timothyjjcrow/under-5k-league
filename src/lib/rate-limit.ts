// Best-effort in-memory fixed-window rate limiter. NOTE: the state is
// per-server-instance, so on serverless (Vercel) this throttles a single warm
// instance, not the whole fleet — a hard, distributed limit needs a shared
// store (e.g. Upstash/Redis). It's still a useful speed bump against a single
// source flooding an unauthenticated, outbound-triggering endpoint. Pure over
// an injected `nowMs` so it can be unit-tested deterministically.

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5_000;

export type RateLimitResult = { allowed: boolean; retryAfterMs: number };

export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
  nowMs: number,
): RateLimitResult {
  const b = buckets.get(key);
  if (!b || nowMs >= b.resetAt) {
    // Prune BEFORE adding a new attacker-controlled key. If every surviving
    // bucket is still live, evict the oldest-created window so memory stays
    // bounded even during a high-cardinality proxy/IP flood.
    if (!b && buckets.size >= MAX_BUCKETS) pruneRateLimits(nowMs);
    while (!b && buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
    // Reinsert an expired bucket so Map order continues to represent creation
    // time for the bounded eviction policy above.
    if (b) buckets.delete(key);
    buckets.set(key, { count: 1, resetAt: nowMs + opts.windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (b.count < opts.limit) {
    b.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: b.resetAt - nowMs };
}

export function pruneRateLimits(nowMs: number): void {
  for (const [k, b] of buckets) {
    if (nowMs >= b.resetAt) buckets.delete(k);
  }
}

/** For tests only — reset all limiter state. */
export function __resetRateLimits(): void {
  buckets.clear();
}

/** For tests only — proves attacker-controlled keys cannot grow memory forever. */
export function __rateLimitBucketCount(): number {
  return buckets.size;
}

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(req: {
  headers: { get(name: string): string | null };
}): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") || "unknown";
}
