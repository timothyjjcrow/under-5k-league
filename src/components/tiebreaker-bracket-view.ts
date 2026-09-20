import type { PlayoffFieldProjection } from "@/lib/playoff-field";
import type { MatchLike } from "@/lib/standings";
import type { TiebreakerGroup } from "@/lib/tiebreakers";
import { parseSingleTiebreakerSlot, parseTiebreakerStage } from "@/lib/tiebreaker-format";

export type TiebreakerBracketTeam = {
  id: string;
  name: string;
  logoUrl?: string | null;
};

export type TiebreakerBracketFixture = MatchLike & {
  id: string;
  week: number;
  scheduledAt: Date | null;
};

export type TiebreakerBracketSide = {
  teamId: string | null;
  name: string;
  logoUrl: string | null;
  /** The feeder remains visible after its participant becomes known. */
  source: string | null;
};

export type TiebreakerBracketMatchView = {
  key: string;
  number: number;
  title: string;
  bestOf: 1 | 3;
  matchId: string | null;
  home: TiebreakerBracketSide;
  away: TiebreakerBracketSide;
  homeScore: number | null;
  awayScore: number | null;
  status: "waiting" | "scheduled" | "live" | "complete" | "conditional" | "not-needed";
  winnerTeamId: string | null;
  scheduledAt: Date | null;
  condition: string | null;
  bracket?: number;
  stage?: number;
};

export type TiebreakerPlacementView = {
  place: number;
  /** Overall eligible standing; may fall below the playoff cut. */
  seed: number;
  qualifies: boolean;
  teamId: string | null;
  name: string | null;
};

export type TiebreakerBracketView = {
  key: string;
  format: TiebreakerGroup["format"];
  round: number;
  bestOf: 1 | 3;
  teamIds: string[];
  status: TiebreakerGroup["status"];
  byeTeamId: string | null;
  week: number | null;
  openingAt: Date | null;
  matches: TiebreakerBracketMatchView[];
  placements: TiebreakerPlacementView[];
  singlePlan?: TiebreakerGroup["singlePlan"];
  qualifyingPlaces?: number;
};

/**
 * Present the whole tiebreaker without creating speculative database matches.
 * The authoritative projection validates fixtures and determines the format;
 * this layer only fills their future feeder slots and labels known outcomes.
 */
export function buildTiebreakerBrackets({
  projection,
  teams,
  matches,
}: {
  projection: PlayoffFieldProjection;
  teams: TiebreakerBracketTeam[];
  matches: TiebreakerBracketFixture[];
}): { error: string | null; groups: TiebreakerBracketView[] } {
  if (projection.tiebreakers.error) {
    return { error: projection.tiebreakers.error, groups: [] };
  }

  const names = new Map(teams.map((team) => [team.id, team]));
  const fixtures = new Map(matches
    .filter((match) => match.phase === "TIEBREAKER" && match.bracketSlot)
    .map((match) => [match.bracketSlot!, match]));
  const grouped = new Map<string, TiebreakerGroup[]>();
  for (const group of projection.tiebreakers.groups) {
    const single = parseSingleTiebreakerSlot(group.key);
    const parsed = parseTiebreakerStage(`${group.key}:0`);
    const key = single ? single.tournamentKey : group.format === "BO1_DOUBLE_ELIMINATION" && parsed
      ? parsed.bracketKey : group.key;
    grouped.set(key, [...(grouped.get(key) ?? []), group]);
  }

  function side(teamId: string | null | undefined, source: string | null = null): TiebreakerBracketSide {
    return {
      teamId: teamId ?? null,
      name: teamId ? names.get(teamId)?.name ?? "Unknown team" : source ?? "To be decided",
      logoUrl: teamId ? names.get(teamId)?.logoUrl ?? null : null,
      source,
    };
  }

  function decisiveWinner(match: TiebreakerBracketFixture | undefined): string | null {
    if (!match || match.status !== "COMPLETED") return null;
    const winner = match.homeScore > match.awayScore ? match.homeTeamId
      : match.awayScore > match.homeScore ? match.awayTeamId : null;
    return winner === match.winnerTeamId ? winner : null;
  }

  function decisiveLoser(match: TiebreakerBracketFixture | undefined): string | null {
    const winner = decisiveWinner(match);
    return !match || !winner ? null : winner === match.homeTeamId ? match.awayTeamId : match.homeTeamId;
  }

  function matchView(
    key: string,
    number: number,
    title: string,
    bestOf: 1 | 3,
    home: TiebreakerBracketSide,
    away: TiebreakerBracketSide,
  ): TiebreakerBracketMatchView {
    const actual = fixtures.get(key);
    return {
      key, number, title, bestOf,
      matchId: actual?.id ?? null,
      home: actual ? side(actual.homeTeamId, home.source) : home,
      away: actual ? side(actual.awayTeamId, away.source) : away,
      homeScore: actual && actual.status !== "SCHEDULED" ? actual.homeScore : null,
      awayScore: actual && actual.status !== "SCHEDULED" ? actual.awayScore : null,
      status: !actual ? "waiting" : actual.status === "COMPLETED" ? "complete"
        : actual.status === "LIVE" ? "live" : "scheduled",
      winnerTeamId: decisiveWinner(actual),
      // A future slot has no published time yet. The scheduling service can
      // shift it after a late result or an administrator's reschedule.
      scheduledAt: actual?.scheduledAt ?? null,
      condition: null,
    };
  }

  const groups = [...grouped].map(([key, stages]): TiebreakerBracketView => {
    const group = stages[0];
    const rows = projection.eligibleStandings.filter((row) => group.teamIds.includes(row.teamId));
    const placements: TiebreakerPlacementView[] = rows.map((row, index) => {
      const seed = projection.eligibleTeamIds.indexOf(row.teamId) + 1;
      const teamId = row.tiebreakerResolved && !row.idDecided ? row.teamId : null;
      return { place: index + 1, seed, qualifies: seed <= projection.bracketSize,
        teamId, name: teamId ? names.get(teamId)?.name ?? "Unknown team" : null };
    });
    let byeTeamId: string | null = null;
    let views: TiebreakerBracketMatchView[];

    if (group.format === "BO1_SINGLE_ELIMINATION") {
      const plan = group.singlePlan;
      const numbers = new Map(plan?.games.map((g, i) => [g.key, i + 1]));
      views = plan?.games.map((g, i) => {
        const source = (feeder: string | null) => feeder ? `Winner of Game ${numbers.get(feeder)}` : null;
        const next = plan.games.find((n) => n.home.feeder === g.key || n.away.feeder === g.key);
        const qualifies = plan.places < plan.draw.length && plan.brackets.length <= plan.places;
        return { ...matchView(g.key, i + 1, next ? `Bracket ${g.bracket + 1} · Round ${g.stage}` : `Bracket ${g.bracket + 1} · Decider`, 1,
          side(g.home.teamId, source(g.home.feeder)), side(g.away.teamId, source(g.away.feeder))),
          bracket: g.bracket, stage: g.stage,
          condition: next ? `Winner → Game ${numbers.get(next.key)} · Loser out of this bracket`
            : `${qualifies ? "Winner qualifies" : "Winner leads this bracket"} · Loser out of this bracket`,
        };
      }) ?? [];
    } else if (group.format === "BO1_DOUBLE_ELIMINATION") {
      const game = (number: number) => fixtures.get(`${key}:${number}:0`);
      const opening = game(1);
      byeTeamId = opening
        ? group.teamIds.find((id) => id !== opening.homeTeamId && id !== opening.awayTeamId) ?? null
        : stages.find((stage) => stage.byeTeamId)?.byeTeamId ?? null;
      const winner = (number: number) => side(decisiveWinner(game(number)), `Winner of Game ${number}`);
      const loser = (number: number) => side(decisiveLoser(game(number)), `Loser of Game ${number}`);
      views = [
        matchView(`${key}:1:0`, 1, "Opening game", 1,
          side(opening?.homeTeamId, opening ? null : "Opening draw: team 1"),
          side(opening?.awayTeamId, opening ? null : "Opening draw: team 2")),
        matchView(`${key}:2:0`, 2, "Upper final", 1, winner(1), side(byeTeamId, "Opening bye")),
        matchView(`${key}:3:0`, 3, "Elimination game", 1, loser(1), loser(2)),
        matchView(`${key}:4:0`, 4, "Final", 1, winner(2), winner(3)),
        matchView(`${key}:5:0`, 5, "Reset final", 1, winner(2), winner(3)),
      ];
      const fourthWinner = decisiveWinner(game(4));
      const upperWinner = decisiveWinner(game(2));
      const reset = views[4];
      reset.condition = "Only if the Game 3 winner wins Game 4.";
      if (fourthWinner && fourthWinner === upperWinner) reset.status = "not-needed";
      else if (!fourthWinner) reset.status = "conditional";

      // Third place is already definite after Game 3, even while the engine
      // correctly keeps the remaining playoff order unresolved until the final.
      const third = decisiveLoser(game(3));
      const final = reset.status === "not-needed" ? game(4) : game(5);
      const settledIds = [decisiveWinner(final), decisiveLoser(final), third];
      placements.forEach((placement, index) => {
        const id = settledIds[index];
        placement.teamId = id ?? null;
        placement.name = id ? names.get(id)?.name ?? "Unknown team" : null;
      });
    } else {
      views = group.pairings.map((pair, index) => matchView(
        `${key}:${index}`, index + 1,
        group.teamIds.length === 2 ? "Tiebreaker series" : `Series ${index + 1}`,
        3, side(pair.home), side(pair.away),
      ));
    }

    const actual = views.flatMap((view) => view.matchId ? [fixtures.get(view.key)!] : []);
    return {
      key, format: group.format, round: group.round, bestOf: group.bestOf,
      teamIds: [...group.teamIds],
      status: stages.some((stage) => stage.status === "pending") ? "pending"
        : stages.some((stage) => stage.status === "needed") ? "needed" : "resolved",
      byeTeamId,
      week: actual.length ? Math.min(...actual.map((match) => match.week)) : null,
      openingAt: actual[0]?.scheduledAt ?? null,
      matches: views,
      placements,
      ...(group.format === "BO1_SINGLE_ELIMINATION" ? { singlePlan: group.singlePlan, qualifyingPlaces: group.qualifyingPlaces } : {}),
    };
  });
  return { error: null, groups };
}
