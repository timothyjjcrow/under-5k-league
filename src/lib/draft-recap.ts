// Draft-night superlatives, computed purely from the drafted rosters so the
// teams page can tell the auction's stories (biggest spend, best steal, …).

export type DraftedPlayer = {
  name: string;
  teamName: string;
  price: number;
  isCaptain: boolean;
  mmr: number | null;
};

export type DraftRecap = {
  /** Priciest single purchase (captains excluded — they aren't bought). */
  biggestSpend: DraftedPlayer | null;
  /** Best MMR-per-dollar purchase. */
  bestValue: (DraftedPlayer & { perDollar: number }) | null;
  /** Team that paid the most in total. */
  topSpender: { teamName: string; spent: number } | null;
  /** Team that paid the least in total. */
  bargainHunter: { teamName: string; spent: number } | null;
  totalSpent: number;
};

export function draftRecap(players: DraftedPlayer[]): DraftRecap {
  const bought = players.filter((p) => !p.isCaptain && p.price > 0);

  let biggestSpend: DraftedPlayer | null = null;
  let bestValue: (DraftedPlayer & { perDollar: number }) | null = null;
  const spentByTeam = new Map<string, number>();

  for (const p of bought) {
    if (!biggestSpend || p.price > biggestSpend.price) biggestSpend = p;
    if (p.mmr != null) {
      const perDollar = p.mmr / p.price;
      if (!bestValue || perDollar > bestValue.perDollar) {
        bestValue = { ...p, perDollar };
      }
    }
    spentByTeam.set(p.teamName, (spentByTeam.get(p.teamName) ?? 0) + p.price);
  }

  let topSpender: { teamName: string; spent: number } | null = null;
  let bargainHunter: { teamName: string; spent: number } | null = null;
  for (const [teamName, spent] of spentByTeam) {
    if (!topSpender || spent > topSpender.spent) topSpender = { teamName, spent };
    if (!bargainHunter || spent < bargainHunter.spent) {
      bargainHunter = { teamName, spent };
    }
  }

  return {
    biggestSpend,
    bestValue,
    topSpender,
    bargainHunter,
    totalSpent: bought.reduce((s, p) => s + p.price, 0),
  };
}
