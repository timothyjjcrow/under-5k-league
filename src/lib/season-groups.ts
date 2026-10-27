// How a group-stage season shows itself: one table per group, a team's place
// within its group, and the bracket's seed names (A1, B4). Every surface that
// prints a place, a seed or the cut reads these, so a group season never shows
// group B's teams as 6th to 10th of one table. Pure + testable.

import type { PlayoffFieldProjection } from "./playoff-field";
import {
  computeStandings,
  standingsMovement,
  type MatchLike,
  type TeamStanding,
} from "./standings";
import { ordinalPlace } from "./tale-of-the-tape";

export type StandingsSection = {
  /** "A", "B", or null for a one-table season. */
  key: string | null;
  /** "Group A", or null for one table. */
  title: string | null;
  /** The table's rows, every team in it, tiebreaker results applied. */
  standings: TeamStanding[];
  /** Places this table sends to the playoffs (draws its cut line). */
  playoffCut: number;
  /**
   * Each qualifier's place among this table's qualifiers. For one table it is
   * the seed; in a group it counts the group's places, so the cut line falls
   * under the group's last qualifier.
   */
  playoffSeedByTeam: Map<string, number>;
  /** The bracket names ("A2") of a group's qualifiers; unset for one table. */
  seedLabelByTeam?: Map<string, string>;
  /** Teams in this table, withdrawn ones included. */
  totalTeams: number;
  /** Teams in this table that can still take a playoff place. */
  eligibleTeams: number;
  /** The table's accessible name. */
  label: string;
};

/** The tables a season shows: its groups in key order, else the one table. */
export function standingsSections(
  field: Pick<
    PlayoffFieldProjection,
    "groups" | "standings" | "bracketSize" | "seedByTeam" | "seedLabelByTeam" | "eligibleTeamIds"
  >,
): StandingsSection[] {
  if (!field.groups) {
    return [
      {
        key: null,
        title: null,
        standings: field.standings,
        playoffCut: field.bracketSize,
        playoffSeedByTeam: field.seedByTeam,
        totalTeams: field.standings.length,
        eligibleTeams: field.eligibleTeamIds.length,
        label: "League standings",
      },
    ];
  }
  return field.groups.map((group) => {
    const qualifiers = group.eligibleStandings
      .slice(0, group.qualifiers)
      .filter((row) => field.seedByTeam.has(row.teamId));
    return {
      key: group.key,
      title: `Group ${group.key}`,
      standings: group.standings,
      playoffCut: group.qualifiers,
      playoffSeedByTeam: new Map(qualifiers.map((row, index) => [row.teamId, index + 1])),
      seedLabelByTeam: new Map(
        qualifiers.map((row) => [row.teamId, field.seedLabelByTeam.get(row.teamId) ?? ""]),
      ),
      totalTeams: group.standings.length,
      eligibleTeams: group.eligibleStandings.length,
      label: `Group ${group.key} standings`,
    };
  });
}

/**
 * Places moved since the latest completed week, judged inside each table: in
 * a group season a team's movement is within its group (`standingsMovement`
 * per group, whose tables ignore results against the other group).
 */
export function tableMovement(
  sections: readonly Pick<StandingsSection, "standings">[],
  matches: (MatchLike & { week: number })[],
): Map<string, number> {
  return new Map(
    sections.flatMap((section) => [
      ...standingsMovement(
        section.standings.map((row) => row.teamId),
        matches,
      ),
    ]),
  );
}

/** "2nd in Group A", or "2nd" in a one-table season. */
export function placeLabel(place: { place: number; groupKey: string | null }): string {
  return place.groupKey
    ? `${ordinalPlace(place.place)} in Group ${place.groupKey}`
    : ordinalPlace(place.place);
}

/**
 * Name the seeds of a frozen bracket (`seedsFromFirstRound`): "A1", "B4" in a
 * group season, where seeds alternate between the groups place by place
 * (`seedGroups`), else the seed number. A team sent in a short group's place
 * keeps its own group's name: the first such team is that group's next place
 * after its share (B5), the next B6.
 */
export function bracketSeedLabels(
  seedByTeam: ReadonlyMap<string, number>,
  teams: readonly { id: string; groupKey?: string | null }[],
): Map<string, string> {
  const keys = [...new Set(teams.map((team) => team.groupKey))].sort();
  const grouped =
    teams.length > 0 && teams.every((team) => team.groupKey) && keys.length >= 2;
  if (!grouped) {
    return new Map([...seedByTeam].map(([teamId, seed]) => [teamId, String(seed)]));
  }
  const groupOf = new Map(teams.map((team) => [team.id, team.groupKey!]));
  const count = keys.length;
  const share = Math.floor(seedByTeam.size / count);
  const spare = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const [teamId, seed] of [...seedByTeam].sort((a, b) => a[1] - b[1])) {
    const key = groupOf.get(teamId);
    if (!key) {
      labels.set(teamId, String(seed));
      continue;
    }
    if (keys[(seed - 1) % count] === key) {
      labels.set(teamId, `${key}${Math.floor((seed - 1) / count) + 1}`);
      continue;
    }
    const extra = (spare.get(key) ?? 0) + 1;
    spare.set(key, extra);
    labels.set(teamId, `${key}${share + extra}`);
  }
  return labels;
}

/**
 * The playoff places a season offers, in one phrase: "8 playoff places: the
 * top 4 of each group", or "4 playoff places".
 */
export function playoffPlacesPhrase(
  field: Pick<PlayoffFieldProjection, "groups" | "bracketSize">,
): string {
  const places = `${field.bracketSize} playoff place${field.bracketSize === 1 ? "" : "s"}`;
  if (!field.groups) return places;
  const shares = [...new Set(field.groups.map((group) => group.qualifiers))];
  if (shares.length === 1) {
    return shares[0] === 1
      ? `${places}: the group winners`
      : `${places}: the top ${shares[0]} of each group`;
  }
  return `${places}: ${field.groups
    .map((group) =>
      group.qualifiers === 1
        ? `the winner of Group ${group.key}`
        : `the top ${group.qualifiers} of Group ${group.key}`,
    )
    .join(" and ")}`;
}

/**
 * Each group's table straight from the results (no tiebreaker results
 * applied), for a season view that shows final records rather than seeds:
 * null for a one-table season. The cut and seed fields are empty; pass the
 * sections to a <SeasonStandings> that asks for no cut.
 */
export function groupTablesFromResults(
  teams: readonly { id: string; groupKey: string | null }[],
  matches: MatchLike[],
): StandingsSection[] | null {
  const keys = [...new Set(teams.map((team) => team.groupKey))].sort();
  if (teams.length === 0 || teams.some((team) => !team.groupKey) || keys.length < 2) {
    return null;
  }
  return (keys as string[]).map((key) => {
    const ids = teams.filter((team) => team.groupKey === key).map((team) => team.id);
    const standings = computeStandings(ids, matches);
    return {
      key,
      title: `Group ${key}`,
      standings,
      playoffCut: 0,
      playoffSeedByTeam: new Map(),
      totalTeams: standings.length,
      eligibleTeams: standings.length,
      label: `Group ${key} standings`,
    };
  });
}

/** A team's place in its own table and that table's size. */
export type TablePlace = {
  /** 1-based place within the table. */
  place: number;
  /** Teams in the table, withdrawn ones included. */
  of: number;
  /** "A", "B", or null for a one-table season. */
  groupKey: string | null;
};

/**
 * Where a team sits and how big its table is: within its group in a
 * group-stage season (the group's rows, never the league's), else in the
 * league table. `tablePlaceOf` plus the table's size, read here without
 * importing the field's code. Null for a team the field doesn't know.
 */
export function placeInTable(
  field: Pick<PlayoffFieldProjection, "standings" | "groups">,
  teamId: string,
): TablePlace | null {
  const tables: { groupKey: string | null; rows: readonly TeamStanding[] }[] =
    field.groups
      ? field.groups.map((group) => ({ groupKey: group.key, rows: group.standings }))
      : [{ groupKey: null, rows: field.standings }];
  for (const { groupKey, rows } of tables) {
    const index = rows.findIndex((row) => row.teamId === teamId);
    if (index >= 0) return { place: index + 1, of: rows.length, groupKey };
  }
  return null;
}

/** "2nd of 6 in Group A", or "2nd of 10" in a one-table season. */
export function placeOfLabel(place: TablePlace): string {
  const text = `${ordinalPlace(place.place)} of ${place.of}`;
  return place.groupKey ? `${text} in Group ${place.groupKey}` : text;
}

/** "#2 of 6 in Group A", or "#2 of 10" in a one-table season. */
export function rankOfLabel(place: TablePlace): string {
  const text = `#${place.place} of ${place.of}`;
  return place.groupKey ? `${text} in Group ${place.groupKey}` : text;
}

/**
 * Every team in the order one list of the whole season reads them: the
 * table's order, or in a group season place by place across the groups (A1,
 * B1, A2, B2…), so group B's leader never sits below group A's last team.
 */
export function placeOrder(
  field: Pick<PlayoffFieldProjection, "standings" | "groups">,
): string[] {
  if (!field.groups) return field.standings.map((row) => row.teamId);
  return field.groups
    .flatMap((group) =>
      group.standings.map((row, index) => ({ teamId: row.teamId, index, key: group.key })),
    )
    .sort((a, b) => a.index - b.index || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((row) => row.teamId);
}
