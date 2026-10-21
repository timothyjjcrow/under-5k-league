// A player's end-of-game items on a stored box-score line. Pure + DB-free:
// the importer and the OpenDota backfill build them from a match payload, and
// every reader validates them through `normalizedPlayerItems`.
//
// They come from the plain /matches/{id} payload, so every league game has
// them, parsed replay or not. Buy order and timings (`purchase_log`) exist
// only for parsed replays, so they are not stored.

import type { OpenDotaPlayer } from "./dota";

/** Comfortably above every Dota item id; anything larger is corrupt. */
const MAX_ITEM_ID = 100_000;
const INVENTORY_KEYS = ["item_0", "item_1", "item_2", "item_3", "item_4", "item_5"] as const;
const BACKPACK_KEYS = ["backpack_0", "backpack_1", "backpack_2"] as const;
const OPEN_DOTA_ITEM_KEYS = [
  ...INVENTORY_KEYS,
  ...BACKPACK_KEYS,
  "item_neutral",
  "item_neutral2",
] as const;

type OpenDotaItemFields = Pick<OpenDotaPlayer, (typeof OPEN_DOTA_ITEM_KEYS)[number]>;

export type PlayerItems = {
  /** The six inventory slots in slot order, 0 for an empty slot. Null when
   *  OpenDota's payload carried no items for this player. */
  items: number[] | null;
  /** The three backpack slots, same encoding. */
  backpack: number[] | null;
  /** The neutral item, or null for an empty slot. */
  neutral: number | null;
  /** The neutral enchantment worn beside it, or null. */
  neutralEnchantment: number | null;
};

/** No item data: what a line gets when OpenDota has nothing to add. */
export const NO_PLAYER_ITEMS: PlayerItems = {
  items: null,
  backpack: null,
  neutral: null,
  neutralEnchantment: null,
};

function slotId(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_ITEM_ID
    ? value
    : null;
}

/** A positive item id, or null for an empty or unusable slot. */
function heldItem(value: unknown): number | null {
  const id = slotId(value);
  return id && id > 0 ? id : null;
}

function slots(values: unknown[]): number[] | null {
  // A payload with none of these keys has no item data at all; one with some
  // keeps its slot order, and an unusable value reads as an empty slot.
  if (!values.some((value) => typeof value === "number")) return null;
  return values.map((value) => slotId(value) ?? 0);
}

/** Read a player's final items from an OpenDota match payload. */
export function playerItemsFromOpenDota(
  player: OpenDotaPlayer | undefined,
): PlayerItems {
  if (!player) return NO_PLAYER_ITEMS;
  const items = slots(INVENTORY_KEYS.map((key) => player[key]));
  if (!items) return NO_PLAYER_ITEMS;
  return {
    items,
    backpack: slots(BACKPACK_KEYS.map((key) => player[key])),
    neutral: heldItem(player.item_neutral),
    neutralEnchantment: heldItem(player.item_neutral2),
  };
}

/**
 * A player's raw item fields, bounded for saved import evidence
 * (`serializeImportEvidence`), so a game imported from that evidence on a
 * later pass keeps its build. A number stays a number (an unusable id
 * becomes the empty slot `playerItemsFromOpenDota` would read it as) and any
 * other value is left out, so the saved copy reads back exactly as the
 * payload it came from.
 */
export function openDotaItemFields(player: OpenDotaPlayer): OpenDotaItemFields {
  const fields: OpenDotaItemFields = {};
  for (const key of OPEN_DOTA_ITEM_KEYS) {
    const value: unknown = player[key];
    if (typeof value === "number") fields[key] = slotId(value) ?? 0;
  }
  return fields;
}

function storedSlots(value: unknown, length: number): number[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== length) return undefined;
  const ids = value.map(slotId);
  return ids.every((id): id is number => id !== null) ? ids : undefined;
}

/**
 * Validate the item fields of a stored line. A legacy line (imported before
 * items were stored) has no `items` key and gets none back; a malformed field
 * is dropped rather than guessed, so it can never render a wrong item.
 */
export function normalizedPlayerItems(
  line: Record<string, unknown>,
): Partial<PlayerItems> {
  if (!("items" in line)) return {};
  const items = storedSlots(line.items, INVENTORY_KEYS.length);
  if (items === undefined) return {};
  if (items === null) return NO_PLAYER_ITEMS;
  return {
    items,
    backpack: storedSlots(line.backpack, BACKPACK_KEYS.length) ?? null,
    neutral: line.neutral === null ? null : heldItem(line.neutral),
    neutralEnchantment:
      line.neutralEnchantment === null ? null : heldItem(line.neutralEnchantment),
  };
}

/** Every distinct item a player finished with, inventory then backpack. */
export function finishedItemIds(line: Partial<PlayerItems>): number[] {
  const ids = [...(line.items ?? []), ...(line.backpack ?? [])].filter((id) => id > 0);
  return [...new Set(ids)];
}
