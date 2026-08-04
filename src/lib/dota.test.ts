import { describe, it, expect, vi, afterEach } from "vitest";
import {
  steamIdToAccountId,
  accountIdToSteamId64,
  parseAccountId,
  parseMatchId,
  parseLeagueId,
  fetchRankTier,
  fetchPubStats,
} from "./dota";

describe("steamIdToAccountId", () => {
  it("converts a SteamID64 to a 32-bit Dota account id and back", () => {
    expect(steamIdToAccountId("76561198030654385")).toBe(70388657);
    expect(accountIdToSteamId64(70388657)).toBe("76561198030654385");
  });
  it("returns null for values below the Steam64 base or non-numeric", () => {
    expect(steamIdToAccountId("123")).toBeNull();
    expect(steamIdToAccountId("not-a-number")).toBeNull();
    expect(
      steamIdToAccountId(accountIdToSteamId64(0x100000000)),
    ).toBeNull();
  });
});

describe("parseMatchId", () => {
  it("extracts the id from raw values and URLs", () => {
    expect(parseMatchId("8880928888")).toBe("8880928888");
    expect(parseMatchId("https://www.opendota.com/matches/8880928888")).toBe(
      "8880928888",
    );
    expect(parseMatchId("https://www.dotabuff.com/matches/8880928888")).toBe(
      "8880928888",
    );
    expect(parseMatchId("  8880928888 ")).toBe("8880928888");
  });
  it("returns null when there's no id", () => {
    expect(parseMatchId("garbage")).toBeNull();
  });
});

describe("parseLeagueId", () => {
  it("extracts the id from raw values and URLs", () => {
    expect(parseLeagueId("17119")).toBe("17119");
    expect(parseLeagueId("  17119 ")).toBe("17119");
    expect(parseLeagueId("https://www.dota2.com/leagues/17119")).toBe("17119");
  });

  // THE regression: a bare /(\d+)/ took the first digit run, so the domain the
  // admin card itself points at parsed to "2" — and a truthy-but-wrong league id
  // silently switches auto-sync to league-feed-only, disabling all result
  // import. The digit floor is what makes the URL safe to paste.
  it("skips the '2' in dota2.com rather than storing it as the league id", () => {
    expect(parseLeagueId("https://www.dota2.com/leagues/17119")).not.toBe("2");
    expect(parseLeagueId("dota2.com")).toBeNull();
    expect(parseLeagueId("Dota 2 league 17119")).toBe("17119");
  });

  it("returns null when there's no plausible id", () => {
    expect(parseLeagueId("garbage")).toBeNull();
    expect(parseLeagueId("")).toBeNull();
    expect(parseLeagueId("123")).toBeNull(); // under the floor
  });
});

describe("parseAccountId", () => {
  it("accepts a raw 32-bit account id", () => {
    expect(parseAccountId("86745912")).toBe(86745912);
  });
  it("converts a pasted SteamID64", () => {
    expect(parseAccountId("76561198046011640")).toBe(85745912);
  });
  it("extracts the id from Dotabuff/OpenDota player URLs", () => {
    expect(parseAccountId("https://www.dotabuff.com/players/86745912")).toBe(
      86745912,
    );
    expect(parseAccountId("https://www.opendota.com/players/86745912")).toBe(
      86745912,
    );
  });
  it("rejects ids beyond 32 bits (mis-pasted / truncated SteamID64)", () => {
    expect(parseAccountId("4294967296")).toBeNull(); // 2^32
    expect(parseAccountId("9007199254740991")).toBeNull();
  });
  it("accepts the 32-bit boundary and rejects garbage", () => {
    expect(parseAccountId("4294967295")).toBe(4294967295);
    expect(
      steamIdToAccountId(accountIdToSteamId64(0xffffffff)),
    ).toBe(0xffffffff);
    expect(parseAccountId("no digits here")).toBeNull();
  });
});

describe("fetchRankTier", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (impl: () => Promise<unknown>) =>
    vi.stubGlobal("fetch", vi.fn(impl));

  it("returns ok:true with the medal on a 200", async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ rank_tier: 55 }) }));
    expect(await fetchRankTier(123)).toEqual({
      ok: true,
      rankTier: 55,
      fhUnavailable: null,
    });
  });

  it("returns ok:true rankTier:null when the profile has no rank", async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ rank_tier: null }) }));
    expect(await fetchRankTier(123)).toEqual({
      ok: true,
      rankTier: null,
      fhUnavailable: null,
    });
  });

  it("carries the private-match-data flag when OpenDota includes it", async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        rank_tier: 44,
        profile: { fh_unavailable: true },
      }),
    }));
    expect(await fetchRankTier(123)).toEqual({
      ok: true,
      rankTier: 44,
      fhUnavailable: true,
    });

    stubFetch(async () => ({
      ok: true,
      json: async () => ({ rank_tier: 44, profile: { fh_unavailable: false } }),
    }));
    expect((await fetchRankTier(123)).fhUnavailable).toBe(false);

    // Non-boolean junk → unknown, never a guess.
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ rank_tier: 44, profile: { fh_unavailable: "yes" } }),
    }));
    expect((await fetchRankTier(123)).fhUnavailable).toBeNull();
  });

  it("returns ok:FALSE on a 429 rate limit — not a null medal", async () => {
    stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    expect(await fetchRankTier(123)).toEqual({
      ok: false,
      rankTier: null,
      fhUnavailable: null,
    });
  });

  it("returns ok:FALSE when the request throws (timeout / network)", async () => {
    stubFetch(async () => {
      throw new Error("The operation timed out");
    });
    expect(await fetchRankTier(123)).toEqual({
      ok: false,
      rankTier: null,
      fhUnavailable: null,
    });
  });
});

describe("fetchPubStats", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Route by URL: the fetcher fires /wl and /heroes in parallel.
  const stubEndpoints = (
    wl: () => Promise<unknown> | unknown,
    heroes: () => Promise<unknown> | unknown,
  ) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/wl") ? wl() : heroes(),
      ),
    );

  const okJson = (body: unknown) => ({ ok: true, json: async () => body });

  it("composes both endpoints into one snapshot", async () => {
    stubEndpoints(
      () => okJson({ win: 54, lose: 46 }),
      () =>
        okJson([
          // hero_id served as a STRING — the endpoint's documented quirk.
          { hero_id: "14", games: 220, win: 121, last_played: 1_722_200_000 },
          { hero_id: 74, games: 180, win: 92, last_played: 1_700_000_000 },
          { hero_id: 99, games: 0, win: 0, last_played: 0 },
        ]),
    );
    expect(await fetchPubStats(123)).toEqual({
      ok: true,
      stats: {
        recentWins: 54,
        recentLosses: 46,
        totalGames: 400,
        lastPlayedAt: 1_722_200_000,
        topHeroes: [
          { heroId: 14, games: 220, wins: 121 },
          { heroId: 74, games: 180, wins: 92 },
        ],
      },
    });
  });

  it("an all-zero answer is a REAL answer (private data), not a failure", async () => {
    stubEndpoints(
      () => okJson({ win: 0, lose: 0 }),
      () => okJson([]),
    );
    expect(await fetchPubStats(123)).toEqual({
      ok: true,
      stats: {
        recentWins: 0,
        recentLosses: 0,
        totalGames: 0,
        lastPlayedAt: null,
        topHeroes: [],
      },
    });
  });

  it("returns ok:FALSE when either endpoint fails — half an answer is no answer", async () => {
    stubEndpoints(
      () => okJson({ win: 10, lose: 5 }),
      () => ({ ok: false, status: 429, json: async () => ({}) }),
    );
    expect(await fetchPubStats(123)).toEqual({ ok: false, stats: null });

    stubEndpoints(
      () => ({ ok: false, status: 500, json: async () => ({}) }),
      () => okJson([]),
    );
    expect(await fetchPubStats(123)).toEqual({ ok: false, stats: null });
  });

  it("returns ok:FALSE on malformed bodies and thrown requests", async () => {
    stubEndpoints(
      () => okJson({ error: "rate limited" }),
      () => okJson([]),
    );
    expect(await fetchPubStats(123)).toEqual({ ok: false, stats: null });

    stubEndpoints(
      () => {
        throw new Error("The operation timed out");
      },
      () => okJson([]),
    );
    expect(await fetchPubStats(123)).toEqual({ ok: false, stats: null });
  });

  it("caps topHeroes at 5, ordered by games", async () => {
    stubEndpoints(
      () => okJson({ win: 1, lose: 1 }),
      () =>
        okJson(
          Array.from({ length: 8 }, (_, i) => ({
            hero_id: i + 1,
            games: 10 + i,
            win: 5,
            last_played: 100 + i,
          })),
        ),
    );
    const res = await fetchPubStats(123);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stats.topHeroes.map((h) => h.heroId)).toEqual([8, 7, 6, 5, 4]);
      expect(res.stats.lastPlayedAt).toBe(107);
    }
  });
});
