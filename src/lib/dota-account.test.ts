import { describe, expect, it } from "vitest";
import {
  dotaAccountClaimWhere,
  dotaAccountLinkSnapshot,
  effectiveDotaAccountId,
  fitsLegacyDotaAccountColumn,
  sameDotaAccountLink,
  storedDotaAccountId,
} from "./dota-account";
import { accountIdToSteamId64 } from "./dota";

describe("Dota account rollback bridge", () => {
  it("prefers v2, then legacy, then the Steam-derived account", () => {
    const steamId = accountIdToSteamId64(333_333_333);

    expect(
      effectiveDotaAccountId({
        steamId,
        dotaAccountIdV2: 111_111_111,
        legacyDotaAccountId: 222_222_222,
      }),
    ).toBe(111_111_111);
    expect(
      effectiveDotaAccountId({
        steamId,
        dotaAccountIdV2: null,
        legacyDotaAccountId: 222_222_222,
      }),
    ).toBe(222_222_222);
    expect(
      effectiveDotaAccountId({
        steamId,
        dotaAccountIdV2: null,
        legacyDotaAccountId: null,
      }),
    ).toBe(333_333_333);
  });

  it("preserves the full unsigned 32-bit identifier exactly", () => {
    expect(
      effectiveDotaAccountId({
        steamId: "invalid",
        dotaAccountIdV2: 0xffffffff,
        legacyDotaAccountId: null,
      }),
    ).toBe(0xffffffff);
    expect(
      storedDotaAccountId({
        dotaAccountIdV2: null,
        legacyDotaAccountId: 0xffffffff,
      }),
    ).toBe(0xffffffff);
  });

  it("snapshots and compares both columns for stale-write guards", () => {
    const link = {
      dotaAccountIdV2: 111_111_111,
      legacyDotaAccountId: 222_222_222,
    };

    expect(dotaAccountLinkSnapshot(link)).toEqual(link);
    expect(sameDotaAccountLink(link, { ...link })).toBe(true);
    expect(
      sameDotaAccountLink(link, {
        ...link,
        legacyDotaAccountId: 333_333_333,
      }),
    ).toBe(false);
  });

  it("checks v2, legacy, and Steam-derived ownership for collisions", () => {
    expect(dotaAccountClaimWhere(123_456_789)).toEqual({
      OR: [
        { dotaAccountIdV2: 123_456_789 },
        { legacyDotaAccountId: 123_456_789 },
        { steamId: accountIdToSteamId64(123_456_789) },
      ],
    });
  });

  it("leaves the legacy INT4 column out of a claim it can't hold", () => {
    // Postgres refuses to bind 2^31 or more to INTEGER; the whole query
    // would throw (test/integration/dota-account-int4.itest.ts).
    expect(fitsLegacyDotaAccountColumn(2_147_483_647)).toBe(true);
    expect(fitsLegacyDotaAccountColumn(2_147_483_648)).toBe(false);
    expect(fitsLegacyDotaAccountColumn(0xffffffff)).toBe(false);
    expect(dotaAccountClaimWhere(2_147_483_647).OR).toContainEqual({
      legacyDotaAccountId: 2_147_483_647,
    });
    expect(dotaAccountClaimWhere(2_147_483_648)).toEqual({
      OR: [
        { dotaAccountIdV2: 2_147_483_648 },
        { steamId: accountIdToSteamId64(2_147_483_648) },
      ],
    });
  });
});
