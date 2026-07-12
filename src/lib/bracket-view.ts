// Serialize playoff matches into the shape the interactive <Bracket> client
// component renders: full skeleton (TBD slots included), team names, seeds,
// and server-formatted dates (so hydration never disagrees on locale).

import {
  bracketSkeleton,
  roundName,
  seedOrder,
  slotIndex,
  slotRound,
} from "./schedule";

export type BracketSide = {
  teamId: string;
  name: string;
  seed: number | null;
};

export type BracketMatchView = {
  id: string;
  home: BracketSide | null;
  away: BracketSide | null;
  homeScore: number;
  awayScore: number;
  completed: boolean;
  winnerTeamId: string | null;
  /** Pre-formatted on the server. */
  when: string | null;
  /** Epoch ms — lets the client re-render times in the viewer's timezone. */
  whenTs: number | null;
  bestOf: number;
};

export type BracketRound = {
  name: string;
  /** null = TBD placeholder — the feeder matches haven't resolved yet. */
  slots: (BracketMatchView | null)[];
};

export type MatchForBracket = {
  id: string;
  bracketSlot: string | null;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  status: string;
  winnerTeamId: string | null;
  scheduledAt: Date | null;
  bestOf: number;
};

export function buildBracketRounds(
  matches: MatchForBracket[],
  teamName: Map<string, string>,
  seedByTeam: Map<string, number>,
  formatWhen: (d: Date) => string,
): BracketRound[] {
  const { totalRounds, rounds } = bracketSkeleton(matches);
  const side = (teamId: string): BracketSide => ({
    teamId,
    name: teamName.get(teamId) ?? "?",
    seed: seedByTeam.get(teamId) ?? null,
  });
  return rounds.map(({ round, slots }) => ({
    name: roundName(round, totalRounds),
    slots: slots.map((m) =>
      m
        ? {
            id: m.id,
            home: side(m.homeTeamId),
            away: side(m.awayTeamId),
            homeScore: m.homeScore,
            awayScore: m.awayScore,
            completed: m.status === "COMPLETED",
            winnerTeamId: m.winnerTeamId,
            when: m.scheduledAt ? formatWhen(m.scheduledAt) : null,
            whenTs: m.scheduledAt?.getTime() ?? null,
            bestOf: m.bestOf,
          }
        : null,
    ),
  }));
}

export type MirrorLayout = {
  /** Wing columns, outermost first — left[i] holds the first half of round i's slots. */
  left: BracketRound[];
  /** Same rounds' second halves; the component renders these mirrored. */
  right: BracketRound[];
  /** The grand final (null = still TBD) and its display name. */
  final: BracketMatchView | null;
  finalName: string;
};

/**
 * Split a linear round list into the classic centered tournament shape: two
 * wings converging on the grand final. Round i (2^(R-1-i) slots) contributes
 * its first half to the left wing and second half to the right — the same
 * halves the R{r}M{m} slot indexing feeds forward, so every wing pair still
 * meets its real next-round slot. A 2-team bracket is just the final.
 */
export function mirrorLayout(rounds: BracketRound[]): MirrorLayout | null {
  if (rounds.length === 0) return null;
  const last = rounds.length - 1;
  const finalRound = rounds[last];
  const left: BracketRound[] = [];
  const right: BracketRound[] = [];
  for (let r = 0; r < last; r++) {
    const { name, slots } = rounds[r];
    const half = Math.floor(slots.length / 2);
    left.push({ name, slots: slots.slice(0, half) });
    right.push({ name, slots: slots.slice(half) });
  }
  return {
    left,
    right,
    final: finalRound.slots[0] ?? null,
    finalName: finalRound.name,
  };
}

/** Seed number per playoff team: 1-indexed order of the seeded standings. */
export function seedMap(
  standingsOrder: string[],
  bracketSize: number,
): Map<string, number> {
  return new Map(
    standingsOrder.slice(0, bracketSize).map((teamId, i) => [teamId, i + 1]),
  );
}

/**
 * Seed numbers derived from the FIRST-ROUND pairings frozen in the DB.
 * createPlayoffBracket pairs slots by `seedOrder` (R0M0 = 1 vs N, R0M1 =
 * next pair…), so the pairings themselves encode every team's seed —
 * recomputing from live standings instead would drift the labels whenever a
 * regular-season result is corrected after the bracket was made (and drop a
 * team's seed entirely if the correction moved them below the cut).
 */
export function seedsFromFirstRound(
  matches: Pick<MatchForBracket, "bracketSlot" | "homeTeamId" | "awayTeamId">[],
): Map<string, number> {
  const slotted = matches.filter((m) => m.bracketSlot);
  if (slotted.length === 0) return new Map();
  const minRound = Math.min(...slotted.map((m) => slotRound(m.bracketSlot)));
  const first = slotted
    .filter((m) => slotRound(m.bracketSlot) === minRound)
    .sort(
      (a, b) =>
        (slotIndex(a.bracketSlot) ?? 0) - (slotIndex(b.bracketSlot) ?? 0),
    );
  const order = seedOrder(first.length * 2);
  const map = new Map<string, number>();
  first.forEach((m, i) => {
    map.set(m.homeTeamId, order[2 * i]);
    map.set(m.awayTeamId, order[2 * i + 1]);
  });
  return map;
}
