import { describe, it, expect, vi, beforeEach } from "vitest";

// syncPlayerRanks is an admin action: stub the request-scope bits and the
// network fetch so we can drive it against the test DB and control each
// player's OpenDota outcome.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchRankTier: vi.fn(),
}));

import { syncPlayerRanks, syncAllRanks } from "@/app/actions/admin";
import { updateDotaAccount } from "@/app/actions/registration";
import { ensureRankTier, upsertLeagueUser } from "@/lib/users";
import { requireUser } from "@/lib/auth";
import { fetchRankTier } from "@/lib/dota";
import { prisma } from "@/lib/prisma";
import { makeSeason, makePlayer, makeUser, sessionFor } from "./factories";

const mockFetch = vi.mocked(fetchRankTier);
const mockRequireUser = vi.mocked(requireUser);

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
    mockFetch.mockResolvedValue({ ok: false, rankTier: null, fhUnavailable: null });

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
    mockFetch.mockResolvedValue({ ok: true, rankTier: 71, fhUnavailable: null }); // Divine 1

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
    mockFetch.mockResolvedValue({ ok: true, rankTier: null, fhUnavailable: null });

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
      .mockResolvedValueOnce({ ok: false, rankTier: null, fhUnavailable: null })
      .mockResolvedValueOnce({ ok: true, rankTier: 61, fhUnavailable: null }); // Ancient 1

    const res = await syncPlayerRanks({}, new FormData());

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(await medalOf(user.id)).toBe(61);
    expect(res?.message).toMatch(/1 ranked/);
  });
});

describe("syncPlayerRanks — bails out fast when OpenDota is down", () => {
  beforeEach(() => mockFetch.mockReset());

  async function fivePlayersWithAccounts() {
    const season = await makeSeason();
    const players = [];
    for (let i = 0; i < 5; i++) {
      const u = await makePlayer(season.id, `Player ${i}`, 3000);
      await prisma.user.update({
        where: { id: u.id },
        data: { rankTier: null, dotaAccountId: 1000 + i },
      });
      players.push(u);
    }
    return players;
  }

  it("reports an outage and stops before scanning every id when the first batch is all unreachable", async () => {
    const players = await fivePlayersWithAccounts();
    mockFetch.mockResolvedValue({ ok: false, rankTier: null, fhUnavailable: null });

    const res = await syncPlayerRanks({}, new FormData());

    // Surfaces as an error toast (not a message), and nothing was written.
    expect(res?.error).toMatch(/OpenDota isn't responding/);
    expect(res?.message).toBeUndefined();
    for (const p of players) expect(await medalOf(p.id)).toBeNull();
    // First batch (4) × one retry each = 8 fetches; the 5th id is never hit —
    // proof we didn't grind an 8s timeout across the whole roster.
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("does NOT declare an outage when the first batch has a reachable account", async () => {
    const players = await fivePlayersWithAccounts();
    // The first-created player (dotaAccountId 1000, in the first batch) answers;
    // everyone else is unreachable.
    mockFetch.mockImplementation(async (acc: number) =>
      acc === 1000
        ? { ok: true as const, rankTier: 55, fhUnavailable: null }
        : { ok: false as const, rankTier: null, fhUnavailable: null },
    );

    const res = await syncPlayerRanks({}, new FormData());

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/1 ranked/);
    expect(res?.message).toMatch(/couldn't be reached/);
    expect(await medalOf(players[0].id)).toBe(55);
  });
});

describe("ensureRankTier — medals for accounts that never signed up", () => {
  beforeEach(() => mockFetch.mockReset());

  it("fetches and stores a medal for a user with none yet", async () => {
    const user = await makeUser("Not Registered");
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, dotaAccountId: 555 },
    });
    mockFetch.mockResolvedValue({ ok: true, rankTier: 50, fhUnavailable: null }); // Legend

    await ensureRankTier(prisma, {
      id: user.id,
      steamId: user.steamId,
      dotaAccountId: 555,
      rankTier: null,
    });

    expect(await medalOf(user.id)).toBe(50);
  });

  it("is a no-op when the user already has a medal (doesn't even fetch)", async () => {
    const user = await makeUser("Has Medal");
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: 44, dotaAccountId: 556 },
    });

    await ensureRankTier(prisma, {
      id: user.id,
      steamId: user.steamId,
      dotaAccountId: 556,
      rankTier: 44,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(await medalOf(user.id)).toBe(44);
  });

  it("doesn't write when OpenDota is unreachable", async () => {
    const user = await makeUser("Unreachable");
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, dotaAccountId: 557 },
    });
    mockFetch.mockResolvedValue({ ok: false, rankTier: null, fhUnavailable: null });

    await ensureRankTier(prisma, {
      id: user.id,
      steamId: user.steamId,
      dotaAccountId: 557,
      rankTier: null,
    });

    expect(await medalOf(user.id)).toBeNull();
  });
});

describe("syncAllRanks — backfill every account, registered or not", () => {
  beforeEach(() => mockFetch.mockReset());

  it("fills medals for accounts with none — including non-registrants", async () => {
    // A plain account that never signed up (no registration).
    const outsider = await makeUser("Never Signed Up");
    await prisma.user.update({
      where: { id: outsider.id },
      data: { rankTier: null, dotaAccountId: 900 },
    });
    mockFetch.mockResolvedValue({ ok: true, rankTier: 54, fhUnavailable: null });

    const res = await syncAllRanks({}, new FormData());

    expect(await medalOf(outsider.id)).toBe(54);
    expect(res?.message).toMatch(/1 now ranked/);
  });

  it("skips accounts that already have a medal (no wasted fetch)", async () => {
    const has = await makeUser("Already Ranked");
    await prisma.user.update({
      where: { id: has.id },
      data: { rankTier: 71, dotaAccountId: 901 },
    });

    const res = await syncAllRanks({}, new FormData());

    expect(mockFetch).not.toHaveBeenCalled();
    expect(await medalOf(has.id)).toBe(71);
    expect(res?.message).toMatch(/already has a medal/);
  });

  it("preserves nothing to overwrite and reports unreachable on failure", async () => {
    const user = await makeUser("Cant Reach");
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, dotaAccountId: 902 },
    });
    mockFetch.mockResolvedValue({ ok: false, rankTier: null, fhUnavailable: null });

    const res = await syncAllRanks({}, new FormData());

    expect(await medalOf(user.id)).toBeNull();
    expect(res?.message).toMatch(/couldn't be reached/);
  });
});

describe("private-match-data flag (fh_unavailable)", () => {
  beforeEach(() => mockFetch.mockReset());

  it("stores the flag from the bulk sync — even for unranked players", async () => {
    const season = await makeSeason();
    const user = await makePlayer(season.id, "Private Pete", 3000);
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, dotaAccountId: 501 },
    });
    // OpenDota answers: no medal, match data private.
    mockFetch.mockResolvedValue({
      ok: true,
      rankTier: null,
      fhUnavailable: true,
    });

    await syncPlayerRanks({}, new FormData());

    const db = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(db.fhUnavailable).toBe(true);
    expect(db.rankTier).toBeNull();
  });

  it("flips back to false once the player exposes their data", async () => {
    const season = await makeSeason();
    const user = await makePlayer(season.id, "Fixed Fiona", 3000);
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, dotaAccountId: 502, fhUnavailable: true },
    });
    mockFetch.mockResolvedValue({ ok: true, rankTier: 44, fhUnavailable: false });

    await syncPlayerRanks({}, new FormData());

    const db = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(db.fhUnavailable).toBe(false);
    expect(db.rankTier).toBe(44);
  });

  it("a failed fetch (or one without the field) never overwrites the flag", async () => {
    const season = await makeSeason();
    const user = await makePlayer(season.id, "Sticky Flag", 3000);
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, dotaAccountId: 503, fhUnavailable: true },
    });

    mockFetch.mockResolvedValue({ ok: false, rankTier: null, fhUnavailable: null });
    await syncPlayerRanks({}, new FormData());
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .fhUnavailable,
    ).toBe(true);

    // OpenDota answered but omitted the field → unknown → keep the flag.
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, rankTier: 30, fhUnavailable: null });
    await syncPlayerRanks({}, new FormData());
    const db = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(db.fhUnavailable).toBe(true);
    expect(db.rankTier).toBe(30);
  });

  it("login (ensureRankTier) captures the flag alongside the medal", async () => {
    const user = await makeUser("Login Larry");
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, dotaAccountId: 504 },
    });
    mockFetch.mockResolvedValue({ ok: true, rankTier: 22, fhUnavailable: true });

    await ensureRankTier(prisma, {
      id: user.id,
      steamId: user.steamId,
      dotaAccountId: 504,
      rankTier: null,
    });

    const db = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(db.rankTier).toBe(22);
    expect(db.fhUnavailable).toBe(true);
  });
});

describe("account changes reset the private-data flag", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockRequireUser.mockReset();
  });

  it("linking a NEW account clears a stale fhUnavailable when OpenDota omits it", async () => {
    const user = await makeUser("Fresh Start");
    await prisma.user.update({
      where: { id: user.id },
      data: { fhUnavailable: true, rankTier: 40 }, // old private account
    });
    mockRequireUser.mockResolvedValue(sessionFor(user));
    // The new account: OpenDota answers but doesn't state the flag.
    mockFetch.mockResolvedValue({ ok: true, rankTier: 55, fhUnavailable: null });

    const fd = new FormData();
    fd.set("dotaAccountId", "123456789");
    const res = await updateDotaAccount({}, fd);
    expect(res?.message).toContain("Account linked");

    const db = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(db.fhUnavailable).toBeNull(); // unknown for the NEW account, not sticky
    expect(db.rankTier).toBe(55);
  });

  it("clearing the account link also clears the flag it described", async () => {
    const user = await makeUser("Back To Steam");
    await prisma.user.update({
      where: { id: user.id },
      data: { fhUnavailable: true, dotaAccountId: 777 },
    });
    mockRequireUser.mockResolvedValue(sessionFor(user));
    mockFetch.mockResolvedValue({ ok: true, rankTier: null, fhUnavailable: null });

    const fd = new FormData(); // empty → derive from Steam
    await updateDotaAccount({}, fd);

    const db = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    // Steam-derived id is fetchable, so the ok-path ran with nulls — either
    // way the stale true is gone.
    expect(db.fhUnavailable).toBeNull();
  });
});

// A Steam blip must never cost a player their name/avatar. fetchSteamProfile
// now returns null when Steam is unreachable (it used to return a
// `Player NNNNN` placeholder), and upsertLeagueUser leaves an existing
// account's stored profile alone when it gets one.
describe("upsertLeagueUser — Steam outages never overwrite a real profile", () => {
  it("keeps the stored name and avatar when Steam is unreachable", async () => {
    const steamId = "76561199000000777";
    await upsertLeagueUser(prisma, {
      steamId,
      profile: {
        name: "RealPersonaName",
        avatar: "https://avatars.example/real.jpg",
        profileUrl: "https://steamcommunity.com/id/real",
      },
    });

    // Next login, Steam is down / the API key was rotated.
    const after = await upsertLeagueUser(prisma, { steamId, profile: null });

    expect(after.name).toBe("RealPersonaName");
    expect(after.avatar).toBe("https://avatars.example/real.jpg");
    expect(after.profileUrl).toBe("https://steamcommunity.com/id/real");
  });

  it("still creates a usable account when Steam is down on a FIRST login", async () => {
    const steamId = "76561199000000888";
    const created = await upsertLeagueUser(prisma, { steamId, profile: null });
    // Nothing to preserve here, so a placeholder is correct.
    expect(created.name).toContain("Player");
    expect(created.profileUrl).toContain(steamId);
  });

  it("applies a real profile when Steam answers", async () => {
    const steamId = "76561199000000999";
    await upsertLeagueUser(prisma, { steamId, profile: null });
    const updated = await upsertLeagueUser(prisma, {
      steamId,
      profile: { name: "Dendi", avatar: "a.jpg", profileUrl: "u" },
    });
    expect(updated.name).toBe("Dendi");
    expect(updated.avatar).toBe("a.jpg");
  });
});
