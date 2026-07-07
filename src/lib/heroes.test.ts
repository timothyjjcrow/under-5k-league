import { describe, expect, it } from "vitest";
import {
  HEROES,
  findHero,
  heroIcon,
  heroPortrait,
  parseHeroList,
} from "./heroes";

describe("findHero", () => {
  it("matches exact localized names", () => {
    expect(findHero("Anti-Mage")?.key).toBe("antimage");
    expect(findHero("Crystal Maiden")?.key).toBe("crystal_maiden");
  });
  it("is case- and punctuation-insensitive", () => {
    expect(findHero("anti mage")?.key).toBe("antimage");
    expect(findHero("  ANTIMAGE ")?.key).toBe("antimage");
  });
  it("matches asset keys", () => {
    expect(findHero("shadow_fiend")?.name).toBe("Shadow Fiend");
  });
  it("resolves common aliases", () => {
    expect(findHero("am")?.name).toBe("Anti-Mage");
    expect(findHero("wr")?.name).toBe("Windranger");
  });
  it("returns null for unknown or empty input", () => {
    expect(findHero("Definitely Not A Hero")).toBeNull();
    expect(findHero("")).toBeNull();
  });
});

describe("parseHeroList", () => {
  it("splits and matches a comma-separated list", () => {
    const { matched, unmatched } = parseHeroList("Invoker, Pudge, Juggernaut");
    expect(matched.map((h) => h.name)).toEqual([
      "Invoker",
      "Pudge",
      "Juggernaut",
    ]);
    expect(unmatched).toEqual([]);
  });
  it("dedupes repeated heroes", () => {
    const { matched } = parseHeroList("Pudge, pudge, PUDGE");
    expect(matched).toHaveLength(1);
  });
  it("separates unmatched tokens", () => {
    const { matched, unmatched } = parseHeroList("Invoker / SomeRandomGuy");
    expect(matched.map((h) => h.name)).toEqual(["Invoker"]);
    expect(unmatched).toEqual(["SomeRandomGuy"]);
  });
  it("handles empty and null input", () => {
    expect(parseHeroList("")).toEqual({ matched: [], unmatched: [] });
    expect(parseHeroList(null)).toEqual({ matched: [], unmatched: [] });
    expect(parseHeroList("  ,  ")).toEqual({ matched: [], unmatched: [] });
  });
});

describe("hero image urls", () => {
  it("builds portrait and icon urls from the asset key", () => {
    const am = findHero("Anti-Mage")!;
    expect(heroPortrait(am)).toMatch(/heroes\/antimage\.png$/);
    expect(heroIcon(am)).toMatch(/heroes\/icons\/antimage\.png$/);
  });
  it("has a unique key per hero", () => {
    const keys = new Set(HEROES.map((h) => h.key));
    expect(keys.size).toBe(HEROES.length);
  });
});
