import type { PrismaClient, User } from "@prisma/client";
import { ROLE } from "./constants";

type UpsertInput = {
  steamId: string;
  name: string;
  avatar: string | null;
  profileUrl: string | null;
  forceAdmin?: boolean;
};

/**
 * Create or refresh a league user from a Steam identity. Admin is granted if the
 * SteamID is listed in ADMIN_STEAM_IDS, if forceAdmin is passed (dev login), or
 * if this is the very first user in the system (bootstrap the first admin).
 * Existing admins are never demoted here.
 */
export async function upsertLeagueUser(
  prisma: PrismaClient,
  input: UpsertInput,
): Promise<User> {
  const admins = (process.env.ADMIN_STEAM_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const isFirstUser = (await prisma.user.count()) === 0;
  const shouldBeAdmin =
    input.forceAdmin || admins.includes(input.steamId) || isFirstUser;

  return prisma.user.upsert({
    where: { steamId: input.steamId },
    create: {
      steamId: input.steamId,
      name: input.name,
      avatar: input.avatar,
      profileUrl: input.profileUrl,
      role: shouldBeAdmin ? ROLE.ADMIN : ROLE.USER,
    },
    update: {
      name: input.name,
      avatar: input.avatar,
      profileUrl: input.profileUrl,
      ...(shouldBeAdmin ? { role: ROLE.ADMIN } : {}),
    },
  });
}
