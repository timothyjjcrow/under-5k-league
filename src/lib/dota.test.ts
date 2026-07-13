import { describe, it, expect, vi, afterEach } from "vitest";
import {
  steamIdToAccountId,
  accountIdToSteamId64,
  parseAccountId,
  parseMatchId,
  fetchRankTier,
} from "./dota";

describe("steamIdToAccountId", () => {
  it("converts a SteamID64 to a 32-bit Dota account id and back", () => {
    expect(steamIdToAccountId("76561198030654385")).toBe(70388657);
    expect(accountIdToSteamId64(70388657)).toBe("76561198030654385");
  });
  it("returns null for values below the Steam64 base or non-numeric", () => {
    expect(steamIdToAccountId("123")).toBeNull();
    expect(steamIdToAccountId("not-a-number")).toBeNull();
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
    expect(parseAccountId("no digits here")).toBeNull();
  });
});

describe("fetchRankTier", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (impl: () => Promise<unknown>) =>
    vi.stubGlobal("fetch", vi.fn(impl));

  it("returns ok:true with the medal on a 200", async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ rank_tier: 55 }) }));
    expect(await fetchRankTier(123)).toEqual({ ok: true, rankTier: 55 });
  });

  it("returns ok:true rankTier:null when the profile has no rank", async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ rank_tier: null }) }));
    expect(await fetchRankTier(123)).toEqual({ ok: true, rankTier: null });
  });

  it("returns ok:FALSE on a 429 rate limit — not a null medal", async () => {
    stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    expect(await fetchRankTier(123)).toEqual({ ok: false, rankTier: null });
  });

  it("returns ok:FALSE when the request throws (timeout / network)", async () => {
    stubFetch(async () => {
      throw new Error("The operation timed out");
    });
    expect(await fetchRankTier(123)).toEqual({ ok: false, rankTier: null });
  });
});
