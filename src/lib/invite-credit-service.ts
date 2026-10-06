import { REGISTRATION_STATUS } from "./constants";
import { inviteCreditApplies, isInviteRef } from "./invite-credit";
import { prisma } from "./prisma";

/**
 * The name to credit in a new full player's Discord signup post ("invited by
 * Borpo"), or null. Reads only and stores nothing (the small invite credit;
 * invite-credit.ts): the inviter must hold an ACTIVE signup in this season,
 * and the new player must have no signup in any other season.
 */
export async function inviterForSignup(input: {
  seasonId: string;
  newUserId: string;
  ref: string | null;
}): Promise<string | null> {
  const { seasonId, newUserId, ref } = input;
  if (!isInviteRef(ref) || ref === newUserId) return null;
  const [inviter, earlierSignups] = await Promise.all([
    prisma.registration.findFirst({
      where: { seasonId, userId: ref, status: REGISTRATION_STATUS.ACTIVE },
      select: { user: { select: { name: true } } },
    }),
    prisma.registration.count({
      where: { userId: newUserId, seasonId: { not: seasonId } },
    }),
  ]);
  return inviter &&
    inviteCreditApplies({
      ref,
      newUserId,
      inviterSignedUp: true,
      newUserSignedUpBefore: earlierSignups > 0,
    })
    ? inviter.user.name
    : null;
}
