// Discord-link persistence + the callback decision core (reschedule-service
// pattern: all guards live here, deps injected, integration-tested in
// test/integration/discord-link.itest.ts; the route handlers stay thin).

import type { PrismaClient } from "@prisma/client";
import {
  discordProfileFromMe,
  exchangeDiscordCode,
  fetchDiscordIdentity,
  safeEqual,
  unpackOauthCookie,
  type DiscordProfile,
} from "./discord-oauth";

type Db = Pick<PrismaClient, "user">;

export type LinkResult = { ok: true } | { ok: false; error: "taken" };

/**
 * Persist a proven Discord identity onto a user. The @unique on discordId is
 * the real guard (two racing callbacks can't both win); the pre-check only
 * exists to answer "taken by whom" cheaply. Overwrites the user's own prior
 * link (re-linking a new Discord account is a feature, not a conflict).
 */
export async function linkDiscordAccount(
  db: Db,
  userId: string,
  profile: DiscordProfile,
): Promise<LinkResult> {
  const holder = await db.user.findUnique({
    where: { discordId: profile.discordId },
    select: { id: true },
  });
  if (holder && holder.id !== userId) return { ok: false, error: "taken" };
  try {
    await db.user.update({
      where: { id: userId },
      data: { discordId: profile.discordId, discordName: profile.discordName },
    });
    return { ok: true };
  } catch (e) {
    // P2002 = the unique race: someone else linked this Discord account
    // between our pre-check and the write.
    if ((e as { code?: string })?.code === "P2002") {
      return { ok: false, error: "taken" };
    }
    throw e;
  }
}

/** Remove the link AND the handle — unlink means "take my Discord off the site". */
export async function unlinkDiscordAccount(
  db: Db,
  userId: string,
): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { discordId: null, discordName: "" },
  });
}

// ---------- Callback core ----------

export type CallbackInput = {
  /** Session user id, or null if the session died mid-round-trip. */
  userId: string | null;
  /** Query params Discord sent back. */
  code: string | null;
  state: string | null;
  /** Discord's ?error= (e.g. access_denied when the user clicks Cancel). */
  errorParam: string | null;
  /** Raw value of the one-shot state cookie (or null if missing/expired). */
  cookie: string | null;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type CallbackDeps = {
  exchange: typeof exchangeDiscordCode;
  fetchIdentity: typeof fetchDiscordIdentity;
};

const DEFAULT_DEPS: CallbackDeps = {
  exchange: exchangeDiscordCode,
  fetchIdentity: fetchDiscordIdentity,
};

/**
 * Decide the entire callback: every branch returns a same-origin redirect
 * path (never raw input — /me maps known ?discord= codes to copy). Order
 * matters: state is verified BEFORE the code is spent, so a forged callback
 * never costs us a token exchange.
 */
export async function handleDiscordCallback(
  db: Db,
  input: CallbackInput,
  deps: CallbackDeps = DEFAULT_DEPS,
): Promise<{ redirect: string }> {
  // Session gone → sign in and retry (login lands them back on /me).
  if (!input.userId) return { redirect: "/login?next=/me" };

  // User clicked Cancel on Discord's consent screen — a normal outcome.
  if (input.errorParam) return { redirect: "/me?discord=denied" };

  // CSRF gate: the state must round-trip AND match this browser's cookie.
  const packed = unpackOauthCookie(input.cookie);
  if (!packed || !input.state || !safeEqual(packed.state, input.state)) {
    return { redirect: "/me?discord=state" };
  }

  if (!input.code) return { redirect: "/me?discord=error" };

  const token = await deps.exchange({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    code: input.code,
    redirectUri: input.redirectUri,
    codeVerifier: packed.verifier,
  });
  if (!token) return { redirect: "/me?discord=error" };

  const profile = await deps.fetchIdentity(token);
  if (!profile) return { redirect: "/me?discord=error" };

  const linked = await linkDiscordAccount(db, input.userId, profile);
  if (!linked.ok) return { redirect: "/me?discord=taken" };
  return { redirect: "/me?discord=linked" };
}

// Re-exported so the itest can build valid payload shapes the same way the
// fetcher does.
export { discordProfileFromMe };
