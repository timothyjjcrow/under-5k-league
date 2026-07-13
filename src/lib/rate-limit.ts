// Best-effort in-memory fixed-window rate limiter. NOTE: the state is
// per-server-instance, so on serverless (Vercel) this throttles a single warm
// instance, not the whole fleet — a hard, distributed limit needs a shared
// store (e.g. Upstash/Redis). It's still a useful speed bump against a single
// source flooding an unauthenticated, outbound-triggering endpoint. Pure over
// an injected `nowMs` so it can be unit-tested deterministically.

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export type RateLimitResult = { allowed: boolean; retryAfterMs: number };

export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
  nowMs: number,
): RateLimitResult {
  const b = buckets.get(key);
  if (!b || nowMs >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: nowMs + opts.windowMs });
    // Opportunistically drop expired buckets so the map can't grow unbounded.
    if (buckets.size > 5000) pruneRateLimits(nowMs);
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

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(req: {
  headers: { get(name: string): string | null };
}): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") || "unknown";
}
