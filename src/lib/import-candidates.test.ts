import { describe, expect, it } from "vitest";
import type { OpenDotaMatch, OpenDotaPlayer } from "./dota";
import { readImportEvidence, serializeImportEvidence } from "./import-candidates";
import { buildPlayers } from "./match-import";

const ITEMS = {
  item_0: 1,
  item_1: 63,
  item_2: 0,
  item_3: 116,
  item_4: 0,
  item_5: 48,
  backpack_0: 36,
  backpack_1: 0,
  backpack_2: 0,
  item_neutral: 359,
  item_neutral2: 1583,
};

function player(slot: number, overrides: Partial<OpenDotaPlayer> = {}): OpenDotaPlayer {
  const isRadiant = slot < 5;
  return {
    account_id: 1000 + slot,
    player_slot: isRadiant ? slot : 123 + slot,
    hero_id: slot + 1,
    isRadiant,
    kills: 4,
    deaths: 2,
    assists: 7,
    personaname: `player ${slot}`,
    net_worth: 15_000,
    gold_per_min: 500,
    xp_per_min: 600,
    benchmarks: { gold_per_min: { raw: 500, pct: 0.6 } },
    ...ITEMS,
    ...overrides,
  };
}

function match(players: OpenDotaPlayer[]): OpenDotaMatch {
  return {
    match_id: 8_100_000_001,
    radiant_win: true,
    duration: 2400,
    start_time: 1_790_000_000,
    radiant_score: 30,
    dire_score: 20,
    leagueid: 19191,
    players,
  };
}

describe("serializeImportEvidence", () => {
  it("keeps end-of-game items, so a game imported from evidence keeps its build", () => {
    const fetched = match(Array.from({ length: 10 }, (_, slot) => player(slot)));
    const saved = readImportEvidence(
      serializeImportEvidence(fetched),
      String(fetched.match_id),
    );
    expect(saved).not.toBeNull();

    const fromEvidence = buildPlayers(saved!, new Map());
    expect(fromEvidence).toEqual(buildPlayers(fetched, new Map()));
    expect(fromEvidence[0]).toMatchObject({
      items: [1, 63, 0, 116, 0, 48],
      backpack: [36, 0, 0],
      neutral: 359,
      neutralEnchantment: 1583,
    });
  });

  it("still fits the payload limit with every field at its largest", () => {
    const benchmarks = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `${i}`.padEnd(80, "m"),
        { raw: -Number.MAX_SAFE_INTEGER, pct: 0.123456789012345 },
      ]),
    );
    const big = Number.MAX_SAFE_INTEGER;
    const largest = Array.from({ length: 10 }, (_, slot) =>
      player(slot, {
        account_id: big,
        personaname: "\u{1F600}".repeat(128),
        kills: big,
        deaths: big,
        assists: big,
        net_worth: big,
        last_hits: big,
        gold_per_min: big,
        xp_per_min: big,
        denies: big,
        level: big,
        hero_damage: big,
        tower_damage: big,
        hero_healing: big,
        benchmarks,
        ...Object.fromEntries(Object.keys(ITEMS).map((key) => [key, 99_999])),
      }),
    );
    expect(() => serializeImportEvidence(match(largest))).not.toThrow();
  });
});
