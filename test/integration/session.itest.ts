import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { SignJWT } from "jose";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));

// PARTIAL mock: requireAdmin is stubbed (revokeAllSessions is an admin action),
// but createSession/getSessionUser stay REAL — the whole point of the JWT-path
// tests below is to exercise the actual sign → cookie → verify → epoch-check
// pipeline, not a re-implementation of it.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireAdmin: vi.fn(),
}));

// createSession/getSessionUser talk to next/headers' cookies(), which only
// exists inside a real request scope. An in-memory jar standing in for the
// cookie store is the one seam this needs — everything past it (jose signing,
// verification, the epoch comparison, the user lookup) runs for real.
const jar = vi.hoisted(() => new Map<string, string>());
const jarOptions = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name)! } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      if (options.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
      jarOptions.set(name, options);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

import { revokeAllSessions } from "@/app/actions/admin";
import { getSessionEpoch, bumpSessionEpoch } from "@/lib/session-epoch";
import { createSession, destroySession, getSessionUser } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { makeUser } from "./factories";

afterEach(() => vi.unstubAllEnvs());

// Read the persisted epoch directly (bypasses the in-process cache in
// session-epoch.ts so assertions see the DB truth).
async function storedEpoch(): Promise<number> {
  const row = await prisma.setting.findUnique({
    where: { key: "sessionEpoch" },
  });
  return row ? Number(row.value) : 0;
}

describe("session revocation (break-glass epoch)", () => {
  it("revokeAllSessions advances the stored epoch", async () => {
    expect(await storedEpoch()).toBe(0);

    const res = await revokeAllSessions({}, new FormData());

    expect(res?.message).toMatch(/Signed out all users/);
    expect(await storedEpoch()).toBe(1);
  });

  it("bumpSessionEpoch is monotonic from 0", async () => {
    // beforeEach resets the DB, so the epoch starts unset (0).
    expect(await bumpSessionEpoch()).toBe(1);
    expect(await bumpSessionEpoch()).toBe(2);
    expect(await storedEpoch()).toBe(2);
  });

  it("getSessionEpoch reads the stored value (cache-busted by a later timestamp)", async () => {
    expect(await getSessionEpoch(0)).toBe(0);
    await bumpSessionEpoch(); // clears the cache
    // well past the 30s cache TTL so we read fresh regardless of prior caching
    expect(await getSessionEpoch(10_000_000)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The real JWT path. R35: the revocation feature was previously tested only up
// to the number in the Setting row — nothing proved that a minted token is
// actually REJECTED once the epoch moves past it.
// ---------------------------------------------------------------------------

/** Mirror auth.ts's module-private secret(): AUTH_SECRET when it's a real
 *  (32+ char) value, else the dev fallback. Needed to mint tokens auth.ts
 *  didn't (the pre-epoch legacy shape) with a signature it will accept. */
function signingSecret(): Uint8Array {
  const configured = process.env.AUTH_SECRET;
  const raw =
    configured && configured.length >= 32
      ? configured
      : "insecure-dev-secret-please-change-0123456789abcd";
  return new TextEncoder().encode(raw);
}

/** session-epoch.ts caches the epoch in-process for 30s and that cache
 *  outlives resetDb, so a test that minted/bumped can poison the next one.
 *  A read stamped 2 minutes in the future forces a fresh DB read (and parks
 *  the cache on it, so the internal Date.now() reads inside getSessionUser
 *  see the same value until the next bump clears it). */
async function syncEpochCache() {
  await getSessionEpoch(Date.now() + 120_000);
}

describe("session JWT path (real createSession/getSessionUser)", () => {
  beforeEach(async () => {
    jar.clear();
    jarOptions.clear();
    await syncEpochCache();
  });

  it("createSession sets the cookie and getSessionUser resolves the user through it", async () => {
    const user = await makeUser("Session Holder");
    await createSession(user.id);

    expect(jar.get(SESSION_COOKIE)).toBeTruthy();
    expect(jarOptions.get(SESSION_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    const session = await getSessionUser();
    expect(session).toMatchObject({
      id: user.id,
      steamId: user.steamId,
      name: "Session Holder",
      role: "USER",
    });
  });

  it("revokes an allowlisted admin on the next request without replacing their cookie", async () => {
    const user = await makeUser("Allowlisted Admin", "ADMIN");
    vi.stubEnv("ADMIN_STEAM_IDS", user.steamId);
    await createSession(user.id);

    const token = jar.get(SESSION_COOKIE);
    expect(await getSessionUser()).toMatchObject({
      id: user.id,
      role: "ADMIN",
    });

    // Simulate an incident-response env change while the 30-day JWT remains
    // in the browser. Authorization must follow the live allowlist, not the
    // stale DB role or anything copied into the token.
    vi.stubEnv("ADMIN_STEAM_IDS", "76561199999999999");
    expect(jar.get(SESSION_COOKIE)).toBe(token);
    expect(await getSessionUser()).toMatchObject({
      id: user.id,
      role: "USER",
    });
  });

  it("an epoch bump revokes an outstanding token; a re-login mints a valid one", async () => {
    const user = await makeUser("Revoked");
    await createSession(user.id);
    expect((await getSessionUser())?.id).toBe(user.id);

    await bumpSessionEpoch();

    // The token is intact in the jar — rejection is the epoch comparison
    // inside jwtVerify's aftermath, not a cleared cookie. This is exactly the
    // stolen-token case the break-glass exists for: the holder still HAS the
    // cookie, and it no longer works.
    expect(jar.get(SESSION_COOKIE)).toBeTruthy();
    expect(await getSessionUser()).toBeNull();

    // Logging in again mints a token at the CURRENT epoch — equal is accepted
    // (the check is strictly "minted before", so a bump never locks everyone
    // out of logging back in).
    await createSession(user.id);
    expect((await getSessionUser())?.id).toBe(user.id);
  });

  it("a legacy token with no ep claim is grandfathered until the first bump", async () => {
    const user = await makeUser("Legacy");
    // The shape every session had before the epoch feature shipped: uid only.
    const token = await new SignJWT({ uid: user.id })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(signingSecret());
    jar.set(SESSION_COOKIE, token);

    // Epoch 0 (never bumped): the missing claim reads as 0, 0 < 0 is false —
    // deploying the feature must not force a re-login on its own.
    expect((await getSessionUser())?.id).toBe(user.id);

    // First bump: the grandfathering ends and the legacy token dies with
    // every other pre-bump session.
    await bumpSessionEpoch();
    expect(await getSessionUser()).toBeNull();
  });

  it("a token signed with the wrong secret is rejected (forgery)", async () => {
    const user = await makeUser("Target");
    const token = await new SignJWT({ uid: user.id, ep: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode("wrong-secret-wrong-secret-wrong-secret!"));
    jar.set(SESSION_COOKIE, token);
    expect(await getSessionUser()).toBeNull();
  });

  it("no cookie / garbage cookie / deleted user all resolve to null", async () => {
    expect(await getSessionUser()).toBeNull(); // empty jar

    jar.set(SESSION_COOKIE, "not-a-jwt");
    expect(await getSessionUser()).toBeNull();

    const user = await makeUser("Ghost");
    await createSession(user.id);
    expect((await getSessionUser())?.id).toBe(user.id);
    await prisma.user.delete({ where: { id: user.id } });
    expect(await getSessionUser()).toBeNull(); // valid token, vanished user
  });

  it("reads the current database role instead of trusting a role in the JWT", async () => {
    const user = await makeUser("Promoted Later");
    await createSession(user.id);
    expect((await getSessionUser())?.role).toBe("USER");

    await prisma.user.update({
      where: { id: user.id },
      data: { role: "ADMIN" },
    });

    expect((await getSessionUser())?.role).toBe("ADMIN");
  });

  it("destroySession deletes the cookie", async () => {
    const user = await makeUser("Leaver");
    await createSession(user.id);
    expect((await getSessionUser())?.id).toBe(user.id);

    await destroySession();
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(jarOptions.get(SESSION_COOKIE)).toMatchObject({
      expires: new Date(0),
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "lax",
      secure: false,
    });
    expect(await getSessionUser()).toBeNull();
  });
});
