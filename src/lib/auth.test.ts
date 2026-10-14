import { beforeEach, describe, expect, it, vi } from "vitest";

// The weekly re-issue that replaced the Next proxy (src/proxy.ts, removed
// 2026-10-14 for the Hobby plan's CPU budget): the same rules, now behind
// one POST a week instead of a separate function on every page load.

const { jar, setCookie, findUnique, epoch } = vi.hoisted(() => {
  const jar = new Map<string, string>();
  return {
    jar,
    setCookie: vi.fn((name: string, value: string, options: unknown) => {
      void options;
      jar.set(name, value);
    }),
    findUnique: vi.fn(),
    epoch: vi.fn(async () => 3),
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name)! } : undefined,
    set: setCookie,
  }),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // Outside a render pass React's cache passes calls through; the tests read
  // a fresh answer on every call, as route handlers do.
  cache: <T>(fn: T) => fn,
}));
vi.mock("./prisma", () => ({ prisma: { user: { findUnique } } }));
vi.mock("./session-epoch", () => ({ getSessionEpoch: () => epoch() }));

import { SESSION_COOKIE } from "./constants";
import { getSessionRefreshDue, refreshSessionCookie } from "./auth";
import { signSessionToken, verifySessionToken } from "./session-token";

const DAY_MS = 24 * 60 * 60 * 1000;

async function tokenIssued(daysAgo: number, ep = 3) {
  const issued = Date.now() - daysAgo * DAY_MS;
  return signSessionToken(
    { uid: "user-1", ep, at: Math.floor(issued / 1000) },
    issued,
  );
}

beforeEach(() => {
  jar.clear();
  setCookie.mockClear();
  epoch.mockResolvedValue(3);
  findUnique.mockReset().mockResolvedValue({
    id: "user-1",
    steamId: "76561198000000001",
    name: "Player",
    avatar: null,
    role: "PLAYER",
  });
});

describe("getSessionRefreshDue", () => {
  it("is due for a session more than a week old, not for a fresh one", async () => {
    jar.set(SESSION_COOKIE, await tokenIssued(8));
    expect(await getSessionRefreshDue()).toBe(true);
    jar.set(SESSION_COOKIE, await tokenIssued(1));
    expect(await getSessionRefreshDue()).toBe(false);
  });

  it("is never due without a valid cookie, and reads no database", async () => {
    expect(await getSessionRefreshDue()).toBe(false);
    jar.set(SESSION_COOKIE, "not-a-jwt");
    expect(await getSessionRefreshDue()).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("refreshSessionCookie", () => {
  it("re-issues a week-old session with the sign-in cookie's attributes, same user and epoch", async () => {
    jar.set(SESSION_COOKIE, await tokenIssued(8));
    expect(await refreshSessionCookie()).toBe(true);
    expect(setCookie).toHaveBeenCalledOnce();
    const [name, value, options] = setCookie.mock.calls[0];
    expect(name).toBe(SESSION_COOKIE);
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    expect(await verifySessionToken(value)).toMatchObject({ uid: "user-1", ep: 3 });
  });

  it("leaves a fresh session, no session and a bad cookie untouched", async () => {
    for (const token of [await tokenIssued(1), null, "not-a-jwt"]) {
      jar.clear();
      if (token) jar.set(SESSION_COOKIE, token);
      expect(await refreshSessionCookie()).toBe(false);
    }
    expect(setCookie).not.toHaveBeenCalled();
  });

  // The proxy re-issued any validly signed token; this re-issues only a
  // session that still counts, so a revoked one is never extended.
  it("never extends a session the epoch revoked or whose user is gone", async () => {
    jar.set(SESSION_COOKIE, await tokenIssued(8, 2));
    expect(await refreshSessionCookie()).toBe(false);
    jar.set(SESSION_COOKIE, await tokenIssued(8));
    findUnique.mockResolvedValue(null);
    expect(await refreshSessionCookie()).toBe(false);
    expect(setCookie).not.toHaveBeenCalled();
  });
});
