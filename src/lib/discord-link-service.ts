// Discord-link persistence + the callback decision core (reschedule-service
// pattern: all guards live here, deps injected, integration-tested in
// test/integration/discord-link.itest.ts; the route handlers stay thin).

import type { PrismaClient } from "@prisma/client";
import {
  discordProfileFromMe,
  exchangeDiscordCode,
  fetchDiscordIdentity,
  oauthLandingPath,
  safeEqual,
  unpackOauthCookie,
  type DiscordProfile,
} from "./discord-oauth";
import {
  getGuildConfig,
  getRoleConfig,
  joinGuild,
  primeMembershipMemo,
  setPingRole,
  type GuildJoin,
} from "./discord-roles";

type Db = Pick<PrismaClient, "user">;

export type LinkResult =
  | {
      ok: true;
      /**
       * The discordId this link REPLACED, when it differs from the new one —
       * the callback strips the ping role from it. Leaving the role behind
       * re-creates the exact failure unlinkDiscord refuses to ship: the OLD
       * account keeps getting pinged, and the off switch renders only for the
       * account currently linked.
       */
      previousDiscordId: string | null;
    }
  | { ok: false; error: "taken" };

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
  const [holder, self] = await Promise.all([
    db.user.findUnique({
      where: { discordId: profile.discordId },
      select: { id: true },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { discordId: true },
    }),
  ]);
  if (holder && holder.id !== userId) return { ok: false, error: "taken" };
  try {
    await db.user.update({
      where: { id: userId },
      data: { discordId: profile.discordId, discordName: profile.discordName },
    });
    // KNOWN LIMIT: `prior` is a pre-update read, so two of the SAME user's
    // callbacks racing with different new accounts can each miss the other's
    // id and leave one replaced account holding the ping role. Accepted: the
    // window is one user double-completing OAuth simultaneously, the damage
    // is a stale role the unlink/opt-out paths already recover, and closing
    // it would put a transaction on the OAuth path for a best-effort cleanup.
    const prior = self?.discordId ?? null;
    return {
      ok: true,
      previousDiscordId:
        prior && prior !== profile.discordId ? prior : null,
    };
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
  /**
   * Put the freshly-linked player in the league's server. Returns null when
   * the league has no bot configured — the identify-only world, where linking
   * is the whole outcome.
   */
  joinGuild: (
    discordId: string,
    accessToken: string,
  ) => Promise<GuildJoin | null>;
  /**
   * Take the ping role off a discordId this link just REPLACED (re-linking a
   * different account). Best-effort by contract: the link is already
   * committed when this runs, and stripping a role from an account the user
   * abandoned must never cost them the link.
   */
  stripPingRole: (discordId: string) => Promise<void>;
};

const DEFAULT_DEPS: CallbackDeps = {
  exchange: exchangeDiscordCode,
  fetchIdentity: fetchDiscordIdentity,
  joinGuild: async (discordId, accessToken) => {
    const cfg = getGuildConfig();
    if (!cfg) return null;
    return joinGuild(discordId, accessToken, cfg);
  },
  stripPingRole: async (discordId) => {
    const cfg = await getRoleConfig();
    if (!cfg) return; // no ping role configured — nothing to strip
    await setPingRole(discordId, false, cfg);
  },
};

/**
 * Join outcome → the ?discord= code /me renders. `linked` stays the plain
 * "it worked" for the no-bot case, so nothing about the identify-only flow
 * changes. A failed join NEVER fails the link: the account is already tied to
 * the site, and the player just needs the invite instead.
 */
const JOIN_CODES: Record<GuildJoin, string> = {
  joined: "joined",
  "joined-pending": "joined_pending",
  already: "linked",
  forbidden: "join_failed",
  failed: "join_failed",
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
  // Session gone → sign in and retry. Carry a one-shot explanation through
  // the validated return path so landing back on /me doesn't look like the
  // Discord link silently did nothing.
  if (!input.userId) {
    return { redirect: "/login?next=%2Fme%3Fdiscord%3Dsession" };
  }

  // User clicked Cancel on Discord's consent screen — a normal outcome.
  if (input.errorParam) return { redirect: "/me?discord=denied" };

  // CSRF gate: the state must round-trip AND match this browser's cookie.
  const packed = unpackOauthCookie(input.cookie);
  if (
    !packed ||
    !input.state ||
    !safeEqual(packed.state, input.state) ||
    !safeEqual(packed.userId, input.userId)
  ) {
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

  // The link is committed. Everything past here is a bonus that must not be
  // able to undo it — hence the swallows: a bot outage, a missing permission
  // or a mismatched application costs the player the auto-join, never the
  // link; and a failed strip of the OLD account's ping role costs nothing
  // visible at all (the next unlink/opt-out attempt can retry it).
  if (linked.previousDiscordId) {
    try {
      await deps.stripPingRole(linked.previousDiscordId);
    } catch {
      /* best-effort by contract */
    }
  }
  let join: GuildJoin | null = null;
  try {
    join = await deps.joinGuild(profile.discordId, token);
  } catch {
    join = "failed";
  }
  // The join we just performed is the freshest membership answer there is —
  // prime the memo with it, or a success bound for the dashboard re-renders
  // the memoised "not-member" join nag for up to a recheck-TTL right after
  // the player joined, which reads as the click having done nothing.
  if (join === "joined" || join === "already") {
    primeMembershipMemo(profile.discordId, "member");
  } else if (join === "joined-pending") {
    primeMembershipMemo(profile.discordId, "pending");
  }
  return {
    redirect: oauthLandingPath(join ? JOIN_CODES[join] : "linked", packed.next),
  };
}

// Re-exported so the itest can build valid payload shapes the same way the
// fetcher does.
export { discordProfileFromMe };
