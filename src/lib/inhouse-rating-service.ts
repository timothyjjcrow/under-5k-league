// An admin's inhouse MMR and medal for any player, signed up for the league
// or not (Tim, 2026-10-17): the save and /admin/inhouse-players' reads. The
// form's rules and words are in inhouse-rating.ts; joinQueue uses the MMR
// (inhouseFixedMmr) and the cap judges the medal.

import { Prisma } from "@prisma/client";
import { fetchRankTier, parseAccountId } from "./dota";
import {
  dotaAccountClaimWhere,
  dotaAccountLinkSnapshot,
  effectiveDotaAccountId,
} from "./dota-account";
import { adminInhouseMmr } from "./inhouse-mmr-cap";
import {
  INHOUSE_RATING_CHANGED,
  sameInhouseRating,
  type InhouseRating,
  type InhouseRatingInput,
} from "./inhouse-rating";
import { publishInhouseRoomChange } from "./inhouse-room-version";
import { prisma } from "./prisma";
import { isSerializationConflict } from "./prisma-errors";
import { raceHook } from "./race-hook";
import { retrySerializable } from "./serializable-retry";

/** The rating moved after the editor was drawn (thrown past the first write). */
class InhouseRatingChangedError extends Error {}

export type InhouseRatingSaveResult =
  | {
      ok: true;
      name: string;
      before: InhouseRating;
      after: InhouseRating;
      /** In the queue at the save: a set MMR now seeds their spot. */
      queued: boolean;
    }
  | { ok: false; error: string };

/**
 * Save an admin's inhouse MMR and medal for one player. No signup is needed:
 * the MMR lives on the player (`User.inhouseMmr`), and the medal is the
 * site-wide one the league editor (setPlayerRank) also corrects, so a manual
 * medal shows on every page and survives OpenDota refreshes.
 *
 * The claim is the stored rating the editor showed, plus the Dota account
 * link: a second admin's save, the worker's medal refresh or a relinked
 * account landing first refuses this one instead of being overwritten. Going
 * back to OpenDota fetches the medal BEFORE the transaction (never hold one
 * open across a provider call), and the link in the claim keeps a medal
 * fetched for one account off another.
 *
 * A set MMR also rewrites the player's queue spot, so the next game seeds
 * them with it; a cleared one leaves the spot (what they would have typed is
 * gone) until their next join. A player's join re-reads the admin MMR inside
 * its own Serializable transaction, and this one is Serializable too: a first
 * join still on its way in has no row for the rewrite to find, so the two
 * would otherwise cross and queue them at the typed number.
 */
export async function saveInhouseRating(
  input: InhouseRatingInput,
): Promise<InhouseRatingSaveResult> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      name: true,
      steamId: true,
      dotaAccountIdV2: true,
      legacyDotaAccountId: true,
      rankTier: true,
      rankTierManual: true,
      inhouseMmr: true,
    },
  });
  if (!user) return { ok: false, error: "That player no longer exists." };
  const before: InhouseRating = {
    mmr: adminInhouseMmr(user.inhouseMmr),
    rankTier: user.rankTier,
    manual: user.rankTierManual,
  };
  // A clean refusal before any OpenDota call; the claim below enforces it.
  if (!sameInhouseRating(before, input.expected)) {
    return { ok: false, error: INHOUSE_RATING_CHANGED };
  }
  let rankTier = user.rankTier;
  if (input.medal.manual) {
    rankTier = input.medal.rankTier;
  } else if (user.rankTierManual) {
    // Back to OpenDota: its medal now, or nothing changes.
    const accountId = effectiveDotaAccountId(user);
    if (!accountId) {
      return { ok: false, error: "This player has no Dota account to fetch a medal from." };
    }
    const fetched = await fetchRankTier(accountId);
    if (!fetched.ok) {
      return {
        ok: false,
        error: "OpenDota couldn't be reached. Nothing was changed: try again later.",
      };
    }
    rankTier = fetched.rankTier;
  }
  const after: InhouseRating = {
    mmr: input.mmr,
    rankTier,
    manual: input.medal.manual,
  };

  await raceHook("inhouseRating.saveInhouseRating.beforeClaim");
  let queued: boolean;
  try {
    queued = await retrySerializable(() =>
      prisma.$transaction(
        async (tx) => {
          const claimed = await tx.user.updateMany({
            where: {
              id: user.id,
              ...dotaAccountLinkSnapshot(user),
              rankTier: user.rankTier,
              rankTierManual: user.rankTierManual,
              inhouseMmr: user.inhouseMmr,
            },
            data: {
              rankTier: after.rankTier,
              rankTierManual: after.manual,
              inhouseMmr: after.mmr,
            },
          });
          if (claimed.count !== 1) throw new InhouseRatingChangedError();
          if (after.mmr === null) {
            return (await tx.inhouseQueueEntry.count({ where: { userId: user.id } })) > 0;
          }
          const spot = await tx.inhouseQueueEntry.updateMany({
            where: { userId: user.id },
            data: { mmr: after.mmr },
          });
          return spot.count > 0;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (error) {
    if (error instanceof InhouseRatingChangedError || isSerializationConflict(error)) {
      return { ok: false, error: INHOUSE_RATING_CHANGED };
    }
    throw error;
  }
  // Rule P: the room shows the medal and the queue spot's MMR.
  await publishInhouseRoomChange();
  return { ok: true, name: user.name, before, after, queued };
}

/** One player in /admin/inhouse-players' lists. */
export type InhouseRatingRow = {
  id: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  rankTierManual: boolean;
  /** User.inhouseMmr, null = none. */
  adminMmr: number | null;
  /** The newest league signup's MMR (joinQueue's), 0 = none. */
  signupMmr: number;
  /** The MMR their queue spot holds, null = not queued. */
  queuedMmr: number | null;
  /** Their latest inhouse game's MMR (joinQueue's last-game fallback). */
  lastGameMmr: number | null;
};

/** How many players one list or search shows. */
const LIST_LIMIT = 40;

/**
 * The page's players. With a search: everyone whose name contains it
 * (any case), or whose Steam or Dota account it names (an id, or a Steam,
 * OpenDota or Dotabuff link). Without one: the queue in queue order, the
 * latest inhouse players, then anyone else with an admin's MMR or medal.
 */
export async function loadInhouseRatingPage(search: string | null): Promise<{
  results: InhouseRatingRow[] | null;
  queued: InhouseRatingRow[];
  recent: InhouseRatingRow[];
  adminSet: InhouseRatingRow[];
}> {
  if (search) {
    const needle = search.toLowerCase();
    const accountId = parseAccountId(search);
    // Names compare in JS: Postgres `contains` is case-sensitive and SQLite
    // has no insensitive mode, and one admin's search over the user list
    // costs nothing next to a page view.
    const [everyone, byAccount] = await Promise.all([
      prisma.user.findMany({
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
      accountId
        ? prisma.user.findMany({
            where: dotaAccountClaimWhere(accountId),
            select: { id: true },
            orderBy: { id: "asc" },
          })
        : [],
    ]);
    const ids = [
      ...byAccount.map((u) => u.id),
      ...everyone
        .filter((u) => u.name.toLowerCase().includes(needle))
        .map((u) => u.id),
    ];
    const rows = await loadRows([...new Set(ids)].slice(0, LIST_LIMIT));
    return { results: rows, queued: [], recent: [], adminSet: [] };
  }

  const [queue, lobbyPlayers, adminSet] = await Promise.all([
    prisma.inhouseQueueEntry.findMany({
      orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
      select: { userId: true },
    }),
    prisma.inhouseLobbyPlayer.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LIST_LIMIT * 10,
      select: { userId: true },
    }),
    prisma.user.findMany({
      where: { OR: [{ inhouseMmr: { not: null } }, { rankTierManual: true }] },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: LIST_LIMIT,
      select: { id: true },
    }),
  ]);
  const queuedIds = queue.map((q) => q.userId);
  const shown = new Set(queuedIds);
  const recentIds: string[] = [];
  for (const { userId } of lobbyPlayers) {
    if (recentIds.length >= LIST_LIMIT) break;
    if (shown.has(userId)) continue;
    shown.add(userId);
    recentIds.push(userId);
  }
  const adminSetIds = adminSet.map((u) => u.id).filter((id) => !shown.has(id));
  const rows = await loadRows([...queuedIds, ...recentIds, ...adminSetIds]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pick = (ids: string[]) =>
    ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  return {
    results: null,
    queued: pick(queuedIds),
    recent: pick(recentIds),
    adminSet: pick(adminSetIds),
  };
}

/** The rows for these players, in this order (a missing player drops out). */
async function loadRows(ids: string[]): Promise<InhouseRatingRow[]> {
  if (ids.length === 0) return [];
  const [users, signups, spots, games] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        avatar: true,
        rankTier: true,
        rankTierManual: true,
        inhouseMmr: true,
      },
    }),
    // joinQueue's signup: the newest with an MMR.
    prisma.registration.findMany({
      where: { userId: { in: ids }, mmr: { gt: 0 } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { userId: true, mmr: true },
    }),
    prisma.inhouseQueueEntry.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, mmr: true },
    }),
    // joinQueue's last-game fallback: the newest snapshot with an MMR.
    prisma.inhouseLobbyPlayer.findMany({
      where: { userId: { in: ids }, mmr: { gt: 0 } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { userId: true, mmr: true },
    }),
  ]);
  const first = (rows: { userId: string; mmr: number }[]) => {
    const out = new Map<string, number>();
    for (const row of rows) if (!out.has(row.userId)) out.set(row.userId, row.mmr);
    return out;
  };
  const signupMmr = first(signups);
  const queuedMmr = first(spots);
  const lastGameMmr = first(games);
  const byId = new Map(users.map((u) => [u.id, u]));
  return ids.flatMap((id) => {
    const u = byId.get(id);
    if (!u) return [];
    return [
      {
        id: u.id,
        name: u.name,
        avatar: u.avatar,
        rankTier: u.rankTier,
        rankTierManual: u.rankTierManual,
        adminMmr: adminInhouseMmr(u.inhouseMmr),
        signupMmr: signupMmr.get(id) ?? 0,
        queuedMmr: queuedMmr.get(id) ?? null,
        lastGameMmr: lastGameMmr.get(id) ?? null,
      },
    ];
  });
}
