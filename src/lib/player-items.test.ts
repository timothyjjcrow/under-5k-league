import { describe, expect, it } from "vitest";
import type { OpenDotaPlayer } from "./dota";
import {
  NO_PLAYER_ITEMS,
  finishedItemIds,
  normalizedPlayerItems,
  playerItemsFromOpenDota,
} from "./player-items";

function odPlayer(overrides: Partial<OpenDotaPlayer> = {}): OpenDotaPlayer {
  return {
    account_id: 1,
    player_slot: 0,
    hero_id: 1,
    kills: 0,
    deaths: 0,
    assists: 0,
    ...overrides,
  };
}

describe("playerItemsFromOpenDota", () => {
  it("keeps slot order with 0 for an empty slot", () => {
    expect(
      playerItemsFromOpenDota(
        odPlayer({
          item_0: 1,
          item_1: 0,
          item_2: 206,
          item_3: 610,
          item_4: 0,
          item_5: 48,
          backpack_0: 0,
          backpack_1: 37,
          backpack_2: 0,
          item_neutral: 1604,
          item_neutral2: 1583,
        }),
      ),
    ).toEqual({
      items: [1, 0, 206, 610, 0, 48],
      backpack: [0, 37, 0],
      neutral: 1604,
      neutralEnchantment: 1583,
    });
  });

  it("reads empty neutral slots as null", () => {
    const items = playerItemsFromOpenDota(
      odPlayer({ item_0: 1, item_neutral: 0, item_neutral2: 0 }),
    );
    expect(items.neutral).toBeNull();
    expect(items.neutralEnchantment).toBeNull();
  });

  it("has nothing for a missing player or a payload with no items", () => {
    expect(playerItemsFromOpenDota(undefined)).toEqual(NO_PLAYER_ITEMS);
    expect(playerItemsFromOpenDota(odPlayer())).toEqual(NO_PLAYER_ITEMS);
  });

  it("treats unusable ids as empty slots instead of inventing items", () => {
    const items = playerItemsFromOpenDota(
      odPlayer({
        item_0: 1,
        item_1: -4,
        item_2: 1.5,
        item_3: Number.NaN,
        item_4: 10_000_000,
        item_neutral: -1,
      }),
    );
    expect(items.items).toEqual([1, 0, 0, 0, 0, 0]);
    expect(items.backpack).toBeNull();
    expect(items.neutral).toBeNull();
  });
});

describe("normalizedPlayerItems", () => {
  it("gives a legacy line no item fields at all", () => {
    expect(normalizedPlayerItems({ heroId: 1 })).toEqual({});
  });

  it("keeps a checked line with no items as all-null", () => {
    expect(normalizedPlayerItems({ items: null })).toEqual(NO_PLAYER_ITEMS);
  });

  it("round-trips stored items", () => {
    const stored = {
      items: [1, 0, 206, 610, 0, 48],
      backpack: [0, 37, 0],
      neutral: 1604,
      neutralEnchantment: null,
    };
    expect(normalizedPlayerItems(JSON.parse(JSON.stringify(stored)))).toEqual(
      stored,
    );
  });

  it("drops malformed inventories rather than guessing", () => {
    expect(normalizedPlayerItems({ items: [1, 2, 3] })).toEqual({});
    expect(normalizedPlayerItems({ items: [1, 2, 3, 4, 5, "6"] })).toEqual({});
    expect(normalizedPlayerItems({ items: "1,2" })).toEqual({});
  });

  it("drops a bad backpack or neutral but keeps the inventory", () => {
    expect(
      normalizedPlayerItems({
        items: [1, 0, 0, 0, 0, 0],
        backpack: [1],
        neutral: "x",
        neutralEnchantment: 0,
      }),
    ).toEqual({
      items: [1, 0, 0, 0, 0, 0],
      backpack: null,
      neutral: null,
      neutralEnchantment: null,
    });
  });
});

describe("finishedItemIds", () => {
  it("lists each held item once, inventory then backpack", () => {
    expect(
      finishedItemIds({ items: [1, 0, 63, 1, 0, 0], backpack: [63, 37, 0] }),
    ).toEqual([1, 63, 37]);
  });

  it("is empty for a line without items", () => {
    expect(finishedItemIds({})).toEqual([]);
    expect(finishedItemIds(NO_PLAYER_ITEMS)).toEqual([]);
  });
});
