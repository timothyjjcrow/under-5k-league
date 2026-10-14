import { cache } from "react";
import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "./constants";
import { getSessionEpoch } from "./session-epoch";
import { parseAdminSteamIds, resolveSessionRole } from "./users";
import { expireHttpOnlyCookie } from "./cookie-policy";
import {
  refreshSessionToken,
  sessionCookieOptions,
  sessionRefreshDue,
  signSessionToken,
  verifySessionToken,
} from "./session-token";

export type SessionUser = {
  id: string;
  steamId: string;
  name: string;
  avatar: string | null;
  role: string;
};

/**
 * Sign a session JWT and set it as an httpOnly cookie. Route handlers/actions
 * only. refreshSessionCookie re-issues it (same user, epoch and sign-in time)
 * once it is a week old, so an active player stays signed in.
 */
export async function createSession(userId: string) {
  const now = Date.now();
  const ep = await getSessionEpoch(now);
  const token = await signSessionToken(
    { uid: userId, ep, at: Math.floor(now / 1000) },
    now,
  );

  const cookieStore = await cookies();
  // The hardened production name intentionally invalidates sessions from the
  // pre-__Host release. Delete the legacy host cookie where possible so the
  // browser does not keep sending unused credentials.
  if (SESSION_COOKIE !== LEGACY_SESSION_COOKIE) {
    expireHttpOnlyCookie(cookieStore, LEGACY_SESSION_COOKIE);
  }
  cookieStore.set(SESSION_COOKIE, token, sessionCookieOptions());
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
    const session = await verifySessionToken(token);
    if (!session) return null;
    // Reject sessions minted before the current epoch — the break-glass that
    // makes "sign out all users" able to revoke stolen/outstanding tokens. A
    // re-issued token keeps its original epoch, so this still catches it.
    if (session.ep < (await getSessionEpoch(Date.now()))) return null;
    const uid = session.uid;
    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: {
        id: true,
        steamId: true,
        name: true,
        avatar: true,
        role: true,
      },
    });
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

/**
 * Is the viewer's session cookie due its weekly re-issue? The root layout asks
 * once per render pass and, only then, mounts <SessionRefresh>, which calls
 * POST /api/auth/refresh. One call per player per week replaced the Next
 * proxy, a separate, often cold Vercel function that ran on every signed-in
 * page load to do the same (the Hobby plan's CPU budget, DECISIONS.md).
 */
export const getSessionRefreshDue = cache(async function getSessionRefreshDue(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const session = await verifySessionToken(token);
  return session !== null && sessionRefreshDue(session);
});

/**
 * Re-issue the session cookie when it is due (refreshSessionToken: the same
 * user, epoch and sign-in time, never past the absolute cap), for a session
 * that still counts (getSessionUser: the epoch, the user row). Route handlers
 * only. True when a fresh cookie was set.
 */
export async function refreshSessionCookie(): Promise<boolean> {
  if (!(await getSessionUser())) return false;
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const fresh = token ? await refreshSessionToken(token) : null;
  if (!fresh) return false;
  cookieStore.set(SESSION_COOKIE, fresh, sessionCookieOptions());
  return true;
}

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
