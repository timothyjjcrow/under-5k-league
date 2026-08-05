import { isIP } from "node:net";

// Best-effort in-memory fixed-window rate limiter. NOTE: the state is
// per-server-instance, so on serverless (Vercel) this throttles a single warm
// instance, not the whole fleet — the deployment runbook therefore makes
// pre-function Vercel WAF limits a hard launch gate. This remains a useful
// second layer and immediate feedback path. Pure over an injected `nowMs` so
// it can be unit-tested deterministically.

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5_000;

export type RateLimitResult = { allowed: boolean; retryAfterMs: number };

export function retryAfterSeconds(result: RateLimitResult): string {
  return String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
}

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

function firstValidIp(value: string | null): string | null {
  // A provider-owned IP header is tiny. Reject a high-cardinality garbage
  // value as one shared `unknown` bucket instead of letting it churn the
  // bounded limiter map and evict legitimate clients.
  if (!value || value.length > 512) return null;
  const candidate = value.split(",", 1)[0]?.trim() ?? "";
  if (!candidate || candidate.length > 45 || isIP(candidate) === 0) return null;
  return candidate.toLowerCase();
}

/**
 * Best-effort rate-limit identity. Vercel's platform-owned header wins; an
 * invalid value fails closed instead of falling through to a spoofable one.
 * The standard proxy fallbacks support local/reviewed self-hosting and direct
 * Vercel ingress, where the platform also overwrites X-Forwarded-For.
 */
export function clientIp(req: {
  headers: { get(name: string): string | null };
}): string {
  const vercelForwarded = req.headers.get("x-vercel-forwarded-for");
  if (vercelForwarded !== null) {
    return firstValidIp(vercelForwarded) ?? "unknown";
  }
  return (
    firstValidIp(req.headers.get("x-forwarded-for")) ??
    firstValidIp(req.headers.get("x-real-ip")) ??
    "unknown"
  );
}
