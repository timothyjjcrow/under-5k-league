import { SignJWT, jwtVerify } from "jose";

// The session JWT itself: signing, verifying and the sliding refresh. Kept
// free of the database and of next/headers so src/proxy.ts can re-issue an
// ageing cookie before a page renders. Everything that decides WHETHER a
// session still counts (the session epoch, the user row, the admin
// allowlist) stays in getSessionUser (auth.ts), which runs on every request
// whatever token the browser holds.

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

const DAY_SECONDS = 60 * 60 * 24;

/** How long one issued session (token and cookie) lasts. */
export const SESSION_MAX_AGE_SECONDS = 30 * DAY_SECONDS;

/**
 * A session this old is re-issued on the next page visit, so someone who
 * plays every week never meets the 30-day expiry mid-season. A week keeps
 * re-issues rare: one Set-Cookie per player per week at most.
 */
export const SESSION_REFRESH_AFTER_SECONDS = 7 * DAY_SECONDS;

/**
 * Re-issuing stops this long after the Steam sign-in itself, so a copied
 * cookie can't be kept alive forever just by using it. About two seasons.
 */
export const SESSION_ABSOLUTE_MAX_SECONDS = 180 * DAY_SECONDS;

type SessionClaims = {
  /** The user id. */
  uid: string;
  /** The session epoch the sign-in was minted under (session-epoch.ts). */
  ep: number;
  /** When the player signed in with Steam, in epoch seconds. Carried over
   *  unchanged by every re-issue; the absolute cap counts from it. */
  at: number;
};

export type VerifiedSession = {
  uid: string;
  ep: number;
  /** When this token was issued (null only for a token with no iat). */
  iat: number | null;
  /** Sign-in time; tokens from before re-issuing existed have none and use
   *  their iat, which for them WAS the sign-in. */
  at: number | null;
};

function nowSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

/** Sign a session token valid for SESSION_MAX_AGE_SECONDS from `nowMs`. */
export async function signSessionToken(
  claims: SessionClaims,
  nowMs = Date.now(),
): Promise<string> {
  const now = nowSeconds(nowMs);
  return new SignJWT({ uid: claims.uid, ep: claims.ep, at: claims.at })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_MAX_AGE_SECONDS)
    .sign(secret());
}

/**
 * The claims of a token this deployment signed and that hasn't expired, or
 * null (bad signature, expired, malformed). Says nothing about whether the
 * session still counts: getSessionUser checks the epoch and the user.
 */
export async function verifySessionToken(
  token: string,
  nowMs = Date.now(),
): Promise<VerifiedSession | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
      currentDate: new Date(nowMs),
    });
    if (typeof payload.uid !== "string" || !payload.uid) return null;
    // A token from before the epoch feature has no ep; it reads as 0.
    const ep = Number(payload.ep ?? 0);
    if (!Number.isFinite(ep)) return null;
    return {
      uid: payload.uid,
      ep,
      iat: typeof payload.iat === "number" ? payload.iat : null,
      at: typeof payload.at === "number" ? payload.at : null,
    };
  } catch {
    return null;
  }
}

/**
 * A re-issued copy of `token` when it is due one, else null.
 *
 * Due means: validly signed and unexpired, issued at least
 * SESSION_REFRESH_AFTER_SECONDS ago, and the new token would still end
 * within SESSION_ABSOLUTE_MAX_SECONDS of the sign-in. The copy keeps the
 * SAME uid, epoch and sign-in time, so revoking all sessions (an epoch bump)
 * still rejects it, and the admin allowlist is still re-read on every request
 * because nothing about the role is in the token.
 */
export async function refreshSessionToken(
  token: string,
  nowMs = Date.now(),
): Promise<string | null> {
  const session = await verifySessionToken(token, nowMs);
  if (!session || session.iat === null) return null;
  const now = nowSeconds(nowMs);
  if (now - session.iat < SESSION_REFRESH_AFTER_SECONDS) return null;
  const signedInAt = session.at ?? session.iat;
  if (now + SESSION_MAX_AGE_SECONDS > signedInAt + SESSION_ABSOLUTE_MAX_SECONDS) {
    return null;
  }
  return signSessionToken(
    { uid: session.uid, ep: session.ep, at: signedInAt },
    nowMs,
  );
}

/** The session cookie's attributes, shared by sign-in and re-issue. */
export function sessionCookieOptions(
  production = process.env.NODE_ENV === "production",
) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: production,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
