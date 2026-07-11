// Serialize playoff matches into the shape the interactive <Bracket> client
// component renders: full skeleton (TBD slots included), team names, seeds,
// and server-formatted dates (so hydration never disagrees on locale).

import { bracketSkeleton, roundName } from "./schedule";

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

/** Seed number per playoff team: 1-indexed order of the seeded standings. */
export function seedMap(
  standingsOrder: string[],
  bracketSize: number,
): Map<string, number> {
  return new Map(
    standingsOrder.slice(0, bracketSize).map((teamId, i) => [teamId, i + 1]),
  );
}
