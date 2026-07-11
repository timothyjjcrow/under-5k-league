// Round-robin schedule generation (circle method) + single-elimination seeding.
// Pure + testable.

export type Pairing = { home: string; away: string };

/** Week N's match night: week 1 = the first night, each later week +7 days. */
export function matchNightForWeek(firstNight: Date, week: number): Date {
  return new Date(firstNight.getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000);
}

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
  // Running (home − away) tally per team. Each pairing's home goes to whichever
  // team has hosted least so far, keeping the season's home/away split fair
  // (|home − away| ≤ 1). A plain round-parity rule leaves the circle-method's
  // fixed team badly imbalanced (e.g. all-away).
  const venue = new Map<string, number>();

  for (let r = 0; r < n - 1; r++) {
    const pairings: Pairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== BYE && b !== BYE) {
        const ba = venue.get(a) ?? 0;
        const bb = venue.get(b) ?? 0;
        // Host the team that has hosted least; break ties by round+position
        // parity. This keeps every team's home/away split within 1 all season.
        const [home, away] =
          ba !== bb
            ? ba < bb
              ? [a, b]
              : [b, a]
            : (r + i) % 2 === 0
              ? [a, b]
              : [b, a];
        pairings.push({ home, away });
        venue.set(home, (venue.get(home) ?? 0) + 1);
        venue.set(away, (venue.get(away) ?? 0) - 1);
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

/** Round index encoded in a bracket slot like "R2M1" (0 for non-bracket). */
export function slotRound(slot: string | null | undefined): number {
  const m = slot?.match(/^R(\d+)M/);
  return m ? Number(m[1]) : 0;
}

/**
 * Which teams sit out each regular-season week (odd team counts give the
 * round-robin a rotating bye). Only weeks that have at least one match are
 * reported — a week number is defined by its fixtures.
 */
export function byeTeamsByWeek<
  T extends { week: number; homeTeamId: string; awayTeamId: string; phase: string },
>(matches: T[], teamIds: string[]): Map<number, string[]> {
  const byWeek = new Map<number, Set<string>>();
  for (const m of matches) {
    if (m.phase !== "REGULAR") continue;
    const playing = byWeek.get(m.week) ?? new Set<string>();
    playing.add(m.homeTeamId);
    playing.add(m.awayTeamId);
    byWeek.set(m.week, playing);
  }
  const byes = new Map<number, string[]>();
  for (const [week, playing] of byWeek) {
    byes.set(
      week,
      teamIds.filter((id) => !playing.has(id)),
    );
  }
  return byes;
}

/** Match index encoded in a bracket slot like "R2M1" (null when absent). */
export function slotIndex(slot: string | null | undefined): number | null {
  const m = slot?.match(/M(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Full bracket structure including rounds that haven't been created yet:
 * every round from the first to the final, each with its expected number of
 * slots, holding either the real match or null (a TBD placeholder). This is
 * what lets the bracket UI draw the whole tree — connectors and future
 * rounds — from just the matches that exist so far.
 */
export function bracketSkeleton<T extends { bracketSlot: string | null }>(
  matches: T[],
): { totalRounds: number; rounds: { round: number; slots: (T | null)[] }[] } {
  const firstRound = matches.filter((m) => slotRound(m.bracketSlot) === 0);
  if (firstRound.length === 0) return { totalRounds: 0, rounds: [] };
  const totalRounds = bracketRounds(firstRound.length * 2);

  const rounds = Array.from({ length: totalRounds }, (_, round) => {
    const count = firstRound.length >> round;
    const slots: (T | null)[] = new Array(count).fill(null);
    const inRound = matches
      .filter((m) => slotRound(m.bracketSlot) === round)
      .sort((a, b) => (a.bracketSlot ?? "").localeCompare(b.bracketSlot ?? ""));
    // Place by the slot's M-index; legacy matches without a slot fill gaps
    // in order.
    const strays: T[] = [];
    for (const m of inRound) {
      const i = slotIndex(m.bracketSlot);
      if (i != null && i < count && slots[i] === null) slots[i] = m;
      else strays.push(m);
    }
    for (const m of strays) {
      const gap = slots.indexOf(null);
      if (gap !== -1) slots[gap] = m;
    }
    return { round, slots };
  });
  return { totalRounds, rounds };
}

/**
 * Group playoff matches into ordered rounds for a bracket view, and report how
 * many rounds the bracket has (derived from the first round's match count).
 * Pure so the schedule + dashboard render the same structure.
 */
export function groupPlayoffRounds<T extends { bracketSlot: string | null }>(
  matches: T[],
): { totalRounds: number; rounds: { round: number; matches: T[] }[] } {
  const firstRoundCount = matches.filter(
    (m) => slotRound(m.bracketSlot) === 0,
  ).length;
  const totalRounds = firstRoundCount > 0 ? bracketRounds(firstRoundCount * 2) : 0;
  const roundNums = [
    ...new Set(matches.map((m) => slotRound(m.bracketSlot))),
  ].sort((a, b) => a - b);
  const rounds = roundNums.map((round) => ({
    round,
    matches: matches
      .filter((m) => slotRound(m.bracketSlot) === round)
      .sort((a, b) => (a.bracketSlot ?? "").localeCompare(b.bracketSlot ?? "")),
  }));
  return { totalRounds, rounds };
}
