import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import { playoffFirstRound, type Pairing } from "./schedule";
import {
  groupShares,
  playoffBracketSize,
  seedGroups,
  type SeasonFormatKind,
} from "./season-format";
import {
  computeStandings,
  type MatchLike,
  type TeamStanding,
} from "./standings";
import { resolveTiebreakers, tiebreakerBasis, type TiebreakerState } from "./tiebreakers";

/**
 * A team as the field reads it. `groupKey` is required (null for a one-table
 * season) so every caller selects it: a page that left it out would show a
 * group season as one table, seeded wrong, without an error anywhere.
 */
export type FieldTeam = {
  id: string;
  withdrawn?: boolean;
  groupKey: string | null;
};

/** One group of a group-stage season: its own table, cut and tiebreakers. */
export type PlayoffGroupProjection = {
  /** "A", "B". */
  key: string;
  /** The group's table: every team in it, tiebreaker results applied. */
  standings: TeamStanding[];
  /** The same table without teams that cannot enter the bracket. */
  eligibleStandings: TeamStanding[];
  /** How many teams the group sends: its share, more when the other group is short. */
  qualifiers: number;
  tiebreakers: TiebreakerState;
};

export type PlayoffFieldProjection = {
  /** "GROUPS" when every team carries a group, else one table. */
  kind: SeasonFormatKind;
  /**
   * The public table: every team and every completed regular-season result.
   * In a group season it is group A's table followed by group B's, so a row's
   * index is NOT its place: read `groups` (or `tablePlaceOf`) for places.
   */
  standings: TeamStanding[];
  /** The same ordered rows with teams that cannot enter the bracket removed. */
  eligibleStandings: TeamStanding[];
  /** All eligible teams in table order, including teams below the cut. */
  eligibleTeamIds: string[];
  /** Each group's table, in key order; null for a one-table season. */
  groups: PlayoffGroupProjection[] | null;
  /** The bracket's size: the format's spots shrunk to what eligible teams fill, or zero. */
  bracketSize: number;
  /** The teams in the bracket, in seed order (A1, B1, A2, B2… for groups). */
  seededTeamIds: string[];
  /** One-indexed seed number for each team that made the bracket. */
  seedByTeam: Map<string, number>;
  /** How each seeded team is named in the bracket: "A1", "B4", or "3". */
  seedLabelByTeam: Map<string, string>;
  /** Standard first-round matchups for the projected field. */
  pairings: Pairing[];
  /** Every team in an unresolved tie that can alter qualification or seeding. */
  seedingDeadHeatTeamIds: string[];
  tiebreakers: TiebreakerState;
};

/**
 * The season's groups, or null when it plays one table: every team must
 * carry a group and there must be two or more, else the season renders (and
 * seeds) as one table. Schedule generation writes every team's group in one
 * transaction, so a half-grouped season is a leftover the admin regenerates.
 */
function groupKeysOf(teams: readonly FieldTeam[]): string[] | null {
  if (teams.length === 0 || teams.some((team) => !team.groupKey)) return null;
  const keys = [...new Set(teams.map((team) => team.groupKey!))].sort();
  return keys.length >= 2 ? keys : null;
}

/** Ties among eligible rows that touch a seeded place: they must be played off. */
function deadHeatTeamIds(
  eligibleStandings: TeamStanding[],
  seeded: ReadonlySet<string>,
): string[] {
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
  return eligibleStandings
    .map((row) => row.teamId)
    .filter((teamId) => deadHeatIds.has(teamId));
}

/** Put the resolved eligible order back around the withdrawn rows' places. */
function withResolvedOrder(
  standings: TeamStanding[],
  resolved: TeamStanding[],
  withdrawnIds: ReadonlySet<string>,
): TeamStanding[] {
  let index = 0;
  return standings.map((row) => (withdrawnIds.has(row.teamId) ? row : resolved[index++]));
}

/**
 * Project the playoff field from the regular-season table, or from each
 * group's table in a group-stage season.
 *
 * Standings must be computed before eligibility is applied. A withdrawn team's
 * own row cannot enter the bracket, but the results it played (and the forfeits
 * awarded to its remaining opponents) remain part of every survivor's record.
 *
 * In groups, each group is its own league: its table counts only its own
 * results, its ties are played off against its own cut, and its tiebreaker
 * fixtures are bound to its own results. The seeds then interleave the groups
 * place by place (`seedGroups`).
 */
export function projectPlayoffField(
  teams: readonly FieldTeam[],
  matches: MatchLike[],
  format: "current" | "legacy" = "current",
): PlayoffFieldProjection {
  const withdrawnIds = new Set(
    teams.filter((team) => team.withdrawn).map((team) => team.id),
  );
  const groupKeys = groupKeysOf(teams);
  if (groupKeys) return projectGroups(teams, groupKeys, matches, withdrawnIds, format);

  let standings = computeStandings(
    teams.map((team) => team.id),
    matches,
  );
  let eligibleStandings = standings.filter(
    (row) => !withdrawnIds.has(row.teamId),
  );
  const bracketSize = playoffBracketSize(
    "TABLE",
    teams.length,
    eligibleStandings.length,
  );
  const resolution = resolveTiebreakers(
    eligibleStandings, matches, bracketSize, tiebreakerBasis([...teams], matches), format,
  );
  eligibleStandings = resolution.standings;
  standings = withResolvedOrder(standings, eligibleStandings, withdrawnIds);
  const eligibleTeamIds = eligibleStandings.map((row) => row.teamId);
  const seededTeamIds = eligibleTeamIds.slice(0, bracketSize);
  const seeded = new Set(seededTeamIds);

  return {
    kind: "TABLE",
    standings,
    eligibleStandings,
    eligibleTeamIds,
    groups: null,
    bracketSize,
    seededTeamIds,
    seedByTeam: new Map(seededTeamIds.map((teamId, index) => [teamId, index + 1])),
    seedLabelByTeam: new Map(
      seededTeamIds.map((teamId, index) => [teamId, String(index + 1)]),
    ),
    pairings:
      bracketSize === 0 ? [] : playoffFirstRound(seededTeamIds, bracketSize),
    seedingDeadHeatTeamIds: deadHeatTeamIds(eligibleStandings, seeded),
    tiebreakers: resolution.state,
  };
}

function projectGroups(
  teams: readonly FieldTeam[],
  groupKeys: string[],
  matches: MatchLike[],
  withdrawnIds: ReadonlySet<string>,
  format: "current" | "legacy",
): PlayoffFieldProjection {
  const tables = groupKeys.map((key) => {
    const members = teams.filter((team) => team.groupKey === key);
    const ids = new Set(members.map((team) => team.id));
    // Only the group's own fixtures: its results, and its tiebreakers (the
    // resolver fails closed on a tiebreaker fixture it doesn't recognise).
    const own = matches.filter(
      (m) => ids.has(m.homeTeamId) && ids.has(m.awayTeamId),
    );
    const standings = computeStandings(
      members.map((team) => team.id),
      own,
    );
    return {
      key,
      members,
      own,
      standings,
      eligible: standings.filter((row) => !withdrawnIds.has(row.teamId)),
    };
  });
  const eligibleCount = tables.reduce((sum, t) => sum + t.eligible.length, 0);
  const bracketSize = playoffBracketSize("GROUPS", teams.length, eligibleCount);
  const shares = groupShares(
    tables.map((t) => t.eligible.length),
    bracketSize,
  );

  const groups: PlayoffGroupProjection[] = tables.map((table, index) => {
    const resolution = resolveTiebreakers(
      table.eligible,
      table.own,
      shares[index],
      tiebreakerBasis(table.members, table.own),
      format,
    );
    return {
      key: table.key,
      standings: withResolvedOrder(table.standings, resolution.standings, withdrawnIds),
      eligibleStandings: resolution.standings,
      qualifiers: shares[index],
      tiebreakers: resolution.state,
    };
  });

  const seeding = seedGroups(
    groups.map((group) => ({
      key: group.key,
      eligibleTeamIds: group.eligibleStandings.map((row) => row.teamId),
    })),
    bracketSize,
  );
  const seeded = new Set(seeding.seededTeamIds);
  const eligibleStandings = groups.flatMap((group) => group.eligibleStandings);

  // A tiebreaker fixture between two groups belongs to no group's draw: fail
  // closed exactly like a stale draw inside one group.
  const groupOf = new Map(teams.map((team) => [team.id, team.groupKey]));
  const stray = matches.some(
    (m) =>
      m.phase === MATCH_PHASE.TIEBREAKER &&
      groupOf.get(m.homeTeamId) !== groupOf.get(m.awayTeamId),
  );
  const states = groups.map((group) => group.tiebreakers);
  const error =
    states.find((state) => state.error)?.error ??
    (stray
      ? "The tiebreaker week belongs to an earlier standings or result snapshot. Reset the tiebreaker week before continuing."
      : null);
  const tiebreakers: TiebreakerState = {
    groups: states.flatMap((state) => state.groups),
    pending: states.some((state) => state.pending),
    needsMatches: states.some((state) => state.needsMatches),
    resolved: !error && states.every((state) => state.resolved),
    error,
  };

  return {
    kind: "GROUPS",
    standings: groups.flatMap((group) => group.standings),
    eligibleStandings,
    eligibleTeamIds: eligibleStandings.map((row) => row.teamId),
    groups,
    bracketSize,
    seededTeamIds: seeding.seededTeamIds,
    seedByTeam: new Map(
      seeding.seededTeamIds.map((teamId, index) => [teamId, index + 1]),
    ),
    seedLabelByTeam: seeding.labels,
    pairings:
      bracketSize === 0 ? [] : playoffFirstRound(seeding.seededTeamIds, bracketSize),
    seedingDeadHeatTeamIds: groups.flatMap((group) =>
      deadHeatTeamIds(group.eligibleStandings, seeded),
    ),
    tiebreakers,
  };
}

/**
 * A team's place in its table: 1-based within its group in a group-stage
 * season (with the group's key), else in the league table. Null for a team
 * the field doesn't know.
 */
export function tablePlaceOf(
  field: Pick<PlayoffFieldProjection, "standings" | "groups">,
  teamId: string,
): { place: number; groupKey: string | null } | null {
  if (field.groups) {
    for (const group of field.groups) {
      const index = group.standings.findIndex((row) => row.teamId === teamId);
      if (index >= 0) return { place: index + 1, groupKey: group.key };
    }
    return null;
  }
  const index = field.standings.findIndex((row) => row.teamId === teamId);
  return index >= 0 ? { place: index + 1, groupKey: null } : null;
}

/**
 * Whether a dead heat in the table is a real playoff tiebreaker yet: every
 * regular-season fixture is final, or tiebreaker fixtures already exist.
 * Before that, two teams level today can still be split by the games left to
 * play, so public pages show only the quiet "Tied" chip and keep projecting
 * seeds and matchups in the displayed order.
 */
export function tiebreakersInPlay(
  matches: Pick<MatchLike, "phase" | "status">[],
): boolean {
  const regular = matches.filter((m) => m.phase === MATCH_PHASE.REGULAR);
  const regularComplete =
    regular.length > 0 &&
    regular.every((m) => m.status === MATCH_STATUS.COMPLETED);
  return (
    regularComplete || matches.some((m) => m.phase === MATCH_PHASE.TIEBREAKER)
  );
}

/**
 * The dead-heat teams the public standings and playoff picture may badge as
 * waiting on a tiebreaker. Presentation only: admin tiebreaker scheduling and
 * createPlayoffBracket read `seedingDeadHeatTeamIds` directly, and they only
 * act once the regular season is over.
 */
export function publicDeadHeatTeamIds(
  projection: Pick<PlayoffFieldProjection, "seedingDeadHeatTeamIds">,
  matches: Pick<MatchLike, "phase" | "status">[],
): string[] {
  return tiebreakersInPlay(matches) ? projection.seedingDeadHeatTeamIds : [];
}
