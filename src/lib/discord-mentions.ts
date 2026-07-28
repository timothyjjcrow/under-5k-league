import { prisma } from "./prisma";
import type { MentionAllowlist } from "./discord";

// Turning a site user into someone Discord will actually notify.
//
// `sendDiscordMessage` has taken a MentionAllowlist since the mention work
// landed, but for a long time only the inhouse queue ping and the week
// reminder passed one — so the announcements that END BY NAMING AN ACTION
// ("captains: line up a standin", "the other captain can respond") went out
// as plain text and notified nobody. These helpers are what the rest of them
// use; they exist so no call site has to hand-roll the null filtering and
// accidentally send `{ users: [undefined] }`.
//
// Only `discordId` is ever mentionable: it is the OAuth-proven snowflake. The
// typed `discordName` fallback is a string a captain copies by hand, and no
// amount of it makes someone pingable — which is exactly why getDiscordReach
// counts links rather than handles.

/**
 * Build an allowlist from snowflakes already in hand. Nulls and duplicates are
 * dropped; `undefined` when nobody is left, so the send behaves EXACTLY as it
 * did before mentions existed on a league where nobody has linked.
 */
export function mentionsOf(
  discordIds: (string | null | undefined)[],
): MentionAllowlist | undefined {
  const users = [...new Set(discordIds.filter((id): id is string => !!id))];
  return users.length ? { users } : undefined;
}

/**
 * Resolve site user ids to an allowlist. One indexed read; call it on mutation
 * paths only (it is never worth a query on a render path — the reminder builds
 * its list from rows it has already loaded).
 */
export async function mentionUsers(
  userIds: (string | null | undefined)[],
): Promise<MentionAllowlist | undefined> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (!ids.length) return undefined;
  const rows = await prisma.user.findMany({
    where: { id: { in: ids }, discordId: { not: null } },
    select: { discordId: true },
  });
  return mentionsOf(rows.map((r) => r.discordId));
}
