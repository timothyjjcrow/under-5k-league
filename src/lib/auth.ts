import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "./prisma";
import { SESSION_COOKIE } from "./constants";

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
  const token = await new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());

  const cookieStore = await cookies();
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
  cookieStore.delete(SESSION_COOKIE);
}

/** Resolve the currently logged-in user from the session cookie, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
    });
    const uid = payload.uid as string;
    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user) return null;
    return {
      id: user.id,
      steamId: user.steamId,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
    };
  } catch {
    return null;
  }
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
