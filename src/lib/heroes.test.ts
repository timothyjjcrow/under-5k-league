import { describe, expect, it } from "vitest";
import {
  HEROES,
  findHero,
  heroIcon,
  heroPortrait,
  parseHeroList,
  clampHeroList,
  heroBySlug,
  heroPagePath,
  heroSearchDestination,
  heroSlug,
  searchHeroes,
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

describe("clampHeroList", () => {
  it("leaves a short list untouched (but trimmed)", () => {
    expect(clampHeroList("  Pudge, Lion  ", 200)).toBe("Pudge, Lion");
  });

  it("drops whole names rather than cutting one in half", () => {
    // The bug: a raw .slice(0, n) stored "…, Legion Comman", which then
    // rendered as garbage in the player pool and the draft room.
    const out = clampHeroList("Anti-Mage, Legion Commander", 20);
    expect(out).toBe("Anti-Mage");
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it("keeps as many whole names as fit", () => {
    const out = clampHeroList("Pudge, Lion, Sniper, Invoker", 20);
    expect(out).toBe("Pudge, Lion, Sniper");
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it("handles empty and separator-only input", () => {
    expect(clampHeroList("", 200)).toBe("");
    expect(clampHeroList("  ,  , ", 200)).toBe(",  ,");
  });

  it("returns nothing when even the first name doesn't fit", () => {
    expect(clampHeroList("Legion Commander", 3)).toBe("");
  });
});

describe("hero page slugs", () => {
  it("spell the display name, never the asset key", () => {
    const slug = (name: string) => heroSlug(findHero(name)!);
    expect(slug("Anti-Mage")).toBe("anti-mage");
    expect(slug("Nature's Prophet")).toBe("natures-prophet");
    expect(slug("Clockwerk")).toBe("clockwerk");
    expect(slug("Io")).toBe("io");
    expect(slug("Keeper of the Light")).toBe("keeper-of-the-light");
  });
  it("are unique and URL-safe for every hero, and round-trip", () => {
    const slugs = HEROES.map(heroSlug);
    expect(new Set(slugs).size).toBe(HEROES.length);
    for (const hero of HEROES) {
      expect(heroSlug(hero)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(heroBySlug(heroSlug(hero))).toBe(hero);
    }
  });
  it("build the page address, keeping an archived season", () => {
    const hero = findHero("Anti-Mage")!;
    expect(heroPagePath(hero)).toBe("/meta/anti-mage");
    expect(heroPagePath(hero, "season 1")).toBe("/meta/anti-mage?season=season+1");
  });
  it("name no hero for an unknown or non-canonical address", () => {
    expect(heroBySlug("rattletrap")).toBeNull();
    expect(heroBySlug("Anti-Mage")).toBeNull();
    expect(heroBySlug("")).toBeNull();
  });
});

describe("searchHeroes", () => {
  const names = (query: string) => searchHeroes(query).map((hero) => hero.name);
  it("puts an exact name or shorthand first", () => {
    expect(names("jugg")[0]).toBe("Juggernaut");
    expect(names("am")[0]).toBe("Anti-Mage");
    expect(names("Io")[0]).toBe("Io");
  });
  it("ranks names that start with the text above names that contain it", () => {
    const hits = names("lion");
    expect(hits[0]).toBe("Lion");
    // "Dragon Knight" etc. never match "lion"; only real substrings do.
    for (const name of hits) expect(name.toLowerCase().replace(/[^a-z]/g, "")).toContain("lion");
  });
  it("finds a hero by its old asset key", () => {
    expect(names("rattletrap")).toContain("Clockwerk");
  });
  it("is empty for blank text and capped at the limit", () => {
    expect(searchHeroes("   ")).toEqual([]);
    expect(searchHeroes("a", 5)).toHaveLength(5);
  });
});

describe("heroSearchDestination", () => {
  it("sends a submitted search to the best match's page", () => {
    expect(heroSearchDestination("jugg")).toBe("/meta/juggernaut");
    expect(heroSearchDestination("AM", "s1")).toBe("/meta/anti-mage?season=s1");
  });
  it("goes back to Hero meta when nothing matches", () => {
    expect(heroSearchDestination("zzzz")).toBe("/meta");
    expect(heroSearchDestination("", "s1")).toBe("/meta?season=s1");
  });
});
