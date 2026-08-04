import { playoffFirstRound, pickBracketSize, type Pairing } from "./schedule";
import {
  computeStandings,
  type MatchLike,
  type TeamStanding,
} from "./standings";

export type PlayoffFieldProjection = {
  /** The public table: every team and every completed regular-season result. */
  standings: TeamStanding[];
  /** The same ordered table with teams that cannot enter the bracket removed. */
  eligibleStandings: TeamStanding[];
  /** All eligible teams in standings order, including teams below the cut. */
  eligibleTeamIds: string[];
  /** Largest power-of-two field that fits, or zero when no bracket is possible. */
  bracketSize: number;
  /** The eligible teams above the cut, in seed order. */
  seededTeamIds: string[];
  /** One-indexed seed number for each team that made the bracket. */
  seedByTeam: Map<string, number>;
  /** Standard first-round matchups for the projected field. */
  pairings: Pairing[];
  /** Every team in an unresolved tie that can alter qualification or seeding. */
  seedingDeadHeatTeamIds: string[];
};

/**
 * Project the playoff field from the regular-season table.
 *
 * Standings must be computed before eligibility is applied. A withdrawn team's
 * own row cannot enter the bracket, but the results it played (and the forfeits
 * awarded to its remaining opponents) remain part of every survivor's record.
 */
export function projectPlayoffField(
  teams: { id: string; withdrawn?: boolean }[],
  matches: MatchLike[],
): PlayoffFieldProjection {
  const standings = computeStandings(
    teams.map((team) => team.id),
    matches,
  );
  const withdrawnIds = new Set(
    teams.filter((team) => team.withdrawn).map((team) => team.id),
  );
  const eligibleStandings = standings.filter(
    (row) => !withdrawnIds.has(row.teamId),
  );
  const eligibleTeamIds = eligibleStandings.map((row) => row.teamId);
  const bracketSize =
    eligibleTeamIds.length < 2 ? 0 : pickBracketSize(eligibleTeamIds.length);
  const seededTeamIds = eligibleTeamIds.slice(0, bracketSize);
  const seedByTeam = new Map(
    seededTeamIds.map((teamId, index) => [teamId, index + 1]),
  );
  const pairings =
    bracketSize === 0 ? [] : playoffFirstRound(seededTeamIds, bracketSize);
  const seeded = new Set(seededTeamIds);
  const groups = new Map<string, TeamStanding[]>();
  for (const row of eligibleStandings) {
    if (!row.idTieGroup) continue;
    groups.set(row.idTieGroup, [...(groups.get(row.idTieGroup) ?? []), row]);
  }
  const deadHeatIds = new Set<string>();
  for (const group of groups.values()) {
    // A tie against only an ineligible/withdrawn row cannot affect the order
    // of the remaining field. Preserve real multi-team eligible ties, but do
    // not warn that one surviving team is in a “dead heat” with itself.
    if (group.length < 2) continue;
    if (!group.some((row) => seeded.has(row.teamId))) continue;
    for (const row of group) deadHeatIds.add(row.teamId);
  }
  const seedingDeadHeatTeamIds = eligibleTeamIds.filter((teamId) =>
    deadHeatIds.has(teamId),
  );

  return {
    standings,
    eligibleStandings,
    eligibleTeamIds,
    bracketSize,
    seededTeamIds,
    seedByTeam,
    pairings,
    seedingDeadHeatTeamIds,
  };
}
