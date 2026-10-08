// Dota 2 item lookups over the bundled catalogue (item-catalogue.ts, generated
// from OpenDota's constants). Server code only: the catalogue is ~500 rows, so
// client components take an Item prop instead of importing this module.

import { ITEMS } from "./item-catalogue";

export type ItemKind =
  /** A shop item that lives in the main inventory. */
  | "item"
  /** Used up when used: wards, tangos, salves, smoke, dust. */
  | "consumable"
  /** A neutral item from the jungle, worn in the neutral slot. */
  | "neutral"
  /** A neutral enchantment, worn beside the neutral item. */
  | "enchantment"
  /** An unbuilt recipe scroll. */
  | "recipe";

export type Item = {
  id: number;
  /** Image stem on Valve's CDN, e.g. "blink". */
  img: string;
  name: string;
  kind: ItemKind;
};

const BY_ID = new Map<number, Item>(ITEMS.map((item) => [item.id, item]));

/** Look up an item by its Dota 2 numeric id (as used by OpenDota). */
export function itemById(id: number): Item | null {
  return BY_ID.get(id) ?? null;
}

/**
 * An item the catalogue doesn't know yet (a patch newer than the bundle) still
 * gets a name and a tile, never a blank: rerun
 * scripts/generate-item-catalogue.mjs to name it.
 */
export function itemOrUnknown(id: number): Item {
  return itemById(id) ?? { id, img: "", name: `Item ${id}`, kind: "item" };
}
