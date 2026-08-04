import { describe, it, expect, beforeEach } from "vitest";
import {
  rateLimit,
  clientIp,
  retryAfterSeconds,
  __rateLimitBucketCount,
  __resetRateLimits,
} from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(() => __resetRateLimits());

  it("allows up to the limit, then blocks within the window", () => {
    const opts = { limit: 3, windowMs: 1000 };
    expect(rateLimit("k", opts, 0).allowed).toBe(true);
    expect(rateLimit("k", opts, 10).allowed).toBe(true);
    expect(rateLimit("k", opts, 20).allowed).toBe(true);
    const blocked = rateLimit("k", opts, 30);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after the window elapses", () => {
    const opts = { limit: 1, windowMs: 1000 };
    expect(rateLimit("k", opts, 0).allowed).toBe(true);
    expect(rateLimit("k", opts, 500).allowed).toBe(false);
    expect(rateLimit("k", opts, 1000).allowed).toBe(true); // fresh window
  });

  it("tracks keys independently", () => {
    const opts = { limit: 1, windowMs: 1000 };
    expect(rateLimit("a", opts, 0).allowed).toBe(true);
    expect(rateLimit("b", opts, 0).allowed).toBe(true);
    expect(rateLimit("a", opts, 0).allowed).toBe(false);
  });

  it("rounds Retry-After up to a positive whole second", () => {
    expect(retryAfterSeconds({ allowed: false, retryAfterMs: 2_001 })).toBe(
      "3",
    );
    expect(retryAfterSeconds({ allowed: false, retryAfterMs: 0 })).toBe("1");
  });

  it("bounds high-cardinality live buckets with oldest-window eviction", () => {
    const opts = { limit: 1, windowMs: 60_000 };
    for (let i = 0; i < 6_000; i += 1) {
      expect(rateLimit(`source-${i}`, opts, 0).allowed).toBe(true);
    }
    expect(__rateLimitBucketCount()).toBe(5_000);
    expect(rateLimit("source-5999", opts, 1).allowed).toBe(false);
    expect(rateLimit("source-0", opts, 1).allowed).toBe(true);
    expect(__rateLimitBucketCount()).toBe(5_000);
  });
});

describe("clientIp", () => {
  const req = (h: Record<string, string>) => ({
    headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
  });
  it("prefers Vercel's platform-owned forwarding header", () => {
    expect(
      clientIp(
        req({
          "x-vercel-forwarded-for": "2001:DB8::1",
          "x-forwarded-for": "198.51.100.9",
        }),
      ),
    ).toBe("2001:db8::1");
  });
  it("uses the first valid x-forwarded-for entry outside Vercel", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe(
      "1.2.3.4",
    );
  });
  it("falls back to a valid x-real-ip, then one shared unknown bucket", () => {
    expect(clientIp(req({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(req({}))).toBe("unknown");
  });
  it.each([
    "attacker-controlled",
    "1.2.3.4:443",
    "999.999.999.999",
    "x".repeat(600),
  ])("rejects an invalid high-cardinality identity %j", (value) => {
    expect(clientIp(req({ "x-forwarded-for": value }))).toBe("unknown");
  });
  it("does not fall through when the attested Vercel header is invalid", () => {
    expect(
      clientIp(
        req({
          "x-vercel-forwarded-for": "forged",
          "x-forwarded-for": "198.51.100.9",
        }),
      ),
    ).toBe("unknown");
  });
});
