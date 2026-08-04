import type { PrismaClient, User } from "@prisma/client";
import { ROLE } from "./constants";
import { fetchPubStats, fetchRankTier, steamIdToAccountId } from "./dota";
import { placeholderPersona, steamProfileUrl } from "./steam";
import { SETTING_KEYS } from "./settings";

type UpsertInput = {
  steamId: string;
  /** Steam profile, or NULL when Steam couldn't be reached. A null profile
   *  leaves an existing user's stored name/avatar alone — see below. */
  profile: { name: string; avatar: string | null; profileUrl: string | null } | null;
  forceAdmin?: boolean;
};

/** Parse ADMIN_STEAM_IDS (comma-separated SteamID64s) into a clean list. */
export function parseAdminSteamIds(value: string | undefined | null): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Decide a user's role at login.
 *
 * If ADMIN_STEAM_IDS is configured it is AUTHORITATIVE: exactly those SteamIDs
 * are admins and everyone else is a plain user (so nobody can slip through and
 * an accidental admin is demoted on their next login). With no allowlist local
 * development can bootstrap the first user; production passes
 * bootstrapAllowed=false and fails closed. `forceAdmin` only comes from the
 * dev-login endpoint, which is hard-disabled in production.
 */
export function resolveRole(opts: {
  steamId: string;
  adminSteamIds: string[];
  isFirstUser: boolean;
  forceAdmin?: boolean;
  /** Local-development convenience only. Production must use an allowlist. */
  bootstrapAllowed?: boolean;
}): typeof ROLE.ADMIN | typeof ROLE.USER {
  if (opts.forceAdmin) return ROLE.ADMIN;
  if (opts.adminSteamIds.length > 0) {
    return opts.adminSteamIds.includes(opts.steamId) ? ROLE.ADMIN : ROLE.USER;
  }
  return opts.bootstrapAllowed !== false && opts.isFirstUser
    ? ROLE.ADMIN
    : ROLE.USER;
}

/**
 * Resolve authorization from the current allowlist, not a role copied into a
 * 30-day session or a database row last reconciled at login. Removing a Steam
 * ID therefore revokes admin access on the next request. An empty production
 * allowlist fails closed to USER; deploy validation explains the configuration
 * error before traffic reaches this fallback.
 */
export function resolveSessionRole(opts: {
  steamId: string;
  storedRole: string;
  adminSteamIds: string[];
  production: boolean;
}): typeof ROLE.ADMIN | typeof ROLE.USER {
  if (opts.adminSteamIds.length > 0) {
    return opts.adminSteamIds.includes(opts.steamId) ? ROLE.ADMIN : ROLE.USER;
  }
  if (opts.production) return ROLE.USER;
  return opts.storedRole === ROLE.ADMIN ? ROLE.ADMIN : ROLE.USER;
}

/**
 * Create or refresh a league user from a Steam identity. Admin is decided by
 * `resolveRole`. When ADMIN_STEAM_IDS is set the role is enforced on every login
 * (grant AND revoke); without it local development never demotes, so its
 * bootstrap admin keeps their role. Production never bootstraps this path.
 */
export async function upsertLeagueUser(
  prisma: PrismaClient,
  input: UpsertInput,
): Promise<User> {
  const adminSteamIds = parseAdminSteamIds(process.env.ADMIN_STEAM_IDS);
  const listConfigured = adminSteamIds.length > 0;
  const bootstrapAllowed = process.env.NODE_ENV !== "production";
  const verifiedDotaAccountId = steamIdToAccountId(input.steamId);

  return prisma.$transaction(async (tx) => {
    if (verifiedDotaAccountId != null) {
      // Steam OpenID proves ownership of `input.steamId`, and a Dota account
      // id is deterministically derived from that identity. Older versions of
      // the profile form allowed an unverified manual override, so a legacy
      // user may still hold this newly authenticated owner's account id. The
      // verified owner wins: retire the stale override and every OpenDota
      // field fetched through it before returning the login. Keeping this in
      // the same transaction as the owner upsert prevents a successful login
      // from publishing two effective users for one Dota account.
      await tx.user.updateMany({
        where: {
          steamId: { not: input.steamId },
          dotaAccountId: verifiedDotaAccountId,
        },
        data: {
          dotaAccountId: null,
          rankTier: null,
          fhUnavailable: null,
          pubStats: null,
          pubStatsAt: null,
        },
      });
    }

    const isFirstUser = (await tx.user.count()) === 0;
    let ownsBootstrapClaim = false;
    if (
      bootstrapAllowed &&
      !listConfigured &&
      !input.forceAdmin &&
      isFirstUser
    ) {
      // A conflict-skipping INSERT is the database-native unique-key claim.
      // Prisma's nominal `upsert(..., update: {})` can still compile to a
      // read/create sequence and surface P2002 under real PostgreSQL
      // contention. Prisma 5 does not expose createMany(skipDuplicates) for
      // SQLite, but both supported databases implement this standard ON
      // CONFLICT form. It blocks on the unique index and lets the loser keep a
      // usable transaction; both callers then read the one stored winner.
      await tx.$executeRaw`
        INSERT INTO "Setting" ("key", "value")
        VALUES (${SETTING_KEYS.BOOTSTRAP_ADMIN_STEAM_ID}, ${input.steamId})
        ON CONFLICT ("key") DO NOTHING
      `;
      const claim = await tx.setting.findUniqueOrThrow({
        where: { key: SETTING_KEYS.BOOTSTRAP_ADMIN_STEAM_ID },
      });
      ownsBootstrapClaim = claim.value === input.steamId;
    }
    const role = resolveRole({
      steamId: input.steamId,
      adminSteamIds,
      isFirstUser: ownsBootstrapClaim,
      forceAdmin: input.forceAdmin,
      bootstrapAllowed,
    });

    // A brand-new account has nothing to preserve, so an unreachable Steam
    // still gets a usable placeholder. An EXISTING account keeps whatever it
    // already has: overwriting a real persona name with `Player NNNNN` because
    // Steam blipped is data loss the player can't undo themselves.
    const profile = input.profile;
    return tx.user.upsert({
      where: { steamId: input.steamId },
      create: {
        steamId: input.steamId,
        name: profile?.name ?? placeholderPersona(input.steamId),
        avatar: profile?.avatar ?? null,
        profileUrl: profile?.profileUrl ?? steamProfileUrl(input.steamId),
        role,
      },
      update: {
        ...(profile
          ? {
              name: profile.name,
              avatar: profile.avatar,
              profileUrl: profile.profileUrl,
            }
          : {}),
        // With an allowlist, role is authoritative (grant AND revoke). Without
        // one, only ever grant — never demote an existing bootstrap admin.
        ...(listConfigured ? { role } : role === ROLE.ADMIN ? { role } : {}),
      },
    });
  });
}

/**
 * Best-effort: fill in a user's ranked medal from OpenDota if they don't have
 * one yet. Called at login so EVERY account gets a medal — not only players who
 * sign up (signup + the admin sync only ever touch registrants, which is why a
 * logged-in-but-not-registered account showed no medal). Only when they have no
 * medal yet, and only writes a real one — a failed / rate-limited call is a
 * no-op, so it never wipes or blocks login on OpenDota being slow.
 */
export async function ensureRankTier(
  prisma: PrismaClient,
  user: {
    id: string;
    steamId: string;
    dotaAccountId: number | null;
    rankTier: number | null;
  },
): Promise<void> {
  if (user.rankTier != null) return;
  const accountId = user.dotaAccountId ?? steamIdToAccountId(user.steamId);
  if (!accountId) return;
  const result = await fetchRankTier(accountId);
  if (!result.ok) return;
  const data: { rankTier?: number; fhUnavailable?: boolean } = {};
  if (result.rankTier != null) data.rankTier = result.rankTier;
  // The same payload says whether their match data is public — the flag every
  // automatic import path depends on. Only a definite answer is stored.
  if (result.fhUnavailable !== null) data.fhUnavailable = result.fhUnavailable;
  if (Object.keys(data).length > 0) {
    await prisma.user.updateMany({
      // Re-assert both inputs this result describes. A /me relink or another
      // sync completing while OpenDota was in flight wins; stale login data is
      // silently dropped.
      where: {
        id: user.id,
        dotaAccountId: user.dotaAccountId,
        rankTier: null,
      },
      data,
    });
  }
}

/**
 * Best-effort: fill in a user's pub-scouting snapshot (User.pubStats) if they
 * don't have one yet. The ensureRankTier rule exactly: only when the snapshot
 * is MISSING — a one-time cost per account — so login never pays a recurring
 * OpenDota round trip (an earlier staleness gate here put an 8s worst case on
 * roughly every weekly login; staleness is owned by the admin bulk sync and
 * the /me refresh instead). A failed / rate-limited fetch is a no-op, so it
 * never wipes anything and an OpenDota brownout costs one bounded wait.
 */
export async function ensurePubStats(
  prisma: PrismaClient,
  user: {
    id: string;
    steamId: string;
    dotaAccountId: number | null;
    pubStatsAt: Date | null;
  },
  nowMs: number = Date.now(),
): Promise<void> {
  if (user.pubStatsAt != null) return;
  const accountId = user.dotaAccountId ?? steamIdToAccountId(user.steamId);
  if (!accountId) return;
  const result = await fetchPubStats(accountId);
  if (!result.ok) return;
  // The WHERE re-asserts the account the snapshot describes (read-time
  // precondition in the write — the repo rule): a relink committing while
  // this fetch was in flight must not get the OLD account's scouting data
  // stamped onto the new link. count 0 = someone relinked; drop the result.
  await prisma.user.updateMany({
    where: {
      id: user.id,
      dotaAccountId: user.dotaAccountId,
      pubStatsAt: null,
    },
    data: { pubStats: JSON.stringify(result.stats), pubStatsAt: new Date(nowMs) },
  });
}
