import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchRankTier: vi.fn(),
  fetchPubStats: vi.fn(),
}));
vi.mock("@/lib/steam", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/steam")>()),
  fetchSteamProfiles: vi.fn(),
}));

import {
  refreshRank,
  refreshSteamProfile,
  updateDotaAccount,
} from "@/app/actions/registration";
import { requireUser } from "@/lib/auth";
import { fetchPubStats, fetchRankTier } from "@/lib/dota";
import { prisma } from "@/lib/prisma";
import {
  PROVIDER_COOLDOWN_PREFIX,
  providerCooldownKey,
} from "@/lib/settings";
import { fetchSteamProfiles } from "@/lib/steam";
import { makeUser, raceAll, sessionFor } from "./factories";

const mockRequireUser = vi.mocked(requireUser);
const mockRank = vi.mocked(fetchRankTier);
const mockPub = vi.mocked(fetchPubStats);
const mockSteam = vi.mocked(fetchSteamProfiles);

const PUB_STATS = {
  recentWins: 7,
  recentLosses: 3,
  totalGames: 42,
  lastPlayedAt: 1_700_000_000,
  topHeroes: [],
};

function accountForm(accountId: string | number): FormData {
  const fd = new FormData();
  fd.set("dotaAccountId", String(accountId));
  return fd;
}

async function signedUser(accountId?: number) {
  const created = await makeUser("Provider cooldown player");
  const user =
    accountId == null
      ? created
      : await prisma.user.update({
          where: { id: created.id },
          data: { dotaAccountIdV2: accountId },
        });
  mockRequireUser.mockResolvedValue(sessionFor(user));
  return user;
}

async function providerClaimCount() {
  return prisma.setting.count({
    where: { key: { startsWith: PROVIDER_COOLDOWN_PREFIX } },
  });
}

beforeEach(() => {
  mockRequireUser.mockReset();
  mockRank.mockReset();
  mockPub.mockReset();
  mockSteam.mockReset();
  mockRank.mockResolvedValue({
    ok: true,
    rankTier: 53,
    fhUnavailable: false,
  });
  mockPub.mockResolvedValue({ ok: true, stats: PUB_STATS });
});

describe("authenticated provider action cooldowns", () => {
  it("rejects expired sessions before any durable claim or provider call", async () => {
    mockRequireUser.mockRejectedValue(new Error("UNAUTHORIZED"));

    await expect(refreshRank({}, new FormData())).resolves.toEqual({
      error: "Sign in required",
    });
    await expect(updateDotaAccount({}, accountForm(123456))).resolves.toEqual({
      error: "Sign in required",
    });
    await expect(refreshSteamProfile({}, new FormData())).resolves.toEqual({
      error: "Sign in required",
    });

    expect(await providerClaimCount()).toBe(0);
    expect(mockRank).not.toHaveBeenCalled();
    expect(mockPub).not.toHaveBeenCalled();
    expect(mockSteam).not.toHaveBeenCalled();
  });

  it("rejects an invalid account link before consuming the allowance", async () => {
    await signedUser();

    const result = await updateDotaAccount({}, accountForm("not-an-account"));

    expect(result?.error).toMatch(/enter an account id/i);
    expect(await providerClaimCount()).toBe(0);
    expect(mockRank).not.toHaveBeenCalled();
    expect(mockPub).not.toHaveBeenCalled();
  });

  it("elects one OpenDota profile refresh across concurrent instances", async () => {
    const accountId = 123_456;
    const user = await signedUser(accountId);

    const results = await raceAll([
      () => refreshRank({}, new FormData()),
      () => refreshRank({}, new FormData()),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/medal/i) }),
        expect.objectContaining({ error: expect.stringMatching(/recently/i) }),
      ]),
    );
    expect(mockRank).toHaveBeenCalledTimes(1);
    expect(mockPub).toHaveBeenCalledTimes(1);
    expect(
      await prisma.setting.count({
        where: {
          key: providerCooldownKey(
            "open-dota-profile",
            user.id,
            accountId,
          ),
        },
      }),
    ).toBe(1);
  });

  it("shares one OpenDota allowance between refresh and account-link actions", async () => {
    const accountId = 234_567;
    await signedUser(accountId);

    await expect(refreshRank({}, new FormData())).resolves.toMatchObject({
      message: expect.stringMatching(/medal/i),
    });
    const duplicate = await updateDotaAccount({}, accountForm(accountId));

    expect(duplicate?.message).toMatch(/refreshed recently/i);
    expect(mockRank).toHaveBeenCalledTimes(1);
    expect(mockPub).toHaveBeenCalledTimes(1);
  });

  it("keeps the cooldown after a provider outage and gives a safe retry time", async () => {
    await signedUser(345_678);
    mockRank.mockResolvedValue({
      ok: false,
      rankTier: null,
      fhUnavailable: null,
    });
    mockPub.mockResolvedValue({ ok: false, stats: null });

    const failed = await refreshRank({}, new FormData());
    const retry = await refreshRank({}, new FormData());

    expect(failed?.error).toMatch(/wait a minute/i);
    expect(retry?.error).toMatch(/wait about a minute/i);
    expect(mockRank).toHaveBeenCalledTimes(1);
    expect(mockPub).toHaveBeenCalledTimes(1);
  });

  it("elects one Steam profile refresh and preserves a clear retry path", async () => {
    const user = await signedUser();
    mockSteam.mockResolvedValue(
      new Map([
        [
          user.steamId,
          {
            name: "Fresh Steam name",
            avatar: "https://avatars.example/fresh.jpg",
            profileUrl: "https://steamcommunity.com/profiles/fresh",
          },
        ],
      ]),
    );

    const results = await raceAll([
      () => refreshSteamProfile({}, new FormData()),
      () => refreshSteamProfile({}, new FormData()),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        { message: "Profile refreshed from Steam" },
        expect.objectContaining({ error: expect.stringMatching(/recently/i) }),
      ]),
    );
    expect(mockSteam).toHaveBeenCalledTimes(1);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ name: "Fresh Steam name" });
  });
});
