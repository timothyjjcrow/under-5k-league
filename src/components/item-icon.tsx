"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const CDN =
  "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items";

/** The item fields an icon needs (an `Item` from src/lib/items.ts fits). */
export type ItemIconItem = { id: number; img: string; name: string };

const TILE = "shrink-0 border border-line/70 bg-surface-2";

/** Valve's item art is 88 × 64; keep that shape at any height. */
function widthFor(height: number) {
  return Math.round((height * 11) / 8);
}

/** Up to two capitals from an item's name: "Blink Dagger" → "BD". */
function itemInitials(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter((word) => /^[A-Za-z0-9]/.test(word))
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

/**
 * An item's art from Valve's CDN, like HeroIcon: if the image can't load (or
 * the catalogue doesn't know the item yet), a tile of the item's initials
 * takes its place instead of a broken-image glyph. `round` draws the neutral
 * slot's circle.
 */
export function ItemIcon({
  item,
  height = 24,
  round = false,
  title,
  className,
}: {
  item: ItemIconItem;
  height?: number;
  round?: boolean;
  /** Hover and spoken text; defaults to the item's name. */
  title?: string;
  className?: string;
}) {
  const src = item.img ? `${CDN}/${item.img}.png` : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const ref = useRef<HTMLImageElement>(null);
  const label = title ?? item.name;
  const width = round ? height : widthFor(height);
  const shape = round ? "rounded-full" : "rounded-[3px]";

  // As in HeroIcon: an image can fail before React attaches onError.
  useEffect(() => {
    const img = ref.current;
    if (!img || !img.complete || img.naturalWidth > 0) return;
    img.decode().catch(() => setFailedSrc(src));
  }, [src]);

  if (!src || failedSrc === src) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        style={{ width, height, fontSize: Math.max(9, Math.round(height * 0.38)) }}
        className={cn(
          TILE,
          shape,
          "inline-flex items-center justify-center font-semibold leading-none text-muted",
          className,
        )}
      >
        <span aria-hidden="true">{itemInitials(item.name) || "?"}</span>
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={src}
      alt={label}
      title={label}
      width={width}
      height={height}
      loading="lazy"
      style={{ width, height }}
      onError={() => setFailedSrc(src)}
      className={cn(TILE, shape, "object-cover", className)}
    />
  );
}

/** An empty inventory slot, the same size as an item: decoration only. */
function EmptyItemSlot({ height = 24 }: { height?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: widthFor(height), height }}
      className="shrink-0 rounded-[3px] border border-line-soft bg-surface-2/40"
    />
  );
}

/**
 * A player's end-of-game items in the game's own order: the six inventory
 * slots (an empty one as a faint tile, so slots line up row to row), the
 * backpack dimmed, then the round neutral slot. Built from plain data
 * (`itemStripData` looks the items up on the server), so a client component
 * such as the match page's BoxScoreLine can take the data as a prop: a
 * server component element handed through its prop drew React key warnings.
 */
export type ItemStripData = {
  /** The six inventory slots; null is an empty slot. */
  slots: (ItemIconItem | null)[];
  backpack: ItemIconItem[];
  neutral: { item: ItemIconItem; title: string } | null;
};

export function ItemStrip({
  slots,
  backpack,
  neutral,
  height = 22,
  className,
}: ItemStripData & {
  height?: number;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Items"
      className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}
    >
      {slots.map((item, slot) =>
        item ? (
          <ItemIcon key={slot} item={item} height={height} />
        ) : (
          <EmptyItemSlot key={slot} height={height} />
        ),
      )}
      {backpack.length > 0 ? (
        <span
          role="group"
          aria-label="Backpack"
          className="ml-1 flex items-center gap-0.5 opacity-60"
        >
          {backpack.map((item, index) => (
            <ItemIcon key={index} item={item} height={Math.round(height * 0.75)} />
          ))}
        </span>
      ) : null}
      {neutral ? (
        <ItemIcon
          item={neutral.item}
          height={height}
          round
          className="ml-1"
          title={neutral.title}
        />
      ) : null}
    </div>
  );
}
