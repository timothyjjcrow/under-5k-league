import { describe, expect, it } from "vitest";
import { parseAdminSteamIds, resolveRole } from "./users";

describe("parseAdminSteamIds", () => {
  it("splits on commas, trims, and drops blanks", () => {
    expect(parseAdminSteamIds(" 111, 222 ,,333 ")).toEqual(["111", "222", "333"]);
    expect(parseAdminSteamIds("")).toEqual([]);
    expect(parseAdminSteamIds(undefined)).toEqual([]);
    expect(parseAdminSteamIds(null)).toEqual([]);
  });
});

describe("resolveRole", () => {
  it("makes the allowlist authoritative — only listed SteamIDs are admin", () => {
    expect(
      resolveRole({ steamId: "me", adminSteamIds: ["me"], isFirstUser: false }),
    ).toBe("ADMIN");
    // Everyone not on the list is a plain user…
    expect(
      resolveRole({ steamId: "you", adminSteamIds: ["me"], isFirstUser: false }),
    ).toBe("USER");
    // …even the very first user, so a stray account can't bootstrap in.
    expect(
      resolveRole({ steamId: "you", adminSteamIds: ["me"], isFirstUser: true }),
    ).toBe("USER");
  });

  it("bootstraps the first user as admin only when no allowlist is set", () => {
    expect(
      resolveRole({ steamId: "a", adminSteamIds: [], isFirstUser: true }),
    ).toBe("ADMIN");
    expect(
      resolveRole({ steamId: "b", adminSteamIds: [], isFirstUser: false }),
    ).toBe("USER");
  });

  it("lets the dev-login override win (dev only; blocked in production)", () => {
    expect(
      resolveRole({
        steamId: "x",
        adminSteamIds: ["someone-else"],
        isFirstUser: false,
        forceAdmin: true,
      }),
    ).toBe("ADMIN");
  });
});
