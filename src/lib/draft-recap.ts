// Draft-night superlatives from recorded purchases. Legacy callers may supply
// surviving roster observations; their presentation must identify that scope.

export type DraftedPlayer = {
  name: string;
  teamName: string;
  teamId?: string;
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
  topSpender: { teamId?: string; teamName: string; spent: number } | null;
  /** Team that paid the least in total. */
  bargainHunter: { teamId?: string; teamName: string; spent: number } | null;
  totalSpent: number;
};

export function draftRecap(players: DraftedPlayer[]): DraftRecap {
  const bought = players.filter((p) => !p.isCaptain && p.price > 0);

  let biggestSpend: DraftedPlayer | null = null;
  let bestValue: (DraftedPlayer & { perDollar: number }) | null = null;
  const spentByTeam = new Map<string, NonNullable<DraftRecap["topSpender"]>>();

  for (const p of bought) {
    if (!biggestSpend || p.price > biggestSpend.price) biggestSpend = p;
    if (p.mmr != null) {
      const perDollar = p.mmr / p.price;
      if (!bestValue || perDollar > bestValue.perDollar) {
        bestValue = { ...p, perDollar };
      }
    }
    const key = JSON.stringify(p.teamId ? ["id", p.teamId] : ["legacy-name", p.teamName]);
    const spending = spentByTeam.get(key) ?? {
      ...(p.teamId ? { teamId: p.teamId } : {}), teamName: p.teamName, spent: 0,
    };
    spending.spent += p.price;
    spentByTeam.set(key, spending);
  }

  let topSpender: DraftRecap["topSpender"] = null;
  let bargainHunter: DraftRecap["bargainHunter"] = null;
  for (const spending of spentByTeam.values()) {
    if (!topSpender || spending.spent > topSpender.spent) topSpender = spending;
    if (!bargainHunter || spending.spent < bargainHunter.spent) {
      bargainHunter = spending;
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
