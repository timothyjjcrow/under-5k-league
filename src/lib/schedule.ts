// Round-robin schedule generation (circle method) + single-elimination seeding.
// Pure + testable.

export type Pairing = { home: string; away: string };

/**
 * Generate a round-robin: every team plays every other once (or twice if
 * `doubleRound`). Returns an array of rounds (weeks); each round is a list of
 * pairings. Handles odd team counts by inserting a bye.
 */
export function roundRobin(teamIds: string[], doubleRound = false): Pairing[][] {
  const teams = [...teamIds];
  if (teams.length < 2) return [];

  const BYE = "__BYE__";
  if (teams.length % 2 !== 0) teams.push(BYE);

  const n = teams.length;
  const arr = [...teams];
  const rounds: Pairing[][] = [];

  for (let r = 0; r < n - 1; r++) {
    const pairings: Pairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== BYE && b !== BYE) {
        // Alternate home/away by round so it's roughly balanced.
        pairings.push(r % 2 === 0 ? { home: a, away: b } : { home: b, away: a });
      }
    }
    rounds.push(pairings);

    // Rotate all but the first element clockwise.
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop() as string);
    arr.splice(0, arr.length, fixed, ...rest);
  }

  if (doubleRound) {
    const second = rounds.map((round) =>
      round.map((p) => ({ home: p.away, away: p.home })),
    );
    return [...rounds, ...second];
  }
  return rounds;
}

/**
 * Standard single-elimination seeding order for a bracket of `size` slots
 * (size must be a power of two). Returns the 1-indexed seed positions so that
 * seed 1 meets the lowest seed, etc. e.g. size 4 -> [1,4,2,3].
 */
export function seedOrder(size: number): number[] {
  let rounds = [1, 2];
  while (rounds.length < size) {
    const next: number[] = [];
    const total = rounds.length * 2 + 1;
    for (const s of rounds) {
      next.push(s);
      next.push(total - s);
    }
    rounds = next;
  }
  return rounds;
}

/**
 * Build first-round playoff pairings from an ordered list of seeded team IDs.
 * Takes the top `bracketSize` seeds (power of two). e.g. 4 teams -> 1v4, 2v3.
 */
export function playoffFirstRound(
  seededTeamIds: string[],
  bracketSize: number,
): Pairing[] {
  const order = seedOrder(bracketSize);
  const pairings: Pairing[] = [];
  for (let i = 0; i < order.length; i += 2) {
    const homeSeed = order[i];
    const awaySeed = order[i + 1];
    const home = seededTeamIds[homeSeed - 1];
    const away = seededTeamIds[awaySeed - 1];
    if (home && away) pairings.push({ home, away });
  }
  return pairings;
}

/** Largest power-of-two bracket that fits the given number of teams (min 2). */
export function pickBracketSize(teamCount: number): number {
  let size = 1;
  while (size * 2 <= teamCount) size *= 2;
  return Math.max(2, size);
}

/** Number of single-elimination rounds for a bracket size (power of two). */
export function bracketRounds(bracketSize: number): number {
  return Math.round(Math.log2(bracketSize));
}

/** Human name for a playoff round given the total number of rounds. */
export function roundName(roundIndex: number, totalRounds: number): string {
  const fromEnd = totalRounds - roundIndex;
  if (fromEnd <= 1) return "Final";
  if (fromEnd === 2) return "Semifinals";
  if (fromEnd === 3) return "Quarterfinals";
  return `Round ${roundIndex + 1}`;
}

/** Pair the winners of one round (in bracket order) into the next round. */
export function nextRoundPairings(winnersInOrder: string[]): Pairing[] {
  const pairings: Pairing[] = [];
  for (let i = 0; i + 1 < winnersInOrder.length; i += 2) {
    pairings.push({ home: winnersInOrder[i], away: winnersInOrder[i + 1] });
  }
  return pairings;
}
