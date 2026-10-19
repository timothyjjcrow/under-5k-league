import { beforeEach, describe, expect, it, vi } from "vitest";

// Dota account ids run to 2^32 - 1, but the rollback column
// `legacyDotaAccountId` is Prisma `Int`: a signed INTEGER (INT4) on Postgres.
// Prisma refuses to bind a parameter that INTEGER can't hold ("Unable to fit
// integer value … into an INT4"), so a query that filters that column by a
// newer account id (2^31 and up, SteamID64 76561200107749376 and later) throws
// instead of matching nothing. Sign-in ran such a filter on every Steam login.
// SQLite binds 64-bit integers and hides the failure; `npm run test:pg` is the
// run that proves it. The bystander checks below (a filter left off must never
// become a filter that matches everyone) hold on both providers.

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchRankTier: vi.fn(),
  fetchPubStats: vi.fn(),
}));

import { updateDotaAccount } from "@/app/actions/registration";
import { requireUser } from "@/lib/auth";
import { SEASON_STATUS } from "@/lib/constants";
import {
  accountIdToSteamId64,
  fetchPubStats,
  fetchRankTier,
  steamIdToAccountId,
} from "@/lib/dota";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { loadInhouseRatingPage } from "@/lib/inhouse-rating-service";
import { prisma } from "@/lib/prisma";
import {
  addScrimGuest,
  addTeamCoach,
  createScrim,
  joinScrim,
} from "@/lib/scrim-service";
import { upsertLeagueUser } from "@/lib/users";
import {
  makeCaptain,
  makeSeason,
  makeUser,
  ON_POSTGRES,
  sessionFor,
} from "./factories";

const INT4_MAX = 2_147_483_647;
/** Account id 2^31, the first one INT4 can't hold. */
const FIRST_PAST_INT4 = "76561200107749376";
/** Account id 2^32 - 1, the last one Steam can issue. */
const LAST_ACCOUNT = "76561202255233023";
const HIGH_STEAM_IDS = [FIRST_PAST_INT4, LAST_ACCOUNT];
/** Another player's rollback-era claim, which these logins must not touch. */
const BYSTANDER_ID = 123_456_789;

const mockRequireUser = vi.mocked(requireUser);

beforeEach(() => {
  mockRequireUser.mockReset();
  vi.mocked(fetchRankTier).mockReset();
  vi.mocked(fetchRankTier).mockResolvedValue({
    ok: false,
    rankTier: null,
    fhUnavailable: null,
  });
  vi.mocked(fetchPubStats).mockReset();
  vi.mocked(fetchPubStats).mockResolvedValue({ ok: false, stats: null });
});

/** A rollback-era claim: only the legacy column set, plus fetched metadata. */
async function legacyClaimHolder(name: string, accountId: number) {
  const user = await makeUser(name);
  return prisma.user.update({
    where: { id: user.id },
    data: {
      legacyDotaAccountId: accountId,
      rankTier: 55,
      fhUnavailable: false,
      pubStatsAt: new Date("2026-09-01T00:00:00Z"),
    },
  });
}

describe("Dota account ids past the signed 32-bit range", () => {
  it.runIf(ON_POSTGRES)(
    "control: the legacy INTEGER column refuses such an id as a filter",
    async () => {
      // Without this refusal the rest of the file measures nothing: it is the
      // failure the bound in dota-account.ts keeps every query away from.
      await expect(
        prisma.user.findMany({
          where: { legacyDotaAccountId: INT4_MAX + 1 },
          select: { id: true },
        }),
      ).rejects.toThrow(/INT4/);
      await expect(
        prisma.user.findMany({
          where: { legacyDotaAccountId: INT4_MAX },
          select: { id: true },
        }),
      ).resolves.toEqual([]);
    },
  );

  it.each(HIGH_STEAM_IDS)(
    "signs in Steam account %s and retires only that account's claims",
    async (steamId) => {
      const accountId = steamIdToAccountId(steamId);
      expect(accountId).toBeGreaterThan(INT4_MAX);
      // A stale v2 override of this account is still retired: only the
      // legacy filters are left out, never the v2 ones.
      const staleV2 = await makeUser("Stale v2 holder");
      await prisma.user.update({
        where: { id: staleV2.id },
        data: { dotaAccountIdV2: accountId, rankTier: 70 },
      });
      // A legacy claim on another account must survive. A legacy filter
      // dropped by setting it to `undefined` would match every null-v2 row
      // and clear this one.
      const bystander = await legacyClaimHolder("Bystander", BYSTANDER_ID);

      const owner = await upsertLeagueUser(prisma, { steamId, profile: null });

      expect(owner.steamId).toBe(steamId);
      expect(effectiveDotaAccountId(owner)).toBe(accountId);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: staleV2.id } }),
      ).toMatchObject({ dotaAccountIdV2: null, rankTier: null });
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: bystander.id } }),
      ).toMatchObject({
        legacyDotaAccountId: BYSTANDER_ID,
        rankTier: 55,
        fhUnavailable: false,
        pubStatsAt: new Date("2026-09-01T00:00:00Z"),
      });

      // A second login (the common case) takes the same path.
      await expect(
        upsertLeagueUser(prisma, { steamId, profile: null }),
      ).resolves.toMatchObject({ id: owner.id });
    },
  );

  it("still retires a legacy claim at the largest id INT4 holds", async () => {
    const holder = await legacyClaimHolder("Legacy INT4 max", INT4_MAX);

    await upsertLeagueUser(prisma, {
      steamId: accountIdToSteamId64(INT4_MAX),
      profile: null,
    });

    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: holder.id } }),
    ).toMatchObject({
      legacyDotaAccountId: null,
      rankTier: null,
      fhUnavailable: null,
      pubStatsAt: null,
    });
  });

  it.each(HIGH_STEAM_IDS)(
    "lets Steam account %s use its own account on /me",
    async (steamId) => {
      const bystander = await legacyClaimHolder("Bystander", BYSTANDER_ID);
      const user = await upsertLeagueUser(prisma, { steamId, profile: null });
      mockRequireUser.mockResolvedValue(sessionFor(user));

      // "Use my Steam account": the empty form.
      const result = await updateDotaAccount({}, new FormData());

      expect(result?.error).toBeUndefined();
      expect(result?.message).toMatch(/using Steam/);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: bystander.id } }),
      ).toMatchObject({ legacyDotaAccountId: BYSTANDER_ID, rankTier: 55 });
    },
  );

  it("refreshes a grandfathered override past the INT4 range", async () => {
    // An earlier profile form stored unverified overrides in v2 (a Float),
    // which holds any account id. Refreshing it runs the cross-column
    // collision check, which filters the legacy column too.
    const override = steamIdToAccountId(LAST_ACCOUNT)!;
    const user = await makeUser("Grandfathered override");
    const linked = await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountIdV2: override },
    });
    mockRequireUser.mockResolvedValue(sessionFor(linked));
    const form = new FormData();
    form.set("dotaAccountId", String(override));

    const result = await updateDotaAccount({}, form);

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(/legacy account refreshed/i);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ dotaAccountIdV2: override, legacyDotaAccountId: null });
  });

  it.each(HIGH_STEAM_IDS)(
    "finds Steam account %s on /admin/inhouse-players by link and account id",
    async (steamId) => {
      const accountId = steamIdToAccountId(steamId)!;
      const user = await upsertLeagueUser(prisma, {
        steamId,
        profile: { name: "Frontier Player", avatar: null, profileUrl: null },
      });

      for (const search of [
        `https://steamcommunity.com/profiles/${steamId}`,
        `https://www.opendota.com/players/${accountId}`,
        String(accountId),
      ]) {
        const page = await loadInhouseRatingPage(search);
        expect(page.results?.map((row) => row.id)).toEqual([user.id]);
      }
    },
  );

  it.each(HIGH_STEAM_IDS)(
    "adds Steam account %s as a team coach and a scrim guest by account",
    async (steamId) => {
      const accountId = steamIdToAccountId(steamId)!;
      const season = await makeSeason({
        status: SEASON_STATUS.REGULAR_SEASON,
        teamSize: 5,
      });
      const host = await makeCaptain(season.id, "Host Captain", 100, 0);
      const opponent = await makeCaptain(season.id, "Away Captain", 100, 1);
      const coach = await upsertLeagueUser(prisma, {
        steamId,
        profile: { name: "Frontier Coach", avatar: null, profileUrl: null },
      });

      // The coach lookup resolves a user by every claim on the account.
      await expect(
        addTeamCoach(host.user.id, false, steamId),
      ).resolves.toMatchObject({ userId: coach.id, dotaAccountId: accountId });

      // A guest is account-only; its Float column holds the full range.
      const scrim = await createScrim(
        host.user.id,
        new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        1,
      );
      await joinScrim(opponent.user.id, scrim.id);
      await expect(
        addScrimGuest(host.user.id, false, scrim.id, "Frontier Guest", steamId),
      ).resolves.toMatchObject({ dotaAccountId: accountId });
    },
  );
});
