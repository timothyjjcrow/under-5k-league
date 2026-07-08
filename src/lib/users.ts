import type { PrismaClient, User } from "@prisma/client";
import { ROLE } from "./constants";

type UpsertInput = {
  steamId: string;
  name: string;
  avatar: string | null;
  profileUrl: string | null;
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
 * an accidental admin is demoted on their next login). With no allowlist we fall
 * back to zero-config bootstrap — the very first user becomes admin. `forceAdmin`
 * only comes from the dev-login endpoint, which is hard-disabled in production.
 */
export function resolveRole(opts: {
  steamId: string;
  adminSteamIds: string[];
  isFirstUser: boolean;
  forceAdmin?: boolean;
}): typeof ROLE.ADMIN | typeof ROLE.USER {
  if (opts.forceAdmin) return ROLE.ADMIN;
  if (opts.adminSteamIds.length > 0) {
    return opts.adminSteamIds.includes(opts.steamId) ? ROLE.ADMIN : ROLE.USER;
  }
  return opts.isFirstUser ? ROLE.ADMIN : ROLE.USER;
}

/**
 * Create or refresh a league user from a Steam identity. Admin is decided by
 * `resolveRole`. When ADMIN_STEAM_IDS is set the role is enforced on every login
 * (grant AND revoke); without it we never demote, so the bootstrap admin keeps
 * their role.
 */
export async function upsertLeagueUser(
  prisma: PrismaClient,
  input: UpsertInput,
): Promise<User> {
  const adminSteamIds = parseAdminSteamIds(process.env.ADMIN_STEAM_IDS);
  const isFirstUser = (await prisma.user.count()) === 0;
  const role = resolveRole({
    steamId: input.steamId,
    adminSteamIds,
    isFirstUser,
    forceAdmin: input.forceAdmin,
  });
  const listConfigured = adminSteamIds.length > 0;

  return prisma.user.upsert({
    where: { steamId: input.steamId },
    create: {
      steamId: input.steamId,
      name: input.name,
      avatar: input.avatar,
      profileUrl: input.profileUrl,
      role,
    },
    update: {
      name: input.name,
      avatar: input.avatar,
      profileUrl: input.profileUrl,
      // With an allowlist, role is authoritative (grant AND revoke). Without one,
      // only ever grant — never demote an existing (bootstrap) admin.
      ...(listConfigured ? { role } : role === ROLE.ADMIN ? { role } : {}),
    },
  });
}
