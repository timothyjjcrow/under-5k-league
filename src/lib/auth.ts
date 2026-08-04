import { cache } from "react";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "./prisma";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "./constants";
import { getSessionEpoch } from "./session-epoch";
import { parseAdminSteamIds, resolveSessionRole } from "./users";
import { expireHttpOnlyCookie } from "./cookie-policy";

// Session-signing key. Resolved lazily (so a missing secret fails a request,
// not the build) and FAIL-CLOSED: in production a missing/short AUTH_SECRET
// throws instead of silently falling back to a known constant — otherwise
// anyone could forge a session for any userId (uids are public in /players/[id]
// URLs) and take over an admin account. The dev fallback only applies outside
// production so local dev and tests work without config.
const DEV_FALLBACK_SECRET = "insecure-dev-secret-please-change-0123456789abcd";
let cachedSecret: Uint8Array | null = null;

function secret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.AUTH_SECRET;
  if (configured && configured.length >= 32) {
    cachedSecret = new TextEncoder().encode(configured);
    return cachedSecret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET must be set to a random string of at least 32 characters in production.",
    );
  }
  cachedSecret = new TextEncoder().encode(DEV_FALLBACK_SECRET);
  return cachedSecret;
}

export type SessionUser = {
  id: string;
  steamId: string;
  name: string;
  avatar: string | null;
  role: string;
};

/** Sign a session JWT and set it as an httpOnly cookie. Route handlers/actions only. */
export async function createSession(userId: string) {
  const ep = await getSessionEpoch(Date.now());
  const token = await new SignJWT({ uid: userId, ep })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());

  const cookieStore = await cookies();
  // The hardened production name intentionally invalidates sessions from the
  // pre-__Host release. Delete the legacy host cookie where possible so the
  // browser does not keep sending unused credentials.
  if (SESSION_COOKIE !== LEGACY_SESSION_COOKIE) {
    expireHttpOnlyCookie(cookieStore, LEGACY_SESSION_COOKIE);
  }
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function destroySession() {
  const cookieStore = await cookies();
  expireHttpOnlyCookie(cookieStore, SESSION_COOKIE);
  if (SESSION_COOKIE !== LEGACY_SESSION_COOKIE) {
    expireHttpOnlyCookie(cookieStore, LEGACY_SESSION_COOKIE);
  }
}

/**
 * Resolve the currently logged-in user from the session cookie, or null.
 *
 * cache(): one JWT verify + user read per RENDER PASS — the layout and the
 * page (and getSeasonSnapshot) each call this, and they should share the
 * answer. Outside a render dispatcher (route handlers, server actions)
 * cache() passes through and every call reads fresh, so mutations are
 * unaffected; the post-action re-render is a new pass with an empty cache.
 */
export const getSessionUser = cache(async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
    });
    // Reject sessions minted before the current epoch — the break-glass that
    // makes "sign out all users" able to revoke stolen/outstanding tokens.
    const tokenEpoch = Number(payload.ep ?? 0);
    if (tokenEpoch < (await getSessionEpoch(Date.now()))) return null;
    const uid = payload.uid as string;
    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return null;
    return {
      id: user.id,
      steamId: user.steamId,
      name: user.name,
      avatar: user.avatar,
      // ADMIN_STEAM_IDS is an authorization policy, not merely a login-time
      // database synchronizer. Re-evaluate it for every authenticated render/
      // mutation so removing a compromised admin revokes an existing cookie.
      role: resolveSessionRole({
        steamId: user.steamId,
        storedRole: user.role,
        adminSteamIds: parseAdminSteamIds(process.env.ADMIN_STEAM_IDS),
        production: process.env.NODE_ENV === "production",
      }),
    };
  } catch {
    return null;
  }
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new Error("FORBIDDEN");
  return user;
}
