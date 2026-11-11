// Rules for Home's This-week list and the hero's playoff-race line. Pure, so
// the components only draw what these decide.

import type { ScenarioReport, TeamScenario } from "./scenarios";
import { ordinalPlace } from "./tale-of-the-tape";

type SlateRow = {
  id: string;
  status: string;
  homeTeamId: string;
  awayTeamId: string;
  scheduledAt: Date | null;
};

/**
 * This week's series in reading order: the viewer's own first, then a series
 * being played, then the slate's own order. A player used to find their match
 * third of six, in a list ordered by nothing they could see.
 */
export function orderSlate<T extends SlateRow>(
  slate: readonly T[],
  viewerTeamId?: string | null,
): T[] {
  const rank = (m: T) =>
    viewerTeamId && (m.homeTeamId === viewerTeamId || m.awayTeamId === viewerTeamId)
      ? 0
      : m.status === "LIVE"
        ? 1
        : 2;
  // Array.prototype.sort is stable: ties keep the slate's order.
  return [...slate].sort((a, b) => rank(a) - rank(b));
}

/**
 * The one kickoff every series on the slate shares, which the card prints
 * once in its header instead of on every row. Null when a kickoff is unset or
 * any two differ (a rescheduled series), and for a slate of one, whose card
 * carries its own clock.
 */
export function sharedKickoff(
  slate: readonly Pick<SlateRow, "scheduledAt">[],
): Date | null {
  if (slate.length < 2) return null;
  const first = slate[0].scheduledAt;
  if (!first) return null;
  return slate.every((m) => m.scheduledAt?.getTime() === first.getTime())
    ? first
    : null;
}

/** Where a team's playoff race stands once every counted result agrees. */
export type PlayoffVerdict = "in" | "out" | "open";

/**
 * "in" and "out" only when nothing left can change it: the exact outlook
 * when the engine counted one, else its proven clinch status. A place that
 * goes to a tiebreaker is still "open".
 */
export function playoffVerdict(
  scenario: Pick<TeamScenario, "status" | "outlook">,
): PlayoffVerdict {
  const outlook = scenario.outlook;
  if (outlook) {
    if (outlook.qualified === outlook.total) return "in";
    if (outlook.eliminated === outlook.total) return "out";
    return "open";
  }
  if (scenario.status === "CLINCHED") return "in";
  if (scenario.status === "ELIMINATED") return "out";
  return "open";
}

export type PlayoffRace = {
  /** Teams sure of a playoff place. */
  in: number;
  /** Teams that can no longer reach one. */
  out: number;
  /** Teams whose place still depends on results. */
  open: number;
  /** Playoff places nobody has secured yet. */
  placesLeft: number;
};

/**
 * The league's playoff race in four numbers, for the hero's one line. Null
 * until a team is in or out: before that every team is "open", and the line
 * says how many places there are instead.
 */
export function playoffRace(
  report: Pick<ScenarioReport, "teams"> | null,
  places: number,
): PlayoffRace | null {
  if (!report || places <= 0) return null;
  const race = { in: 0, out: 0, open: 0 };
  for (const scenario of report.teams.values()) race[playoffVerdict(scenario)]++;
  if (race.in === 0 && race.out === 0) return null;
  return { ...race, placesLeft: Math.max(0, places - race.in) };
}

/** The race's parts in reading order, each with the colour its verdict wears. */
export function playoffRaceParts(
  race: PlayoffRace,
): { key: PlayoffVerdict; text: string }[] {
  const teams = (n: number) => `${n} ${n === 1 ? "team" : "teams"}`;
  const parts: { key: PlayoffVerdict; text: string }[] = [];
  if (race.in > 0) parts.push({ key: "in", text: `${teams(race.in)} in` });
  if (race.open > 0)
    parts.push({
      key: "open",
      text:
        race.placesLeft > 0
          ? `${race.open} chasing ${race.placesLeft} ${race.placesLeft === 1 ? "place" : "places"}`
          : // The points bounds can trail the table: say only what is known.
            `${teams(race.open)} still to be settled`,
    });
  if (race.out > 0) parts.push({ key: "out", text: `${race.out} out` });
  return parts;
}

type StandingRow = {
  teamId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  idTieGroup?: string;
};

/**
 * A team's place in its own table (its group's, in a group-stage season).
 * Rows the table could split only by team id share the best place among them
 * and are `tied`: the id is a sort key, never a result, so "4th" for one of
 * three identical records would be an order nobody earned.
 */
export function tablePlace(
  table: readonly StandingRow[],
  teamId: string,
): { place: number; tied: boolean; row: StandingRow } | null {
  const index = table.findIndex((row) => row.teamId === teamId);
  if (index < 0) return null;
  const row = table[index];
  if (!row.idTieGroup) return { place: index + 1, tied: false, row };
  const first = table.findIndex((other) => other.idTieGroup === row.idTieGroup);
  return { place: first + 1, tied: true, row };
}

/**
 * The viewer's standing in one line, in words rather than a W-D-L triple:
 * "4th in Group A · 1 win, 3 losses · 3 pts", "Tied 2nd of 8 · 2 wins, 1
 * draw · 7 pts". Before the team has played it says so, since "1st · 0 pts"
 * on day one is the table's sort order, not a standing.
 */
export function standingSummary({
  place,
  tied,
  row,
  groupKey,
  tableSize,
}: {
  place: number;
  tied: boolean;
  row: StandingRow;
  /** The team's group in a group-stage season, else null. */
  groupKey: string | null;
  tableSize: number;
}): string {
  const table = groupKey ? `Group ${groupKey}` : null;
  if (row.played === 0)
    return [table, "No series played yet"].filter(Boolean).join(" · ");
  const count = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  const record = [
    count(row.wins, "win", "wins"),
    row.draws > 0 ? count(row.draws, "draw", "draws") : null,
    count(row.losses, "loss", "losses"),
  ]
    .filter(Boolean)
    .join(", ");
  const where = `${tied ? "Tied " : ""}${ordinalPlace(place)} ${table ? `in ${table}` : `of ${tableSize}`}`;
  return `${where} · ${record} · ${count(row.points, "pt", "pts")}`;
}

/**
 * The playoff race as three lists for /schedule's Playoff race tab: in, in
 * the hunt, out. Each keeps the table's order, with the viewer's team first
 * in its own list. Twelve equal tiles in table order made a reader find the
 * settled teams by reading every one.
 */
export function playoffRaceGroups(
  order: readonly string[],
  report: Pick<ScenarioReport, "teams"> | null,
  viewerTeamId?: string | null,
): { key: PlayoffVerdict; teamIds: string[] }[] {
  const lists: Record<PlayoffVerdict, string[]> = { in: [], open: [], out: [] };
  for (const teamId of order) {
    const scenario = report?.teams.get(teamId);
    if (scenario) lists[playoffVerdict(scenario)].push(teamId);
  }
  return (["in", "open", "out"] as const)
    .map((key) => ({
      key,
      teamIds: [
        ...lists[key].filter((id) => id === viewerTeamId),
        ...lists[key].filter((id) => id !== viewerTeamId),
      ],
    }))
    .filter((group) => group.teamIds.length > 0);
}
