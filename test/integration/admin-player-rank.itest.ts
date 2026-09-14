import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  getSessionUser: vi.fn(async () => ({
    id: "rank-correction-admin",
    name: "Rank Correction Admin",
  })),
}));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchRankTier: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { setPlayerRank } from "@/app/actions/admin";
import { requireAdmin } from "@/lib/auth";
import { fetchRankTier } from "@/lib/dota";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { makePlayer, makeSeason } from "./factories";

async function fixture(options: { status?: string; type?: string } = {}) {
  const season = await makeSeason({ status: options.status ?? "SIGNUPS" });
  const user = await makePlayer(season.id, "Corrected Player", 2300);
  await prisma.user.update({
    where: { id: user.id },
    data: { rankTier: 31, rankTierManual: false, dotaAccountIdV2: 12345 },
  });
  const registration = await prisma.registration.update({
    where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
    data: { type: options.type ?? "PLAYER" },
  });
  return { season, user, registration };
}

function editForm(
  registrationId: string,
  changes: Record<string, string | number> = {},
) {
  const form = new FormData();
  const fields = {
    registrationId,
    mmr: 4800,
    medalMode: "manual",
    rankTier: 54,
    expectedMmr: 2300,
    expectedRankTier: 31,
    expectedRankTierManual: 0,
    ...changes,
  };
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, String(value));
  }
  return form;
}

async function stored(registrationId: string) {
  const registration = await prisma.registration.findUniqueOrThrow({
    where: { id: registrationId },
    include: { user: true },
  });
  return {
    mmr: registration.mmr,
    rankTier: registration.user.rankTier,
    rankTierManual: registration.user.rankTierManual,
  };
}

beforeEach(() => {
  vi.mocked(requireAdmin).mockReset();
  vi.mocked(requireAdmin).mockResolvedValue({
    id: "rank-correction-admin",
    steamId: "76561190000009100",
    name: "Rank Correction Admin",
    avatar: null,
    role: "ADMIN",
  });
  vi.mocked(fetchRankTier).mockReset();
  vi.mocked(fetchRankTier).mockResolvedValue({
    ok: false,
    rankTier: null,
    fhUnavailable: null,
  });
  vi.mocked(revalidatePath).mockClear();
});

afterEach(() => setRaceHook(null));

describe("admin player medal and MMR corrections", () => {
  it("persists both values without medal clamping, refreshes pages, and records the admin", async () => {
    const { registration, season } = await fixture();

    const result = await setPlayerRank({}, editForm(registration.id));

    expect(result?.error).toBeUndefined();
    expect(result?.message).toBeTruthy();
    // Legend 4's suggested range ends below 4800; an explicit admin correction
    // must retain the number supplied rather than repeating the signup clamp.
    expect(await stored(registration.id)).toEqual({
      mmr: 4800,
      rankTier: 54,
      rankTierManual: true,
    });
    expect(fetchRankTier).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(
      await prisma.adminAction.findFirst({
        where: { action: "setPlayerRank", seasonId: season.id },
      }),
    ).toMatchObject({
      actorName: "Rank Correction Admin",
      summary: expect.stringContaining("Corrected Player"),
    });
  });

  it.each([0, 12000])("accepts the explicit MMR boundary %i", async (mmr) => {
    const { registration } = await fixture();
    const result = await setPlayerRank({}, editForm(registration.id, { mmr }));
    expect(result?.error).toBeUndefined();
    expect((await stored(registration.id)).mmr).toBe(mmr);
  });

  it.each(["", "-1", "12001", "3.5", "3100oops", "3e3", "Infinity"])(
    "rejects malformed or out-of-range MMR %j without changing the medal",
    async (mmr) => {
      const { registration } = await fixture();
      const result = await setPlayerRank({}, editForm(registration.id, { mmr }));
      expect(result?.error).toBeTruthy();
      expect(await stored(registration.id)).toEqual({
        mmr: 2300,
        rankTier: 31,
        rankTierManual: false,
      });
    },
  );

  it.each(["", "10", "16", "76", "81", "54.5", "54oops"])(
    "rejects invalid medal %j without changing MMR",
    async (rankTier) => {
      const { registration } = await fixture();
      const result = await setPlayerRank(
        {},
        editForm(registration.id, { rankTier }),
      );
      expect(result?.error).toBeTruthy();
      expect(await stored(registration.id)).toEqual({
        mmr: 2300,
        rankTier: 31,
        rankTierManual: false,
      });
    },
  );

  it.each([0, 11, 75, 80])("accepts valid medal %i", async (rankTier) => {
    const { registration } = await fixture();
    const result = await setPlayerRank(
      {},
      editForm(registration.id, { rankTier }),
    );
    expect(result?.error).toBeUndefined();
    expect(await stored(registration.id)).toEqual({
      mmr: 4800,
      rankTier: rankTier || null,
      rankTierManual: true,
    });
  });

  it("requires admin authorization before either write", async () => {
    const { registration } = await fixture();
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("UNAUTHORIZED"));
    const result = await setPlayerRank({}, editForm(registration.id));
    expect(result?.error).toMatch(/authorized|admin/i);
    expect((await stored(registration.id)).mmr).toBe(2300);
    expect(fetchRankTier).not.toHaveBeenCalled();
  });

  it.each(["REMOVED", "WITHDRAWN"])(
    "refuses corrections for a %s registration",
    async (status) => {
      const { registration } = await fixture();
      await prisma.registration.update({
        where: { id: registration.id },
        data: { status },
      });
      expect(
        (await setPlayerRank({}, editForm(registration.id)))?.error,
      ).toBeTruthy();
      expect((await stored(registration.id)).rankTier).toBe(31);
    },
  );

  it("rejects a registration belonging to a previous season", async () => {
    const { registration, season } = await fixture();
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });
    await makeSeason();
    expect(
      (await setPlayerRank({}, editForm(registration.id)))?.error,
    ).toBeTruthy();
    expect((await stored(registration.id)).mmr).toBe(2300);
  });

  it.each(["PLAYER", "STANDIN"])(
    "keeps completed season %s corrections read-only",
    async (type) => {
      const { registration } = await fixture({ status: "COMPLETE", type });
      expect(
        (await setPlayerRank({}, editForm(registration.id)))?.error,
      ).toMatch(/complete|read.only/i);
      expect(await stored(registration.id)).toEqual({
        mmr: 2300,
        rankTier: 31,
        rankTierManual: false,
      });
    },
  );

  it.each(["IN_PROGRESS", "PAUSED"])(
    "allows only a medal correction for a full player during a %s auction",
    async (status) => {
      const { registration, season } = await fixture({ status: "DRAFT" });
      await prisma.draft.create({ data: { seasonId: season.id, status } });
      const blocked = await setPlayerRank({}, editForm(registration.id));
      expect(blocked?.error).toMatch(/auction|locked/i);
      expect(await stored(registration.id)).toEqual({
        mmr: 2300,
        rankTier: 31,
        rankTierManual: false,
      });

      const medalOnly = await setPlayerRank(
        {},
        editForm(registration.id, { mmr: 2300 }),
      );
      expect(medalOnly?.error).toBeUndefined();
      expect(await stored(registration.id)).toEqual({
        mmr: 2300,
        rankTier: 54,
        rankTierManual: true,
      });
    },
  );

  it("allows a standin's MMR correction during the auction", async () => {
    const { registration, season } = await fixture({
      status: "DRAFT",
      type: "STANDIN",
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: "IN_PROGRESS" },
    });
    expect(
      (await setPlayerRank({}, editForm(registration.id)))?.error,
    ).toBeUndefined();
    expect((await stored(registration.id)).mmr).toBe(4800);
  });

  it("allows both corrections after the draft finishes", async () => {
    const { registration, season } = await fixture({ status: "REGULAR_SEASON" });
    await prisma.draft.create({
      data: { seasonId: season.id, status: "COMPLETE" },
    });
    expect(
      (await setPlayerRank({}, editForm(registration.id)))?.error,
    ).toBeUndefined();
    expect((await stored(registration.id)).mmr).toBe(4800);
  });

  it.each([
    ["expectedMmr", 2200],
    ["expectedRankTier", 32],
    ["expectedRankTierManual", 1],
  ] as const)("rejects a stale editor %s snapshot atomically", async (key, value) => {
    const { registration } = await fixture();
    const result = await setPlayerRank(
      {},
      editForm(registration.id, { [key]: value }),
    );
    expect(result?.error).toMatch(/changed|reload/i);
    expect(await stored(registration.id)).toEqual({
      mmr: 2300,
      rankTier: 31,
      rankTierManual: false,
    });
  });

  it("does not overwrite a medal changed after the initial read", async () => {
    const { registration, user } = await fixture();
    setRaceHook(
      onceAt("admin.setPlayerRank.beforeWrite", async () => {
        await prisma.user.update({
          where: { id: user.id },
          data: { rankTier: 65, rankTierManual: true },
        });
      }),
    );
    const result = await setPlayerRank({}, editForm(registration.id));
    expect(result?.error).toMatch(/changed|reload/i);
    expect(await stored(registration.id)).toEqual({
      mmr: 2300,
      rankTier: 65,
      rankTierManual: true,
    });
  });

  it("rechecks the draft lifecycle before committing either value", async () => {
    const { registration, season } = await fixture();
    setRaceHook(
      onceAt("admin.setPlayerRank.beforeWrite", async () => {
        await prisma.season.update({
          where: { id: season.id },
          data: { status: "DRAFT" },
        });
        await prisma.draft.create({
          data: { seasonId: season.id, status: "IN_PROGRESS" },
        });
      }),
    );
    expect(
      (await setPlayerRank({}, editForm(registration.id)))?.error,
    ).toBeTruthy();
    expect(await stored(registration.id)).toEqual({
      mmr: 2300,
      rankTier: 31,
      rankTierManual: false,
    });
  });
});

describe("returning a manual medal to OpenDota", () => {
  async function manualFixture() {
    const data = await fixture();
    await prisma.user.update({
      where: { id: data.user.id },
      data: { rankTierManual: true },
    });
    return data;
  }

  it("keeps the existing automatic medal when only MMR is being corrected", async () => {
    const { registration } = await fixture();
    const result = await setPlayerRank(
      {},
      editForm(registration.id, { medalMode: "automatic" }),
    );
    expect(result?.error).toBeUndefined();
    expect(fetchRankTier).not.toHaveBeenCalled();
    expect(await stored(registration.id)).toEqual({
      mmr: 4800,
      rankTier: 31,
      rankTierManual: false,
    });
  });

  it.each([43, null])(
    "restores the current provider medal %j and MMR together",
    async (rankTier) => {
      const { registration } = await manualFixture();
      vi.mocked(fetchRankTier).mockResolvedValue({
        ok: true,
        rankTier,
        fhUnavailable: null,
      });
      const result = await setPlayerRank(
        {},
        editForm(registration.id, {
          medalMode: "automatic",
          expectedRankTierManual: 1,
        }),
      );
      expect(result?.error).toBeUndefined();
      expect(fetchRankTier).toHaveBeenCalledWith(12345);
      expect(await stored(registration.id)).toEqual({
        mmr: 4800,
        rankTier,
        rankTierManual: false,
      });
    },
  );

  it("leaves the manual medal and MMR unchanged when OpenDota fails", async () => {
    const { registration } = await manualFixture();
    const result = await setPlayerRank(
      {},
      editForm(registration.id, {
        medalMode: "automatic",
        expectedRankTierManual: 1,
      }),
    );
    expect(result?.error).toMatch(/OpenDota|fetch|reach|try again/i);
    expect(await stored(registration.id)).toEqual({
      mmr: 2300,
      rankTier: 31,
      rankTierManual: true,
    });
  });

  it("does not attach a fetched medal to an account relinked during the lookup", async () => {
    const { registration, user } = await manualFixture();
    vi.mocked(fetchRankTier).mockImplementationOnce(async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: { dotaAccountIdV2: 54321 },
      });
      return { ok: true, rankTier: 43, fhUnavailable: null };
    });
    const result = await setPlayerRank(
      {},
      editForm(registration.id, {
        medalMode: "automatic",
        expectedRankTierManual: 1,
      }),
    );
    expect(result?.error).toMatch(/changed|reload/i);
    expect(await stored(registration.id)).toEqual({
      mmr: 2300,
      rankTier: 31,
      rankTierManual: true,
    });
  });
});
