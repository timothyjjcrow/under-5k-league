// Static Dota 2 hero dataset, generated from OpenDota /constants/heroes.
// Kept in-repo so hero art + name lookups work on both client and server with no
// runtime API call. Regenerate if Valve adds heroes.

export type Hero = {
  id: number;
  /** dota_react asset stem, e.g. "antimage" */
  key: string;
  /** localized display name, e.g. "Anti-Mage" */
  name: string;
};

const CDN =
  "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes";

/** Wide full-body portrait image URL for a hero. */
export function heroPortrait(hero: Hero): string {
  return `${CDN}/${hero.key}.png`;
}

/** Square minimap-style icon URL for a hero. */
export function heroIcon(hero: Hero): string {
  return `${CDN}/icons/${hero.key}.png`;
}

export const HEROES: Hero[] = [
  { id: 102, key: "abaddon", name: "Abaddon" },
  { id: 73, key: "alchemist", name: "Alchemist" },
  { id: 68, key: "ancient_apparition", name: "Ancient Apparition" },
  { id: 1, key: "antimage", name: "Anti-Mage" },
  { id: 113, key: "arc_warden", name: "Arc Warden" },
  { id: 2, key: "axe", name: "Axe" },
  { id: 3, key: "bane", name: "Bane" },
  { id: 65, key: "batrider", name: "Batrider" },
  { id: 38, key: "beastmaster", name: "Beastmaster" },
  { id: 4, key: "bloodseeker", name: "Bloodseeker" },
  { id: 62, key: "bounty_hunter", name: "Bounty Hunter" },
  { id: 78, key: "brewmaster", name: "Brewmaster" },
  { id: 99, key: "bristleback", name: "Bristleback" },
  { id: 61, key: "broodmother", name: "Broodmother" },
  { id: 96, key: "centaur", name: "Centaur Warrunner" },
  { id: 81, key: "chaos_knight", name: "Chaos Knight" },
  { id: 66, key: "chen", name: "Chen" },
  { id: 56, key: "clinkz", name: "Clinkz" },
  { id: 51, key: "rattletrap", name: "Clockwerk" },
  { id: 5, key: "crystal_maiden", name: "Crystal Maiden" },
  { id: 55, key: "dark_seer", name: "Dark Seer" },
  { id: 119, key: "dark_willow", name: "Dark Willow" },
  { id: 135, key: "dawnbreaker", name: "Dawnbreaker" },
  { id: 50, key: "dazzle", name: "Dazzle" },
  { id: 43, key: "death_prophet", name: "Death Prophet" },
  { id: 87, key: "disruptor", name: "Disruptor" },
  { id: 69, key: "doom_bringer", name: "Doom" },
  { id: 49, key: "dragon_knight", name: "Dragon Knight" },
  { id: 6, key: "drow_ranger", name: "Drow Ranger" },
  { id: 107, key: "earth_spirit", name: "Earth Spirit" },
  { id: 7, key: "earthshaker", name: "Earthshaker" },
  { id: 103, key: "elder_titan", name: "Elder Titan" },
  { id: 106, key: "ember_spirit", name: "Ember Spirit" },
  { id: 58, key: "enchantress", name: "Enchantress" },
  { id: 33, key: "enigma", name: "Enigma" },
  { id: 41, key: "faceless_void", name: "Faceless Void" },
  { id: 121, key: "grimstroke", name: "Grimstroke" },
  { id: 72, key: "gyrocopter", name: "Gyrocopter" },
  { id: 123, key: "hoodwink", name: "Hoodwink" },
  { id: 59, key: "huskar", name: "Huskar" },
  { id: 74, key: "invoker", name: "Invoker" },
  { id: 91, key: "wisp", name: "Io" },
  { id: 64, key: "jakiro", name: "Jakiro" },
  { id: 8, key: "juggernaut", name: "Juggernaut" },
  { id: 90, key: "keeper_of_the_light", name: "Keeper of the Light" },
  { id: 145, key: "kez", name: "Kez" },
  { id: 23, key: "kunkka", name: "Kunkka" },
  { id: 155, key: "largo", name: "Largo" },
  { id: 104, key: "legion_commander", name: "Legion Commander" },
  { id: 52, key: "leshrac", name: "Leshrac" },
  { id: 31, key: "lich", name: "Lich" },
  { id: 54, key: "life_stealer", name: "Lifestealer" },
  { id: 25, key: "lina", name: "Lina" },
  { id: 26, key: "lion", name: "Lion" },
  { id: 80, key: "lone_druid", name: "Lone Druid" },
  { id: 48, key: "luna", name: "Luna" },
  { id: 77, key: "lycan", name: "Lycan" },
  { id: 97, key: "magnataur", name: "Magnus" },
  { id: 136, key: "marci", name: "Marci" },
  { id: 129, key: "mars", name: "Mars" },
  { id: 94, key: "medusa", name: "Medusa" },
  { id: 82, key: "meepo", name: "Meepo" },
  { id: 9, key: "mirana", name: "Mirana" },
  { id: 114, key: "monkey_king", name: "Monkey King" },
  { id: 10, key: "morphling", name: "Morphling" },
  { id: 138, key: "muerta", name: "Muerta" },
  { id: 89, key: "naga_siren", name: "Naga Siren" },
  { id: 53, key: "furion", name: "Nature's Prophet" },
  { id: 36, key: "necrolyte", name: "Necrophos" },
  { id: 60, key: "night_stalker", name: "Night Stalker" },
  { id: 88, key: "nyx_assassin", name: "Nyx Assassin" },
  { id: 84, key: "ogre_magi", name: "Ogre Magi" },
  { id: 57, key: "omniknight", name: "Omniknight" },
  { id: 111, key: "oracle", name: "Oracle" },
  { id: 76, key: "obsidian_destroyer", name: "Outworld Devourer" },
  { id: 120, key: "pangolier", name: "Pangolier" },
  { id: 44, key: "phantom_assassin", name: "Phantom Assassin" },
  { id: 12, key: "phantom_lancer", name: "Phantom Lancer" },
  { id: 110, key: "phoenix", name: "Phoenix" },
  { id: 137, key: "primal_beast", name: "Primal Beast" },
  { id: 13, key: "puck", name: "Puck" },
  { id: 14, key: "pudge", name: "Pudge" },
  { id: 45, key: "pugna", name: "Pugna" },
  { id: 39, key: "queenofpain", name: "Queen of Pain" },
  { id: 15, key: "razor", name: "Razor" },
  { id: 32, key: "riki", name: "Riki" },
  { id: 131, key: "ringmaster", name: "Ring Master" },
  { id: 86, key: "rubick", name: "Rubick" },
  { id: 16, key: "sand_king", name: "Sand King" },
  { id: 79, key: "shadow_demon", name: "Shadow Demon" },
  { id: 11, key: "nevermore", name: "Shadow Fiend" },
  { id: 27, key: "shadow_shaman", name: "Shadow Shaman" },
  { id: 75, key: "silencer", name: "Silencer" },
  { id: 101, key: "skywrath_mage", name: "Skywrath Mage" },
  { id: 28, key: "slardar", name: "Slardar" },
  { id: 93, key: "slark", name: "Slark" },
  { id: 128, key: "snapfire", name: "Snapfire" },
  { id: 35, key: "sniper", name: "Sniper" },
  { id: 67, key: "spectre", name: "Spectre" },
  { id: 71, key: "spirit_breaker", name: "Spirit Breaker" },
  { id: 17, key: "storm_spirit", name: "Storm Spirit" },
  { id: 18, key: "sven", name: "Sven" },
  { id: 105, key: "techies", name: "Techies" },
  { id: 46, key: "templar_assassin", name: "Templar Assassin" },
  { id: 109, key: "terrorblade", name: "Terrorblade" },
  { id: 29, key: "tidehunter", name: "Tidehunter" },
  { id: 98, key: "shredder", name: "Timbersaw" },
  { id: 34, key: "tinker", name: "Tinker" },
  { id: 19, key: "tiny", name: "Tiny" },
  { id: 83, key: "treant", name: "Treant Protector" },
  { id: 95, key: "troll_warlord", name: "Troll Warlord" },
  { id: 100, key: "tusk", name: "Tusk" },
  { id: 108, key: "abyssal_underlord", name: "Underlord" },
  { id: 85, key: "undying", name: "Undying" },
  { id: 70, key: "ursa", name: "Ursa" },
  { id: 20, key: "vengefulspirit", name: "Vengeful Spirit" },
  { id: 40, key: "venomancer", name: "Venomancer" },
  { id: 47, key: "viper", name: "Viper" },
  { id: 92, key: "visage", name: "Visage" },
  { id: 126, key: "void_spirit", name: "Void Spirit" },
  { id: 37, key: "warlock", name: "Warlock" },
  { id: 63, key: "weaver", name: "Weaver" },
  { id: 21, key: "windrunner", name: "Windranger" },
  { id: 112, key: "winter_wyvern", name: "Winter Wyvern" },
  { id: 30, key: "witch_doctor", name: "Witch Doctor" },
  { id: 42, key: "skeleton_king", name: "Wraith King" },
  { id: 22, key: "zuus", name: "Zeus" },
];

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const BY_NORM = new Map<string, Hero>();
for (const h of HEROES) {
  BY_NORM.set(norm(h.name), h);
  BY_NORM.set(norm(h.key), h);
}

// Common shorthands players type in the favorite-heroes field.
const ALIASES: Record<string, string> = {
  am: "Anti-Mage",
  cm: "Crystal Maiden",
  wr: "Windranger",
  sf: "Shadow Fiend",
  es: "Earthshaker",
  pa: "Phantom Assassin",
  wk: "Wraith King",
  np: "Nature's Prophet",
  qop: "Queen of Pain",
  ta: "Templar Assassin",
  tb: "Terrorblade",
  ck: "Chaos Knight",
  dk: "Dragon Knight",
  void: "Faceless Void",
  bm: "Beastmaster",
  veno: "Venomancer",
  wd: "Witch Doctor",
  ursa: "Ursa",
  jugg: "Juggernaut",
};
for (const [alias, name] of Object.entries(ALIASES)) {
  const hero = BY_NORM.get(norm(name));
  if (hero) BY_NORM.set(norm(alias), hero);
}

/** Look up a hero by display name, asset key, or common alias. */
export function findHero(query: string): Hero | null {
  const n = norm(query);
  return n ? BY_NORM.get(n) ?? null : null;
}

export type ParsedHeroes = { matched: Hero[]; unmatched: string[] };

/**
 * Split a free-text hero string (comma/slash/pipe separated) into recognized
 * heroes plus any leftover tokens we couldn't match.
 */
export function parseHeroList(value: string | null | undefined): ParsedHeroes {
  const matched: Hero[] = [];
  const unmatched: string[] = [];
  const seen = new Set<number>();
  if (!value) return { matched, unmatched };
  for (const raw of value.split(/[,/|]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const hero = findHero(token);
    if (hero) {
      if (!seen.has(hero.id)) {
        seen.add(hero.id);
        matched.push(hero);
      }
    } else {
      unmatched.push(token);
    }
  }
  return { matched, unmatched };
}
