// How a team's roster is listed on /teams and a team page.

export type RosterOrderMember = {
  isCaptain: boolean;
  price: number;
};

/**
 * A roster in reading order: the captain first, then everyone else by what
 * they cost at the draft, highest first. Captains join at $0, so ordering by
 * price alone put them last, below the $1 buys. Players on the same price keep
 * the order they were given in (sorting is stable).
 */
export function rosterOrder<T extends RosterOrderMember>(
  members: readonly T[],
): T[] {
  return [...members].sort(
    (a, b) => Number(b.isCaptain) - Number(a.isCaptain) || b.price - a.price,
  );
}
