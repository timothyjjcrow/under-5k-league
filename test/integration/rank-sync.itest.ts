import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

// syncPlayerRanks is an admin action: stub the request-scope bits and the
// network fetch so we can drive it against the test DB and control each
// player's OpenDota outcome.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchRankTier: vi.fn(),
  fetchPubStats: vi.fn(),
}));

import { syncPlayerRanks, syncAllRanks } from "@/app/actions/admin";
import {
  refreshRank,
  setInhousePingOptIn,
  updateDotaAccount,
} from "@/app/actions/registration";
import { ensurePubStats, ensureRankTier, upsertLeagueUser } from "@/lib/users";
import { requireUser } from "@/lib/auth";
import {
  accountIdToSteamId64,
  fetchPubStats,
  fetchRankTier,
  steamIdToAccountId,
} from "@/lib/dota";
import type { PubStats } from "@/lib/pub-stats";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import {
  makeSeason,
  makePlayer,
  makeUser,
  raceAll,
  sessionFor,
} from "./factories";

const mockFetch = vi.mocked(fetchRankTier);
const mockPubFetch = vi.mocked(fetchPubStats);
const mockRequireUser = vi.mocked(requireUser);

// The pub-scouting fetch rides every rank-sync path now. Default it to
// "unreachable" so the medal tests exercise exactly what they always did —
// a failed pub fetch writes nothing (the never-overwrite rule, pinned below).
beforeEach(() => {
  mockPubFetch.mockReset();
  mockPubFetch.mockResolvedValue({ ok: false, stats: null });
});

afterEach(() => setRaceHook(null));

const PUB_FIXTURE: PubStats = {
  recentWins: 60,
  recentLosses: 40,
  totalGames: 1500,
  lastPlayedAt: 1_722_000_000,
  topHeroes: [{ heroId: 14, games: 120, wins: 66 }],
};

describe("identity actions — expired sessions", () => {
  it("returns actionable feedback for the inhouse ping toggle", async () => {
    mockRequireUser.mockReset();
    mockRequireUser.mockRejectedValueOnce(new Error("UNAUTHORIZED"));
    const fd = new FormData();
    fd.set("on", "1");

    await expect(setInhousePingOptIn({}, fd)).resolves.toEqual({
      error: "Sign in required",
    });
  });
});

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

  it("drops bulk-sync metadata fetched for an account relinked mid-request", async () => {
    const season = await makeSeason();
    const user = await makePlayer(season.id, "Bulk Relink Racer", 3000);
    const newerStats: PubStats = { ...PUB_FIXTURE, recentWins: 99 };
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 223301 },
    });
    mockPubFetch.mockResolvedValueOnce({ ok: true, stats: PUB_FIXTURE });
    mockFetch.mockImplementationOnce(async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          dotaAccountId: 223302,
          rankTier: 73,
          fhUnavailable: false,
          pubStats: JSON.stringify(newerStats),
          pubStatsAt: new Date("2026-08-01T00:00:00Z"),
        },
      });
      return { ok: true, rankTier: 41, fhUnavailable: true };
    });

    await syncPlayerRanks({}, new FormData());

    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({
      dotaAccountId: 223302,
      rankTier: 73,
      fhUnavailable: false,
      pubStats: JSON.stringify(newerStats),
    });
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

  it("drops a medal fetched for an account that was relinked mid-request", async () => {
    const user = await makeUser("Login Relink Racer");
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, dotaAccountId: 557 },
    });
    mockFetch.mockImplementationOnce(async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: { dotaAccountId: 558 },
      });
      return { ok: true, rankTier: 71, fhUnavailable: false };
    });

    await ensureRankTier(prisma, {
      id: user.id,
      steamId: user.steamId,
      dotaAccountId: 557,
      rankTier: null,
    });

    const current = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(current.dotaAccountId).toBe(558);
    expect(current.rankTier).toBeNull();
    expect(current.fhUnavailable).toBeNull();
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

  it("switching a legacy link back to verified Steam clears stale privacy metadata", async () => {
    const user = await makeUser("Fresh Start");
    const verifiedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        steamId: accountIdToSteamId64(123456789),
        dotaAccountId: 123456788,
        fhUnavailable: true,
        rankTier: 40,
      }, // old private account
    });
    mockRequireUser.mockResolvedValue(sessionFor(verifiedUser));
    // The new account: OpenDota answers but doesn't state the flag.
    mockFetch.mockResolvedValue({ ok: true, rankTier: 55, fhUnavailable: null });

    const fd = new FormData();
    fd.set("dotaAccountId", "123456789");
    const res = await updateDotaAccount({}, fd);
    expect(res?.message).toContain("Steam account verified");

    const db = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(db.dotaAccountId).toBeNull(); // Steam-derived identity stays canonical.
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

describe("upsertLeagueUser — verified Steam ownership retires legacy claims", () => {
  it("leaves unrelated Dota links and their fetched metadata untouched", async () => {
    const claimedAccountId = 225566777;
    const unrelatedAccountId = 225566776;
    const legacyHolder = await makeUser("Scoped Legacy Holder");
    const unrelated = await makeUser("Unrelated Account");
    await prisma.user.update({
      where: { id: legacyHolder.id },
      data: { dotaAccountId: claimedAccountId, rankTier: 73 },
    });
    await prisma.user.update({
      where: { id: unrelated.id },
      data: {
        dotaAccountId: unrelatedAccountId,
        rankTier: 61,
        pubStats: JSON.stringify(PUB_FIXTURE),
        pubStatsAt: new Date("2026-07-01T00:00:00Z"),
      },
    });

    await upsertLeagueUser(prisma, {
      steamId: accountIdToSteamId64(claimedAccountId),
      profile: null,
    });

    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: unrelated.id } }),
    ).toMatchObject({
      dotaAccountId: unrelatedAccountId,
      rankTier: 61,
      pubStats: JSON.stringify(PUB_FIXTURE),
      pubStatsAt: new Date("2026-07-01T00:00:00Z"),
    });
  });

  it("clears an attacker-before-owner override and its account-derived metadata", async () => {
    const accountId = 225566778;
    const legacyHolder = await makeUser("Legacy Holder");
    await prisma.user.update({
      where: { id: legacyHolder.id },
      data: {
        dotaAccountId: accountId,
        rankTier: 73,
        fhUnavailable: false,
        pubStats: JSON.stringify(PUB_FIXTURE),
        pubStatsAt: new Date("2026-07-01T00:00:00Z"),
      },
    });

    const owner = await upsertLeagueUser(prisma, {
      steamId: accountIdToSteamId64(accountId),
      profile: null,
    });

    expect(owner.dotaAccountId).toBeNull();
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: legacyHolder.id } }),
    ).toMatchObject({
      dotaAccountId: null,
      rankTier: null,
      fhUnavailable: null,
      pubStats: null,
      pubStatsAt: null,
    });
    const effectiveHolders = (await prisma.user.findMany()).filter(
      (candidate) =>
        (candidate.dotaAccountId ?? steamIdToAccountId(candidate.steamId)) ===
        accountId,
    );
    expect(effectiveHolders.map((candidate) => candidate.id)).toEqual([
      owner.id,
    ]);
  });

  it("is idempotent when verified-owner logins are retried or overlap", async () => {
    const accountId = 225566779;
    const legacyHolder = await makeUser("Retry Legacy Holder");
    await prisma.user.update({
      where: { id: legacyHolder.id },
      data: { dotaAccountId: accountId, rankTier: 61 },
    });
    const steamId = accountIdToSteamId64(accountId);

    const owners = await raceAll([
      () => upsertLeagueUser(prisma, { steamId, profile: null }),
      () => upsertLeagueUser(prisma, { steamId, profile: null }),
    ]);

    expect(new Set(owners.map((owner) => owner.id)).size).toBe(1);
    expect(await prisma.user.count({ where: { steamId } })).toBe(1);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: legacyHolder.id } }),
    ).toMatchObject({ dotaAccountId: null, rankTier: null });
  });
});

describe("upsertLeagueUser — zero-config admin bootstrap", () => {
  it("uses one atomic claim so competing first logins create one admin", async () => {
    vi.stubEnv("ADMIN_STEAM_IDS", "");
    const steamIds = ["76561199000001001", "76561199000001002"];
    try {
      const users = await raceAll(
        steamIds.map((steamId) => () =>
          upsertLeagueUser(prisma, { steamId, profile: null }),
        ),
      );

      const admins = users.filter((user) => user.role === "ADMIN");
      expect(admins).toHaveLength(1);
      const claim = await prisma.setting.findUniqueOrThrow({
        where: { key: "bootstrapAdminSteamId" },
      });
      expect(claim.value).toBe(admins[0]?.steamId);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// A medal is frequently learned AFTER signup — players register before linking
// their Dota account, or OpenDota is unreachable at that moment. registrationGate
// only runs on submit, and a stored MMR is league-approved by design (so an admin
// correction survives a player editing their roles), so NOTHING re-judges those
// signups. "Sync ranks" is the one moment the league learns the truth: it must
// say so, or a ceiling-breaking player sits in the pool behind a low typed number
// and gets drafted.
describe("syncPlayerRanks — flags signups a new medal proves ineligible", () => {
  beforeEach(() => mockFetch.mockReset());

  it("names the player when the synced medal is over the hard ceiling", async () => {
    const season = await makeSeason({ maxMmr: 4500 });
    const user = await makePlayer(season.id, "Sandbagger", 4200);
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 4242, rankTier: null }, // signed up before we knew
    });
    // Divine 4: exact band floor 5220, above the 5000 hard ceiling.
    mockFetch.mockResolvedValue({ ok: true, rankTier: 74, fhUnavailable: false });

    const res = await syncPlayerRanks({}, new FormData());

    expect(res?.error).toBeUndefined();
    expect(res?.message).toContain("Sandbagger");
    expect(res?.message).toMatch(/above the 5000 ceiling/);
    expect(res?.message).toContain("4200"); // what they actually typed
    // The signup is NOT auto-removed — who plays is the operator's call.
    const reg = await prisma.registration.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
    });
    expect(reg?.status).toBe("ACTIVE");
  });

  it("stays quiet when every synced medal is legitimately under the ceiling", async () => {
    const season = await makeSeason({ maxMmr: 4500 });
    const user = await makePlayer(season.id, "Legit Legend", 3400);
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 555, rankTier: null },
    });
    // Divine 2: floor 4820, under the ceiling — admissible.
    mockFetch.mockResolvedValue({ ok: true, rankTier: 72, fhUnavailable: false });

    const res = await syncPlayerRanks({}, new FormData());

    expect(res?.error).toBeUndefined();
    expect(res?.message).not.toMatch(/ceiling/);
    expect(res?.message).not.toContain("⚠️");
  });

  it("does not flag a WITHDRAWN signup — only players still in the pool", async () => {
    const season = await makeSeason({ maxMmr: 4500 });
    const user = await makePlayer(season.id, "Gone Already", 4200);
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 777, rankTier: 80 }, // Immortal
    });
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
      data: { status: "WITHDRAWN" },
    });
    mockFetch.mockResolvedValue({ ok: true, rankTier: 80, fhUnavailable: false });

    const res = await syncPlayerRanks({}, new FormData());

    expect(res?.message).not.toContain("Gone Already");
  });
});

describe("updateDotaAccount — verified ownership and race safety", () => {
  // A collision puts the same account in both teams' import sets, and
  // classifyGame then fails or mis-attributes every match containing both.
  beforeEach(() => {
    mockFetch.mockReset();
    mockRequireUser.mockReset();
    mockFetch.mockResolvedValue({ ok: true, rankTier: 44, fhUnavailable: null });
  });

  function accountForm(id: number | string): FormData {
    const fd = new FormData();
    fd.set("dotaAccountId", String(id));
    return fd;
  }

  it("round-trips the full unsigned 32-bit account boundary exactly", async () => {
    const user = await makeUser("Uint32 Account");
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 0xffffffff },
    });

    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .dotaAccountId,
    ).toBe(0xffffffff);
  });

  it("refuses an unproved id another user has stored as an override", async () => {
    const holder = await makeUser("Holder");
    await prisma.user.update({
      where: { id: holder.id },
      data: { dotaAccountId: 987654 },
    });
    const claimant = await makeUser("Claimant");
    mockRequireUser.mockResolvedValue(sessionFor(claimant));

    const res = await updateDotaAccount({}, accountForm(987654));

    expect(res?.error).toMatch(/does not match the Steam account/i);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: claimant.id } }))
        .dotaAccountId,
    ).toBeNull();
  });

  it("refuses an unproved id another user holds via their derived Steam account", async () => {
    // The mistake the error copy anticipates: B pastes teammate A's Dotabuff
    // URL. A never set an override, so their effective account id comes from
    // their SteamID64 — the old override-only check found nothing and stored
    // the duplicate.
    // A realistic 9-digit account id — the factory's sequential steamIds
    // derive single-digit account ids, which parseAccountId's junk floor
    // rejects before the collision check can even run.
    const ownerAccount = 111222333;
    const owner = await makeUser("Derived Owner");
    await prisma.user.update({
      where: { id: owner.id },
      data: { steamId: accountIdToSteamId64(ownerAccount) },
    });
    const claimant = await makeUser("Url Paster");
    mockRequireUser.mockResolvedValue(sessionFor(claimant));

    const res = await updateDotaAccount({}, accountForm(ownerAccount));

    expect(res?.error).toMatch(/does not match the Steam account/i);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: claimant.id } }))
        .dotaAccountId,
    ).toBeNull();
  });

  it("blocks an attacker before the verified owner has ever logged in", async () => {
    const accountId = 155511100;
    const attacker = await makeUser("Early Claim Attacker");
    mockRequireUser.mockResolvedValue(sessionFor(attacker));

    const attemptedClaim = await updateDotaAccount(
      {},
      accountForm(accountId),
    );
    expect(attemptedClaim?.error).toMatch(/does not match the Steam account/i);
    expect(mockFetch).not.toHaveBeenCalled();

    const owner = await upsertLeagueUser(prisma, {
      steamId: accountIdToSteamId64(accountId),
      profile: null,
    });
    expect(owner.dotaAccountId).toBeNull();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: attacker.id } }))
        .dotaAccountId,
    ).toBeNull();
  });

  it("doesn't stamp an old account's medal onto a newer link", async () => {
    const user = await makeUser("Relink Mid Fetch");
    const newerStats: PubStats = { ...PUB_FIXTURE, recentWins: 98 };
    const verifiedUser = await prisma.user.update({
      where: { id: user.id },
      data: { steamId: accountIdToSteamId64(111333) },
    });
    mockRequireUser.mockResolvedValue(sessionFor(verifiedUser));
    mockPubFetch.mockResolvedValueOnce({ ok: true, stats: PUB_FIXTURE });
    mockFetch.mockImplementationOnce(async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          dotaAccountId: 222333,
          pubStats: JSON.stringify(newerStats),
          pubStatsAt: new Date("2026-08-01T00:00:00Z"),
        },
      });
      return { ok: true, rankTier: 71, fhUnavailable: false };
    });

    const res = await updateDotaAccount({}, accountForm(111333));

    expect(res?.error).toMatch(/changed in another tab/i);
    const current = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(current.dotaAccountId).toBe(222333);
    expect(current.rankTier).toBeNull();
    expect(current.fhUnavailable).toBeNull();
    expect(current.pubStats).toBe(JSON.stringify(newerStats));
  });

  it("doesn't replace an account linked by another tab before the link claim", async () => {
    const user = await makeUser("Link Claim Racer");
    const newerStats: PubStats = { ...PUB_FIXTURE, recentWins: 97 };
    const verifiedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        steamId: accountIdToSteamId64(111993),
        dotaAccountId: 111991,
        rankTier: 42,
      },
    });
    mockRequireUser.mockResolvedValue(sessionFor(verifiedUser));
    setRaceHook(
      onceAt("registration.updateDotaAccount.beforeLinkClaim", async () => {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            dotaAccountId: 111992,
            rankTier: 73,
            fhUnavailable: false,
            pubStats: JSON.stringify(newerStats),
            pubStatsAt: new Date("2026-08-01T00:00:00Z"),
          },
        });
      }),
    );

    const res = await updateDotaAccount({}, accountForm(111993));

    expect(res?.error).toMatch(/changed in another tab/i);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({
      dotaAccountId: 111992,
      rankTier: 73,
      fhUnavailable: false,
      pubStats: JSON.stringify(newerStats),
    });
  });

  it("doesn't clear metadata from an account linked in another tab", async () => {
    const user = await makeUser("Clear Relink Racer");
    await prisma.user.update({
      where: { id: user.id },
      data: {
        steamId: `not-numeric-${user.id}`,
        dotaAccountId: null,
        rankTier: 42,
        fhUnavailable: true,
        pubStats: JSON.stringify(PUB_FIXTURE),
        pubStatsAt: new Date("2026-07-01T00:00:00Z"),
      },
    });
    mockRequireUser.mockResolvedValue(
      sessionFor(
        await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ),
    );
    setRaceHook(
      onceAt(
        "registration.updateDotaAccount.beforeClearMetadata",
        async () => {
          await prisma.user.update({
            where: { id: user.id },
            data: {
              dotaAccountId: 999888,
              rankTier: 73,
              fhUnavailable: false,
              pubStats: JSON.stringify(PUB_FIXTURE),
              pubStatsAt: new Date("2026-08-01T00:00:00Z"),
            },
          });
        },
      ),
    );

    const res = await updateDotaAccount({}, new FormData());

    expect(res?.error).toMatch(/changed in another tab/i);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({
      dotaAccountId: 999888,
      rankTier: 73,
      fhUnavailable: false,
      pubStats: JSON.stringify(PUB_FIXTURE),
    });
  });

  it("doesn't refresh metadata for an account relinked in another tab", async () => {
    const user = await makeUser("Refresh Relink Racer");
    const newerStats: PubStats = { ...PUB_FIXTURE, recentWins: 96 };
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 333111, rankTier: 42 },
    });
    mockRequireUser.mockResolvedValue(sessionFor(user));
    mockPubFetch.mockResolvedValueOnce({ ok: true, stats: PUB_FIXTURE });
    mockFetch.mockImplementationOnce(async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          dotaAccountId: 333222,
          rankTier: null,
          pubStats: JSON.stringify(newerStats),
          pubStatsAt: new Date("2026-08-01T00:00:00Z"),
        },
      });
      return { ok: true, rankTier: 72, fhUnavailable: false };
    });

    const res = await refreshRank({}, new FormData());

    expect(res?.error).toMatch(/changed in another tab/i);
    const current = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(current.dotaAccountId).toBe(333222);
    expect(current.rankTier).toBeNull();
    expect(current.fhUnavailable).toBeNull();
    expect(current.pubStats).toBe(JSON.stringify(newerStats));
  });

  it("clears metadata from the old account even when the new fetch fails", async () => {
    const user = await makeUser("New Account Fetch Failure");
    const verifiedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        steamId: accountIdToSteamId64(444222),
        dotaAccountId: 444111,
        rankTier: 53,
        fhUnavailable: true,
        pubStats: JSON.stringify(PUB_FIXTURE),
        pubStatsAt: new Date("2026-07-01T00:00:00Z"),
      },
    });
    mockRequireUser.mockResolvedValue(sessionFor(verifiedUser));
    mockFetch.mockResolvedValueOnce({
      ok: false,
      rankTier: null,
      fhUnavailable: null,
    });

    const res = await updateDotaAccount({}, accountForm(444222));

    expect(res?.message).toMatch(/couldn't fetch medal/i);
    const current = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(current.dotaAccountId).toBeNull();
    expect(current.rankTier).toBeNull();
    expect(current.fhUnavailable).toBeNull();
    expect(current.pubStats).toBeNull();
    expect(current.pubStatsAt).toBeNull();
  });

  it("preserves valid metadata when retrying the same account during an outage", async () => {
    const user = await makeUser("Same Account Fetch Failure");
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 555222, rankTier: 53, fhUnavailable: false },
    });
    mockRequireUser.mockResolvedValue(sessionFor(user));
    mockFetch.mockResolvedValueOnce({
      ok: false,
      rankTier: null,
      fhUnavailable: null,
    });

    const res = await updateDotaAccount({}, accountForm(555222));

    const current = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(res?.message).toMatch(/legacy account refreshed/i);
    expect(current.dotaAccountId).toBe(555222);
    expect(current.rankTier).toBe(53);
    expect(current.fhUnavailable).toBe(false);
  });
});

describe("pub-scouting snapshot capture (User.pubStats)", () => {
  beforeEach(() => mockFetch.mockReset());

  async function pubOf(userId: string) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { raw: u.pubStats, at: u.pubStatsAt };
  }

  it("syncPlayerRanks stores the snapshot beside the medal and reports it", async () => {
    const season = await makeSeason();
    const user = await makePlayer(season.id, "Scouted Player", 3000);
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 777 },
    });
    mockFetch.mockResolvedValue({ ok: true, rankTier: 55, fhUnavailable: null });
    mockPubFetch.mockResolvedValue({ ok: true, stats: PUB_FIXTURE });

    const res = await syncPlayerRanks({}, new FormData());

    const { raw, at } = await pubOf(user.id);
    expect(raw && JSON.parse(raw)).toEqual(PUB_FIXTURE);
    expect(at).not.toBeNull();
    // Anchored: "1 scouting profile" singular — the plural would also match a
    // bare /1 scouting profile/, which is how a hard-coded "s" slipped by.
    expect(res?.message).toMatch(/1 scouting profile(?!s)/);
  });

  it("a failed pub fetch never wipes a stored snapshot (the rankTier rule)", async () => {
    const season = await makeSeason();
    const user = await makePlayer(season.id, "Kept Player", 3000);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        dotaAccountId: 778,
        pubStats: JSON.stringify(PUB_FIXTURE),
        pubStatsAt: new Date("2026-07-01T00:00:00Z"),
      },
    });
    mockFetch.mockResolvedValue({ ok: true, rankTier: 55, fhUnavailable: null });
    // Default mockPubFetch is ok:false — the failure case under test.

    await syncPlayerRanks({}, new FormData());

    const { raw } = await pubOf(user.id);
    expect(raw && JSON.parse(raw)).toEqual(PUB_FIXTURE); // NOT wiped
  });

  it("ensurePubStats fetches only when the snapshot is MISSING — never a recurring login cost", async () => {
    const now = Date.UTC(2026, 7, 1);
    const user = await makeUser("Login Player");
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 779 },
    });
    const shape = {
      id: user.id,
      steamId: user.steamId,
      dotaAccountId: 779,
      pubStatsAt: null as Date | null,
    };
    mockPubFetch.mockResolvedValue({ ok: true, stats: PUB_FIXTURE });

    // Missing → fetches and stamps.
    await ensurePubStats(prisma, shape, now);
    expect(mockPubFetch).toHaveBeenCalledTimes(1);
    const first = await pubOf(user.id);
    expect(first.at?.getTime()).toBe(now);

    // Present — even a stale month-old snapshot — → no fetch at all. Login is
    // a one-time fill (the ensureRankTier rule); the admin sync owns staleness.
    await ensurePubStats(
      prisma,
      { ...shape, pubStatsAt: new Date(now - 30 * 86_400_000) },
      now,
    );
    expect(mockPubFetch).toHaveBeenCalledTimes(1);
  });

  it("ensurePubStats drops the result if the account was relinked mid-fetch", async () => {
    const now = Date.UTC(2026, 7, 1);
    const user = await makeUser("Relink Racer");
    // The fetch decision read dotaAccountId 785…
    const shape = {
      id: user.id,
      steamId: user.steamId,
      dotaAccountId: 785,
      pubStatsAt: null as Date | null,
    };
    // …but by the time the write lands the row holds a DIFFERENT override
    // (a /me relink committed mid-flight). The WHERE must refuse the write —
    // the old account's scouting data must not describe the new link.
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 786 },
    });
    mockPubFetch.mockResolvedValue({ ok: true, stats: PUB_FIXTURE });

    await ensurePubStats(prisma, shape, now);

    const { raw, at } = await pubOf(user.id);
    expect(raw).toBeNull();
    expect(at).toBeNull();
  });

  it("doesn't overwrite a newer same-account snapshot that won the race", async () => {
    const now = Date.UTC(2026, 7, 1);
    const newerStats: PubStats = { ...PUB_FIXTURE, recentWins: 99 };
    const user = await makeUser("Snapshot Racer");
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: 787 },
    });
    mockPubFetch.mockImplementationOnce(async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          pubStats: JSON.stringify(newerStats),
          pubStatsAt: new Date(now + 1_000),
        },
      });
      return { ok: true, stats: PUB_FIXTURE };
    });

    await ensurePubStats(
      prisma,
      {
        id: user.id,
        steamId: user.steamId,
        dotaAccountId: 787,
        pubStatsAt: null,
      },
      now,
    );

    const current = await pubOf(user.id);
    expect(current.raw && JSON.parse(current.raw)).toEqual(newerStats);
    expect(current.at?.getTime()).toBe(now + 1_000);
  });

  it("ensurePubStats writes nothing when OpenDota is unreachable", async () => {
    const user = await makeUser("Blip Player");
    // Default mockPubFetch is ok:false.
    await ensurePubStats(
      prisma,
      {
        id: user.id,
        steamId: user.steamId,
        dotaAccountId: 780,
        pubStatsAt: null,
      },
      Date.UTC(2026, 7, 1),
    );
    const { raw, at } = await pubOf(user.id);
    expect(raw).toBeNull();
    expect(at).toBeNull();
  });

  it("clearing the Dota account clears the snapshot with the medal", async () => {
    const user = await makeUser("Unlink Player");
    await prisma.user.update({
      where: { id: user.id },
      data: {
        // No derivable account: a non-numeric steamId means "clear" leaves
        // accountId null and takes the wipe branch.
        steamId: `x-${user.id}`,
        dotaAccountId: 781,
        rankTier: 53,
        pubStats: JSON.stringify(PUB_FIXTURE),
        pubStatsAt: new Date(),
      },
    });
    mockRequireUser.mockResolvedValue(
      sessionFor(
        await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ),
    );

    const fd = new FormData();
    fd.set("dotaAccountId", "");
    const res = await updateDotaAccount({}, fd);
    expect(res?.error).toBeUndefined();

    const { raw, at } = await pubOf(user.id);
    expect(raw).toBeNull();
    expect(at).toBeNull();
  });
});
