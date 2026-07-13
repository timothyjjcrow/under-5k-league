import { describe, it, expect, vi, beforeEach } from "vitest";

// syncPlayerRanks is an admin action: stub the request-scope bits and the
// network fetch so we can drive it against the test DB and control each
// player's OpenDota outcome.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchRankTier: vi.fn(),
}));

import { syncPlayerRanks } from "@/app/actions/admin";
import { fetchRankTier } from "@/lib/dota";
import { prisma } from "@/lib/prisma";
import { makeSeason, makePlayer } from "./factories";

const mockFetch = vi.mocked(fetchRankTier);

async function medalOf(userId: string) {
  return (await prisma.user.findUnique({ where: { id: userId } }))?.rankTier;
}

describe("syncPlayerRanks — never wipes a medal on a failed fetch", () => {
  beforeEach(() => mockFetch.mockReset());

  it("keeps the stored medal when OpenDota can't be reached (rate limit / timeout)", async () => {
    const season = await makeSeason();
    const user = await makePlayer(season.id, "Legend Player", 3000);
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: 53, dotaAccountId: 111 }, // Legend 3, already synced
    });
    mockFetch.mockResolvedValue({ ok: false, rankTier: null });

    const res = await syncPlayerRanks({}, new FormData());

    expect(await medalOf(user.id)).toBe(53); // NOT wiped to null
    expect(res?.message).toMatch(/couldn't be reached/);
  });

  it("updates the medal when OpenDota answers with a rank", async () => {
    const season = await makeSeason();
    const user = await makePlayer(season.id, "Fresh Player", 3000);
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, dotaAccountId: 222 },
    });
    mockFetch.mockResolvedValue({ ok: true, rankTier: 71 }); // Divine 1

    const res = await syncPlayerRanks({}, new FormData());

    expect(await medalOf(user.id)).toBe(71);
    expect(res?.message).toMatch(/1 ranked/);
  });

  it("doesn't overwrite a medal when OpenDota answers with no rank", async () => {
    const season = await makeSeason();
    const user = await makePlayer(season.id, "Kept Player", 3000);
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: 42, dotaAccountId: 333 }, // Archon 2
    });
    mockFetch.mockResolvedValue({ ok: true, rankTier: null });

    await syncPlayerRanks({}, new FormData());

    expect(await medalOf(user.id)).toBe(42); // preserved
  });

  it("retries once on a failure before giving up", async () => {
    const season = await makeSeason();
    const user = await makePlayer(season.id, "Flaky Player", 3000);
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, dotaAccountId: 444 },
    });
    // First call fails (transient 429), retry succeeds.
    mockFetch
      .mockResolvedValueOnce({ ok: false, rankTier: null })
      .mockResolvedValueOnce({ ok: true, rankTier: 61 }); // Ancient 1

    const res = await syncPlayerRanks({}, new FormData());

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(await medalOf(user.id)).toBe(61);
    expect(res?.message).toMatch(/1 ranked/);
  });
});
