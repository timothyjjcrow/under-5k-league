import { describe, it, expect, vi, beforeEach } from "vitest";

// The action calls revalidatePath (Next request scope), requireUser (cookies),
// and — for new signups — fetchPlayerRankTier (network). Stub all three so we
// can drive the real saveRegistration end-to-end against the test DB.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(), requireAdmin: vi.fn() }));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchPlayerRankTier: vi.fn(async () => null),
}));

import { saveRegistration } from "@/app/actions/registration";
import { setRegistrationMmr } from "@/app/actions/admin";
import { requireAdmin, requireUser } from "@/lib/auth";
import { fetchPlayerRankTier } from "@/lib/dota";
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

// Medal MMR validation: the gate judges the RAW claim + medal, then a
// gate-approved claim outside the medal's plausible window (clampMmrToRank,
// ≤1000 MMR wide) is stored as the window's floor.
describe("saveRegistration — medal MMR validation", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    vi.mocked(fetchPlayerRankTier).mockReset();
    vi.mocked(fetchPlayerRankTier).mockResolvedValue(null);
  });

  async function medaled(name: string, rankTier: number) {
    const user = await makeUser(name);
    await prisma.user.update({ where: { id: user.id }, data: { rankTier } });
    return user;
  }

  it("snaps an inflated claim to the medal window's floor and says so", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Fibber", 54); // Legend 4 → window 3119–4118
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4900 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(3119);
    // The toast must own the rewrite — silently changing a typed value reads
    // as a bug to the player.
    expect(res?.message).toMatch(/3119/);
    expect(res?.message).toMatch(/Legend 4/);
  });

  it("keeps a claim the medal finds plausible, without a note", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Honest", 54);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4000 }));

    expect((await regFor(season.id, user.id))?.mmr).toBe(4000);
    expect(res?.message).not.toMatch(/range/);
  });

  it("estimates a blank MMR from the medal instead of storing unknown", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Left It Blank", 54);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 0 }));

    expect((await regFor(season.id, user.id))?.mmr).toBe(3119);
    expect(res?.message).toMatch(/estimated/i);
  });

  it("still rejects a RAW claim over the hard ceiling — the clamp never launders it", async () => {
    // Gate first, clamp second: a 5200 claim is judged as 5200 (rejected),
    // never as its medal floor. Otherwise overstating would be the way IN —
    // the bigger the lie, the lower the clamped number the gate would see.
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Tall Tale", 54);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 5200 }));

    expect(res?.error).toMatch(/over 5000/);
    expect(await regFor(season.id, user.id)).toBeNull();
  });

  it("rejects a 5K+ medal outright — sandbagging a low claim doesn't help", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    for (const [name, tier] of [
      ["Immortal Lurker", 80],
      ["Divine Five", 75],
    ] as const) {
      const user = await medaled(name, tier);
      vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
      const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3000 }));
      expect(res?.error).toMatch(/medal puts you above/);
      expect(await regFor(season.id, user.id)).toBeNull();
    }
  });

  it("clamps standin signups too", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Standin Fibber", 54);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "STANDIN", mmr: 4900 }));

    expect(res?.error).toBeUndefined();
    const reg = await regFor(season.id, user.id);
    expect(reg?.type).toBe("STANDIN");
    expect(reg?.mmr).toBe(3119);
  });

  it("clears an implausible claim to unknown when the medal floor is 0", async () => {
    // Herald 1's window is 0–576: a 3000 claim snaps to 0, the unknown
    // sentinel — the toast owns that (captains judge by the medal).
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Humble Herald", 11);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 3000 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(0);
    expect(res?.message).toMatch(/left unknown/i);
  });

  it("never re-clamps an untouched resubmit — admin corrections survive edits", async () => {
    // An admin corrected this stale-medal player to 4800 (Herald 1 window is
    // 0–576). Editing roles resubmits the prefilled 4800 — it must stand.
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Admin Fixed", 11);
    await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, mmr: 4800 },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 4800, roles: "1" }),
    );

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(4800);
    expect(res?.message).not.toMatch(/unknown|range/);

    // Typing a DIFFERENT number is a fresh self-report — the medal check runs.
    const res2 = await saveRegistration(
      {},
      form({ type: "PLAYER", mmr: 4700 }),
    );
    expect(res2?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(0);
  });

  it("validates against a medal fetched during THIS signup", async () => {
    // No stored medal — the new-signup OpenDota fetch runs BEFORE the clamp,
    // so a fresh medal already polices the very first claim.
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Fresh Medal");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    vi.mocked(fetchPlayerRankTier).mockResolvedValue(54);

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 900 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(3119);
    const dbUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(dbUser.rankTier).toBe(54);
    // The adjustment note names the medal — the fetched-medal label must not
    // make the toast say "Legend 4" twice.
    expect(res?.message?.match(/Legend 4/g)).toHaveLength(1);
  });

  it("clamps signup edits from the stored medal without re-fetching", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await medaled("Editor", 54);
    await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, mmr: 4000 },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4900 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(3119);
    // Edits never re-hit OpenDota (API budget rule).
    expect(vi.mocked(fetchPlayerRankTier)).not.toHaveBeenCalled();
  });

  it("changes nothing for a player with no medal on file", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Unranked");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));

    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4700 }));

    expect(res?.error).toBeUndefined();
    expect((await regFor(season.id, user.id))?.mmr).toBe(4700);
  });
});

// The admin override is the escape hatch when the medal check is wrong
// (stale medal, recalibration): it stores the raw value, never clamps, and
// only FLAGS a medal mismatch in its message.
describe("setRegistrationMmr — advisory-only admin override", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockReset();
    vi.mocked(requireAdmin).mockResolvedValue(
      sessionFor({ id: "admin", steamId: "1", name: "Admin", role: "ADMIN" }),
    );
  });

  async function registered(rankTier: number | null, mmr: number) {
    const season = await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Corrected");
    if (rankTier != null) {
      await prisma.user.update({ where: { id: user.id }, data: { rankTier } });
    }
    const reg = await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, mmr },
    });
    return { season, user, reg };
  }

  it("stores an out-of-window value RAW and flags the mismatch", async () => {
    const { reg } = await registered(11, 500); // Herald 1, window 0–576
    const res = await setRegistrationMmr(
      {},
      form({ registrationId: reg.id, mmr: 4800 }),
    );

    expect(res?.error).toBeUndefined();
    const after = await prisma.registration.findUniqueOrThrow({
      where: { id: reg.id },
    });
    expect(after.mmr).toBe(4800); // never clamped
    expect(res?.message).toMatch(/heads up/i);
    expect(res?.message).toMatch(/Herald 1/);
  });

  it("stays quiet for an in-window value", async () => {
    const { reg } = await registered(54, 3000);
    const res = await setRegistrationMmr(
      {},
      form({ registrationId: reg.id, mmr: 4000 }),
    );

    expect(res?.error).toBeUndefined();
    expect(
      (await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } }))
        .mmr,
    ).toBe(4000);
    expect(res?.message).not.toMatch(/heads up/i);
  });
});
