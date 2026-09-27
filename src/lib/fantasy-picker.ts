// What the fantasy picker shows while a manager builds their five: the order
// of the drafted pool and the one status line under the Save button. Pure and
// client-safe (the picker is a client component); the server still validates
// every save with validateFantasyPicks.

/**
 * Numbers render the same on the server and in every browser. The picker is
 * server-rendered and hydrated, so toLocaleString() would print "7.200" in a
 * German browser after the server sent "7,200", and React reports a mismatch.
 */
const mmrNumber = new Intl.NumberFormat("en-US");

export function formatFantasyMmr(value: number): string {
  return mmrNumber.format(value);
}

/**
 * The pool opens most expensive first: managers usually fit one or two stars,
 * then fill the rest under the cap, and the status line says how much MMR is
 * left for that. The first entry is the default.
 */
export const FANTASY_PICKER_ORDERS = [
  { key: "priceHigh", label: "Price, highest first" },
  { key: "priceLow", label: "Price, lowest first" },
  { key: "name", label: "Name A–Z" },
] as const;

export type FantasyPickerOrder = (typeof FANTASY_PICKER_ORDERS)[number]["key"];

export const DEFAULT_FANTASY_PICKER_ORDER: FantasyPickerOrder =
  FANTASY_PICKER_ORDERS[0].key;

export function isFantasyPickerOrder(
  value: string,
): value is FantasyPickerOrder {
  return FANTASY_PICKER_ORDERS.some((order) => order.key === value);
}

/** Sorted copy; equal prices fall back to name, then id, so the order is stable. */
export function orderFantasyCandidates<
  T extends { userId: string; name: string; mmr: number },
>(candidates: readonly T[], order: FantasyPickerOrder): T[] {
  const byName = (a: T, b: T) =>
    a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId);
  return [...candidates].sort((a, b) =>
    order === "priceHigh"
      ? b.mmr - a.mmr || byName(a, b)
      : order === "priceLow"
        ? a.mmr - b.mmr || byName(a, b)
        : byName(a, b),
  );
}

export type FantasyPickerStatus = {
  canSave: boolean;
  overCap: boolean;
  /** "7,200 of 12,450 MMR", or "No salary cap" when the pool is unrated. */
  salary: string;
  /**
   * What to do next, short enough for one line beside the Save button on a
   * 390px phone ("Pick 2 more · 5,250 MMR left"); the count sits above it.
   */
  hint: string;
};

/** The sticky bar's summary: "3 / 5 · 7,200 of 12,450 MMR", then the next step. */
export function fantasyPickerStatus({
  picked,
  slots,
  spent,
  cap,
  hasReleased,
}: {
  picked: number;
  slots: number;
  spent: number;
  /** 0 means the season runs uncapped. */
  cap: number;
  hasReleased: boolean;
}): FantasyPickerStatus {
  const overCap = cap > 0 && spent > cap;
  const canSave = picked === slots && !overCap && !hasReleased;
  const salary =
    cap > 0
      ? `${formatFantasyMmr(spent)} of ${formatFantasyMmr(cap)} MMR`
      : "No salary cap";
  const open = slots - picked;
  const hint = hasReleased
    ? "Remove released players to save."
    : overCap
      ? `Over the cap by ${formatFantasyMmr(spent - cap)} MMR. Swap in someone cheaper.`
      : open > 0
        ? `Pick ${open} more${cap > 0 ? ` · ${formatFantasyMmr(cap - spent)} MMR left` : ""}`
        : "Your five is ready to save.";
  return { canSave, overCap, salary, hint };
}
