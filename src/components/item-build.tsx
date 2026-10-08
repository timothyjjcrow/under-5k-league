import { itemOrUnknown } from "@/lib/items";
import type { PlayerItems } from "@/lib/player-items";
import {
  ItemStrip,
  type ItemIconItem,
  type ItemStripData,
} from "@/components/item-icon";

// Server only: it reads the item catalogue. A client component takes
// `itemStripData`'s plain result as a prop and renders ItemStrip itself.

/** Only what an icon draws crosses to the client. */
function iconItem(id: number): ItemIconItem {
  const item = itemOrUnknown(id);
  return { id: item.id, img: item.img, name: item.name };
}

/** A line's end-of-game items looked up for ItemStrip; null when not stored. */
export function itemStripData(build: Partial<PlayerItems>): ItemStripData | null {
  if (!build.items) return null;
  const neutral = build.neutral ? iconItem(build.neutral) : null;
  const enchantment = build.neutralEnchantment
    ? itemOrUnknown(build.neutralEnchantment)
    : null;
  return {
    slots: build.items.map((id) => (id > 0 ? iconItem(id) : null)),
    backpack: (build.backpack ?? []).filter((id) => id > 0).map(iconItem),
    neutral: neutral
      ? {
          item: neutral,
          title: enchantment
            ? `${neutral.name} (neutral, ${enchantment.name})`
            : `${neutral.name} (neutral)`,
        }
      : null,
  };
}

/** A player's end-of-game items in a server component; nothing when not stored. */
export function ItemBuild({
  build,
  height,
  className,
}: {
  build: Partial<PlayerItems>;
  height?: number;
  className?: string;
}) {
  const data = itemStripData(build);
  return data ? <ItemStrip {...data} height={height} className={className} /> : null;
}
