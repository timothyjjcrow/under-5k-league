import { accountIdToSteamId64, steamIdToAccountId } from "./dota";

/**
 * The two stored columns that coexist during the rollback window.
 *
 * `dotaAccountIdV2` is authoritative when present. The legacy column remains
 * readable so a release can roll back without losing pre-release overrides.
 */
export type StoredDotaAccountLink = {
  dotaAccountIdV2: number | null;
  legacyDotaAccountId: number | null;
};

export type DotaAccountIdentity = StoredDotaAccountLink & {
  steamId: string;
};

/** Current explicit override, preferring the release column. */
export function storedDotaAccountId(
  identity: StoredDotaAccountLink,
): number | null {
  return identity.dotaAccountIdV2 ?? identity.legacyDotaAccountId;
}

/**
 * Account used by OpenDota, imports, and profile links. Steam is canonical
 * only when neither stored override exists.
 */
export function effectiveDotaAccountId(
  identity: DotaAccountIdentity,
): number | null {
  return storedDotaAccountId(identity) ?? steamIdToAccountId(identity.steamId);
}

/** Snapshot both columns for compare-and-set writes around network requests. */
export function dotaAccountLinkSnapshot(identity: StoredDotaAccountLink) {
  return {
    dotaAccountIdV2: identity.dotaAccountIdV2,
    legacyDotaAccountId: identity.legacyDotaAccountId,
  };
}

export function sameDotaAccountLink(
  left: StoredDotaAccountLink,
  right: StoredDotaAccountLink,
): boolean {
  return (
    left.dotaAccountIdV2 === right.dotaAccountIdV2 &&
    left.legacyDotaAccountId === right.legacyDotaAccountId
  );
}

/**
 * Query fragment for every way another user can claim an account: the current
 * column, rollback column, or their canonical Steam identity.
 */
export function dotaAccountClaimWhere(accountId: number) {
  return {
    OR: [
      { dotaAccountIdV2: accountId },
      { legacyDotaAccountId: accountId },
      { steamId: accountIdToSteamId64(accountId) },
    ],
  };
}
