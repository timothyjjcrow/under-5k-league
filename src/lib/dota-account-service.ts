import type { Prisma } from "@prisma/client";

/**
 * Steam OpenID proves this account belongs to `ownerSteamId`. Retire only the
 * matching stored claims on other rows, preserving a different authoritative
 * v2 account and its metadata when the stale value is merely shadowed legacy.
 */
export async function retireStaleDotaAccountClaims(
  tx: Prisma.TransactionClient,
  ownerSteamId: string,
  verifiedAccountId: number,
): Promise<void> {
  // Clear the current column first. If the same row also carries the same
  // legacy value, the next guarded update retires that fallback too.
  // Metadata describes the current (v2-first) account, so changing v2
  // invalidates it even when a different legacy fallback remains.
  await tx.user.updateMany({
    where: {
      steamId: { not: ownerSteamId },
      dotaAccountIdV2: verifiedAccountId,
    },
    data: {
      dotaAccountIdV2: null,
      rankTier: null,
      fhUnavailable: null,
      pubStats: null,
      pubStatsAt: null,
    },
  });

  // A legacy claim is effective only while v2 is null. Retiring that effective
  // claim also retires the OpenDota metadata fetched through it.
  await tx.user.updateMany({
    where: {
      steamId: { not: ownerSteamId },
      dotaAccountIdV2: null,
      legacyDotaAccountId: verifiedAccountId,
    },
    data: {
      legacyDotaAccountId: null,
      rankTier: null,
      fhUnavailable: null,
      pubStats: null,
      pubStatsAt: null,
    },
  });

  // A shadowed legacy claim can be removed without touching metadata for the
  // different v2 account that remains authoritative on that row.
  await tx.user.updateMany({
    where: {
      steamId: { not: ownerSteamId },
      dotaAccountIdV2: { not: null },
      legacyDotaAccountId: verifiedAccountId,
    },
    data: { legacyDotaAccountId: null },
  });
}
