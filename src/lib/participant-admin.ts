import type { Prisma } from "@prisma/client";
import { parseAdminSteamIds, resolveSessionRole } from "./users";
import { UserFacingError } from "./user-facing-error";

type ParticipantAdmin = { id: string; name: string; steamId: string; role: string };

function isCurrentAdmin(actor: ParticipantAdmin) {
  return resolveSessionRole({ steamId: actor.steamId, storedRole: actor.role,
    adminSteamIds: parseAdminSteamIds(process.env.ADMIN_STEAM_IDS),
    production: process.env.NODE_ENV === "production" }) === "ADMIN";
}

export async function readParticipantAdmin(tx: Prisma.TransactionClient, actorId: string) {
  const actor = await tx.user.findUnique({ where: { id: actorId },
    select: { id: true, name: true, steamId: true, role: true } });
  if (!actor || !isCurrentAdmin(actor)) throw new UserFacingError("You are no longer an administrator.");
  return actor;
}

/** Lock the same identity/role snapshot without promoting an allowlisted USER. */
export async function claimParticipantAdmin(tx: Prisma.TransactionClient, actor: ParticipantAdmin) {
  if (!isCurrentAdmin(actor)) throw new UserFacingError("You are no longer an administrator.");
  const claim = await tx.user.updateMany({
    where: { id: actor.id, steamId: actor.steamId, role: actor.role }, data: { role: actor.role },
  });
  if (claim.count !== 1) throw new UserFacingError("You are no longer an administrator.");
}
