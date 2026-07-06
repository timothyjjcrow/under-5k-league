import { describe, it, expect } from "vitest";
import { steamIdToAccountId, accountIdToSteamId64, parseMatchId } from "./dota";

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
