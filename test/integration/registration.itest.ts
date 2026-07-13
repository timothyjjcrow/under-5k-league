import { describe, it, expect, vi, beforeEach } from "vitest";

// The action calls revalidatePath (Next request scope), requireUser (cookies),
// and — for new signups — fetchPlayerRankTier (network). Stub all three so we
// can drive the real saveRegistration end-to-end against the test DB.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchPlayerRankTier: vi.fn(async () => null),
}));

import { saveRegistration } from "@/app/actions/registration";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { makeUser, makeSeason, sessionFor } from "./factories";

function form(fields: Record<string, string | number>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
}

async function regFor(seasonId: string, userId: string) {
  return prisma.registration.findUnique({
    where: { seasonId_userId: { seasonId, userId } },
  });
}

describe("saveRegistration — MMR soft limit / hard ceiling", () => {
  beforeEach(() => vi.mocked(requireUser).mockReset());

  it("lets a player ABOVE the 4.5K soft limit sign up (reviewed, not blocked)", async () => {
    const season = await makeSeason({ maxMmr: 4500, status: "SIGNUPS" });
    const user = await makeUser("Above Soft Limit");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4700 }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBeTruthy();
    const reg = await regFor(season.id, user.id);
    expect(reg?.status).toBe("ACTIVE");
    expect(reg?.type).toBe("PLAYER");
    expect(reg?.mmr).toBe(4700);
  });

  it("rejects a player OVER the 5000 hard ceiling and records no signup", async () => {
    const season = await makeSeason({ maxMmr: 4500, status: "SIGNUPS" });
    const user = await makeUser("Immortal Smurf");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 5200 }));

    expect(res?.error).toMatch(/over 5000/);
    expect(await regFor(season.id, user.id)).toBeNull();
  });

  it("allows a player exactly AT the hard ceiling", async () => {
    const season = await makeSeason({ maxMmr: 4500, status: "SIGNUPS" });
    const user = await makeUser("Right At The Line");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 5000 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(5000);
  });

  it("still blocks 5K+ even with no soft limit set", async () => {
    const season = await makeSeason({ maxMmr: 0, status: "SIGNUPS" });
    const user = await makeUser("Way Too High");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 8000 }));

    expect(res?.error).toMatch(/over 5000/);
    expect(await regFor(season.id, user.id)).toBeNull();
  });
});
