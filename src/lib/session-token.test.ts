import { describe, expect, it } from "vitest";
import { SignJWT, decodeJwt } from "jose";
import {
  SESSION_ABSOLUTE_MAX_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  SESSION_REFRESH_AFTER_SECONDS,
  refreshSessionToken,
  sessionCookieOptions,
  signSessionToken,
  verifySessionToken,
} from "./session-token";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 7, 18, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

// The dev fallback key session-token.ts signs with when AUTH_SECRET is unset,
// so a hand-made legacy token carries a signature it accepts.
function devSecret(): Uint8Array {
  const configured = process.env.AUTH_SECRET;
  return new TextEncoder().encode(
    configured && configured.length >= 32
      ? configured
      : "insecure-dev-secret-please-change-0123456789abcd",
  );
}

async function tokenIssued(daysAgo: number, signedInDaysAgo = daysAgo, ep = 3) {
  return signSessionToken(
    { uid: "user-1", ep, at: sec(NOW - signedInDaysAgo * DAY_MS) },
    NOW - daysAgo * DAY_MS,
  );
}

describe("signSessionToken / verifySessionToken", () => {
  it("round-trips the user, the epoch and the sign-in time", async () => {
    const token = await tokenIssued(0);
    expect(await verifySessionToken(token, NOW)).toEqual({
      uid: "user-1",
      ep: 3,
      iat: sec(NOW),
      at: sec(NOW),
    });
    expect(decodeJwt(token).exp).toBe(sec(NOW) + SESSION_MAX_AGE_SECONDS);
  });

  it("rejects a forged, garbled or expired token", async () => {
    const forged = await new SignJWT({ uid: "user-1", ep: 99 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(sec(NOW))
      .setExpirationTime(sec(NOW) + 3600)
      .sign(new TextEncoder().encode("wrong-secret-wrong-secret-wrong-secret!"));
    expect(await verifySessionToken(forged, NOW)).toBeNull();
    expect(await verifySessionToken("not-a-jwt", NOW)).toBeNull();
    expect(await verifySessionToken(await tokenIssued(31), NOW)).toBeNull();
  });

  it("reads a token from before the epoch and sign-in claims existed", async () => {
    const legacy = await new SignJWT({ uid: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(sec(NOW))
      .setExpirationTime(sec(NOW) + 3600)
      .sign(devSecret());
    expect(await verifySessionToken(legacy, NOW)).toEqual({
      uid: "user-1",
      ep: 0,
      iat: sec(NOW),
      at: null,
    });
  });
});

describe("refreshSessionToken", () => {
  it("leaves a session under a week old alone", async () => {
    expect(SESSION_REFRESH_AFTER_SECONDS).toBe(7 * 86400);
    expect(await refreshSessionToken(await tokenIssued(0), NOW)).toBeNull();
    expect(await refreshSessionToken(await tokenIssued(6.9), NOW)).toBeNull();
  });

  it("re-issues an older one for another 30 days, same user, epoch and sign-in", async () => {
    const fresh = await refreshSessionToken(await tokenIssued(8), NOW);
    expect(fresh).not.toBeNull();
    expect(await verifySessionToken(fresh!, NOW)).toEqual({
      uid: "user-1",
      ep: 3,
      iat: sec(NOW),
      at: sec(NOW - 8 * DAY_MS),
    });
    expect(decodeJwt(fresh!).exp).toBe(sec(NOW) + SESSION_MAX_AGE_SECONDS);
    // Still good 29 days on, when the original had long expired.
    expect(await verifySessionToken(fresh!, NOW + 29 * DAY_MS)).not.toBeNull();
  });

  it("dates a legacy token's sign-in from its issue time", async () => {
    const legacy = await new SignJWT({ uid: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(sec(NOW - 10 * DAY_MS))
      .setExpirationTime(sec(NOW - 10 * DAY_MS) + SESSION_MAX_AGE_SECONDS)
      .sign(devSecret());
    const fresh = await refreshSessionToken(legacy, NOW);
    expect(await verifySessionToken(fresh!, NOW)).toMatchObject({
      uid: "user-1",
      ep: 0,
      at: sec(NOW - 10 * DAY_MS),
    });
  });

  it("stops re-issuing once the new token would outlive the sign-in cap", async () => {
    const capDays = SESSION_ABSOLUTE_MAX_SECONDS / 86400;
    const maxDays = SESSION_MAX_AGE_SECONDS / 86400;
    // Signed in long enough ago that another 30 days would pass the cap.
    expect(
      await refreshSessionToken(await tokenIssued(8, capDays - maxDays + 1), NOW),
    ).toBeNull();
    // Exactly at the cap is still allowed.
    expect(
      await refreshSessionToken(await tokenIssued(8, capDays - maxDays), NOW),
    ).not.toBeNull();
  });

  it("never re-issues a token it can't verify", async () => {
    const forged = await new SignJWT({ uid: "user-1", ep: 0, at: sec(NOW) })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(sec(NOW - 8 * DAY_MS))
      .setExpirationTime(sec(NOW) + 3600)
      .sign(new TextEncoder().encode("wrong-secret-wrong-secret-wrong-secret!"));
    expect(await refreshSessionToken(forged, NOW)).toBeNull();
    expect(await refreshSessionToken(await tokenIssued(31), NOW)).toBeNull();
  });
});

describe("sessionCookieOptions", () => {
  it("keeps the sign-in cookie's attributes", () => {
    expect(sessionCookieOptions(false)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    expect(sessionCookieOptions(true).secure).toBe(true);
  });
});
