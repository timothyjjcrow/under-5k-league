import { describe, expect, it } from "vitest";
import { isLeagueDetail, parseNavigationContext } from "./navigation-context";

const context = {
  href: "/schedule?team=dire&weeks=1%2C2#fixtures",
  scrollY: 750,
  anchorHref: "/matches/example",
  anchorIndex: 0,
  anchorTop: 250,
};

describe("remembered list context", () => {
  it("retains filters, opened weeks, anchor and position for the same list", () => {
    expect(
      parseNavigationContext(JSON.stringify(context), "/schedule#fixtures"),
    ).toEqual(context);
  });
  it("keeps season archives separate from the active schedule", () => {
    expect(
      parseNavigationContext(JSON.stringify(context), "/seasons/old"),
    ).toBeNull();
    const archived = { ...context, href: "/seasons/old#matches" };
    expect(
      parseNavigationContext(JSON.stringify(archived), "/seasons/old"),
    ).toEqual(archived);
    expect(
      parseNavigationContext(JSON.stringify(archived), "/seasons/new"),
    ).toBeNull();
  });
  it.each([
    "https://evil.example/schedule",
    "//evil.example/schedule",
    "/\\evil.example/schedule",
    "javascript:alert(1)",
    "/admin",
    "/api/auth/logout",
  ])("rejects non-list destinations: %s", (href) => {
    expect(
      parseNavigationContext(JSON.stringify({ ...context, href }), "/schedule"),
    ).toBeNull();
  });
  it("falls back when storage is absent, damaged or contains invalid positions", () => {
    for (const raw of [
      null,
      "invalid",
      "null",
      "{}",
      JSON.stringify({ ...context, scrollY: -1 }),
      JSON.stringify({ ...context, anchorHref: "http://[" }),
    ]) {
      expect(parseNavigationContext(raw, "/schedule")).toBeNull();
    }
  });
  it("does not mistake the comparison tool for a player profile", () => {
    expect(isLeagueDetail("/players/compare")).toBe(false);
    expect(isLeagueDetail("/players/123")).toBe(true);
  });
});
