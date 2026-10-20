import { beforeEach, describe, expect, it } from "vitest";
import { limitPublicGet, PUBLIC_GET_LIMITS } from "./public-get-limit";
import { __resetRateLimits } from "./rate-limit";

const T0 = 5_000_000;

const from = (ip: string) => ({
  headers: { get: (name: string) => (name === "x-forwarded-for" ? ip : null) },
});

beforeEach(() => __resetRateLimits());

describe("limitPublicGet", () => {
  it("stays generous enough for a calendar provider's shared fetcher", () => {
    // A thousand hourly subscriptions through one address are under 20 a
    // minute; the ceiling must stay far above that.
    expect(PUBLIC_GET_LIMITS.calendar.limit).toBeGreaterThanOrEqual(600);
    expect(PUBLIC_GET_LIMITS.calendar.windowMs).toBe(60_000);
  });

  it.each(Object.keys(PUBLIC_GET_LIMITS) as Array<keyof typeof PUBLIC_GET_LIMITS>)(
    "lets one address make the %s limit's requests in a window, then answers 429 with Retry-After",
    async (scope) => {
      const { limit, windowMs } = PUBLIC_GET_LIMITS[scope];
      for (let i = 0; i < limit; i += 1) {
        expect(limitPublicGet(from("203.0.113.7"), scope, T0 + i)).toBeNull();
      }
      const refused = limitPublicGet(from("203.0.113.7"), scope, T0 + limit);
      expect(refused?.status).toBe(429);
      expect(refused?.headers.get("cache-control")).toBe("no-store");
      // The window started at T0, so the wait is what is left of it.
      expect(refused?.headers.get("retry-after")).toBe(
        String(Math.ceil((windowMs - limit) / 1000)),
      );
      // Another address has its own bucket, and the next window starts over.
      expect(limitPublicGet(from("198.51.100.2"), scope, T0 + limit)).toBeNull();
      expect(limitPublicGet(from("203.0.113.7"), scope, T0 + windowMs)).toBeNull();
    },
  );

  it("answers the calendar files in text and the overlay's data in JSON", async () => {
    for (let i = 0; i < PUBLIC_GET_LIMITS.calendar.limit; i += 1) {
      limitPublicGet(from("203.0.113.7"), "calendar", T0);
    }
    for (let i = 0; i < PUBLIC_GET_LIMITS.overlay.limit; i += 1) {
      limitPublicGet(from("203.0.113.7"), "overlay", T0);
    }
    const calendar = limitPublicGet(from("203.0.113.7"), "calendar", T0);
    expect(await calendar?.text()).toBe("Too many requests");
    const overlay = limitPublicGet(from("203.0.113.7"), "overlay", T0);
    expect(await overlay?.json()).toEqual({ error: "Too many requests" });
  });

  it("keeps the overlay's bucket apart from the calendar's", () => {
    for (let i = 0; i < PUBLIC_GET_LIMITS.overlay.limit; i += 1) {
      limitPublicGet(from("203.0.113.7"), "overlay", T0);
    }
    expect(limitPublicGet(from("203.0.113.7"), "overlay", T0)?.status).toBe(429);
    expect(limitPublicGet(from("203.0.113.7"), "calendar", T0)).toBeNull();
  });
});
