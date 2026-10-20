// The league's shape for any number of teams. The site decides it from the
// team count when the schedule is generated, so no admin designs a season
// (Tim's call, 2026-10-19): one table up to nine teams, two groups from ten,
// and every season keeps the week after its regular season for tiebreakers.
// Pure + testable.

import {
  matchNightForWeek,
  pickBracketSize,
  roundName,
  roundRobin,
  type Pairing,
} from "./schedule";

/** From this many teams the regular season is two groups instead of one table. */
export const GROUP_STAGE_MIN_TEAMS = 10;
/** Group names in seed order: group A's places take the odd seeds (A1 is seed 1). */
export const SEASON_GROUP_KEYS = ["A", "B"] as const;
/** A one-table league this small plays its round robin twice. */
export const DOUBLE_ROUND_MAX_TEAMS = 4;
/** The bracket a one-table league of four to nine teams sends: semis, final. */
const TABLE_PLAYOFF_SPOTS = 4;
/** The bracket a two-group league sends: the top four of each group. */
const GROUP_PLAYOFF_SPOTS = 8;

export type SeasonFormatKind = "TABLE" | "GROUPS";

export type SeasonFormat = {
  teamCount: number;
  kind: SeasonFormatKind;
  /** Teams per group, largest first; a single entry for one table. */
  groupSizes: number[];
  /** The table plays everyone twice (four teams or fewer). */
  doubleRound: boolean;
  /** Regular-season weeks: the round count of the group that needs most. */
  regularWeeks: number;
  /** Regular-season matches per team, fewest and most (group sizes differ). */
  matchesPerTeam: { min: number; max: number };
  /** Teams in the playoff bracket: 2, 4 or 8. */
  playoffSpots: number;
  /** Playoff spots each group sends (the whole bracket for one table). */
  qualifiersPerGroup: number;
  playoffRounds: number;
  /** The week kept for tiebreakers, straight after the regular season. */
  tiebreakerWeek: number;
  /** The week the first playoff round is played. */
  firstPlayoffWeek: number;
  /** Every week of the season, the tiebreaker week and the playoffs included. */
  totalWeeks: number;
};

/** Rounds a round robin of `size` teams needs: an odd count adds a bye round. */
function roundsFor(size: number, doubleRound: boolean): number {
  if (size < 2) return 0;
  return (size % 2 === 0 ? size - 1 : size) * (doubleRound ? 2 : 1);
}

/**
 * Playoff spots for a one-table season of `teamCount` teams: a final between
 * the top two with three teams or fewer, else the top four. A table of ten or
 * more teams only exists in a season generated before groups, and it keeps
 * the bracket it was built for: the largest power of two that fits.
 */
function tablePlayoffSpots(teamCount: number): number {
  if (teamCount <= 3) return 2;
  return teamCount < GROUP_STAGE_MIN_TEAMS
    ? TABLE_PLAYOFF_SPOTS
    : pickBracketSize(teamCount);
}

/**
 * The season's shape for `teamCount` teams, or null below two teams.
 *
 *   2–3 teams: one table played twice, the top 2 play the final.
 *   4 teams:   one table played twice, all 4 play the semifinals.
 *   5–9:       one table, the top 4 play the semifinals.
 *   10+:       two groups split as evenly as possible, each a round robin on
 *              the same weeks; the top 4 of each group play the
 *              quarterfinals.
 *
 * One week after the regular season is kept for tiebreakers, so the playoff
 * dates are known the day the schedule is made.
 */
export function seasonFormat(teamCount: number): SeasonFormat | null {
  if (!Number.isInteger(teamCount) || teamCount < 2) return null;
  const groups = teamCount >= GROUP_STAGE_MIN_TEAMS;
  const groupSizes = groups
    ? [Math.ceil(teamCount / 2), Math.floor(teamCount / 2)]
    : [teamCount];
  const doubleRound = !groups && teamCount <= DOUBLE_ROUND_MAX_TEAMS;
  const regularWeeks = Math.max(
    ...groupSizes.map((size) => roundsFor(size, doubleRound)),
  );
  const matches = groupSizes.map((size) => (size - 1) * (doubleRound ? 2 : 1));
  const playoffSpots = groups ? GROUP_PLAYOFF_SPOTS : tablePlayoffSpots(teamCount);
  const playoffRounds = Math.round(Math.log2(playoffSpots));
  return {
    teamCount,
    kind: groups ? "GROUPS" : "TABLE",
    groupSizes,
    doubleRound,
    regularWeeks,
    matchesPerTeam: { min: Math.min(...matches), max: Math.max(...matches) },
    playoffSpots,
    qualifiersPerGroup: playoffSpots / groupSizes.length,
    playoffRounds,
    tiebreakerWeek: regularWeeks + 1,
    firstPlayoffWeek: regularWeeks + 2,
    totalWeeks: regularWeeks + 1 + playoffRounds,
  };
}

/**
 * The bracket a season seeds: its format's spots, shrunk to the largest power
 * of two its eligible (not withdrawn) teams can fill, or 0 when fewer than two
 * remain. `kind` is how the season was generated (teams carry a group), never
 * re-derived from the count, so a withdrawal can't turn groups into a table.
 */
export function playoffBracketSize(
  kind: SeasonFormatKind,
  teamCount: number,
  eligibleCount: number,
): number {
  if (eligibleCount < 2) return 0;
  const spots = kind === "GROUPS" ? GROUP_PLAYOFF_SPOTS : tablePlayoffSpots(teamCount);
  return Math.min(spots, pickBracketSize(eligibleCount));
}

/**
 * The week the playoffs' first round plays: the week after the reserved
 * tiebreaker week, or the week after the tiebreakers if they needed more than
 * their week. `lastTiebreakerWeek` is 0 when no tie needed one.
 */
export function firstPlayoffWeek(
  lastRegularWeek: number,
  lastTiebreakerWeek: number,
): number {
  return Math.max(lastRegularWeek + 2, lastTiebreakerWeek + 1);
}

/** One team for the group draw: its roster's average signup MMR, if known. */
export type GroupDrawTeam = { id: string; averageMmr: number | null };

/**
 * Average signup MMR of a roster, ignoring players with no MMR on file (0).
 * Null when nobody has one: that team sorts last in the draw.
 */
export function rosterAverageMmr(mmrs: readonly number[]): number | null {
  const known = mmrs.filter((mmr) => Number.isFinite(mmr) && mmr > 0);
  if (known.length === 0) return null;
  return known.reduce((sum, mmr) => sum + mmr, 0) / known.length;
}

/**
 * Split teams into the season's groups by snake order on roster strength:
 * strongest first, then A, B, B, A, A, B, B… so both groups get the same
 * spread. Ties (and unknown MMR, which sorts last) fall back to team id, so
 * the same rosters always make the same groups. Returns one id list per
 * group, in `SEASON_GROUP_KEYS` order, each strongest first.
 */
export function drawGroups(
  teams: readonly GroupDrawTeam[],
  groupCount: number = SEASON_GROUP_KEYS.length,
): string[][] {
  const ranked = [...teams].sort(
    (a, b) =>
      (b.averageMmr ?? Number.NEGATIVE_INFINITY) -
        (a.averageMmr ?? Number.NEGATIVE_INFINITY) || a.id.localeCompare(b.id),
  );
  const groups: string[][] = Array.from({ length: groupCount }, () => []);
  ranked.forEach((team, index) => {
    const lap = Math.floor(index / groupCount);
    const position = index % groupCount;
    groups[lap % 2 === 0 ? position : groupCount - 1 - position].push(team.id);
  });
  return groups;
}

export type RegularFixture = Pairing & { week: number };

/**
 * Every regular-season fixture with its week: one round robin per group (a
 * table is a single group), all on the same weeks. A group needing fewer
 * rounds than the longest (13 teams: 7 and 6) spreads its rounds so it still
 * starts in week 1 and finishes in the last week, with its spare weeks off.
 * Pass each group's team ids in the order that fixes home and away
 * (`roundRobin` balances it within the group).
 */
export function regularSeasonFixtures(
  groups: readonly (readonly string[])[],
  doubleRound: boolean,
): RegularFixture[] {
  const rounds = groups.map((teamIds) => roundRobin([...teamIds], doubleRound));
  const weeks = Math.max(0, ...rounds.map((r) => r.length));
  return rounds.flatMap((groupRounds) =>
    groupRounds.flatMap((round, index) => {
      const week =
        groupRounds.length < 2
          ? 1
          : 1 + Math.round((index * (weeks - 1)) / (groupRounds.length - 1));
      return round.map((pairing) => ({ ...pairing, week }));
    }),
  );
}

/** A group's table as the seeder reads it: eligible teams in standings order. */
export type SeedingGroup = { key: string; eligibleTeamIds: readonly string[] };

export type GroupSeeding = {
  /** How many teams each group sends, after a short group's spare spots move. */
  qualifiers: Map<string, number>;
  /**
   * Seeds in order, place by place across the groups: A1, B1, A2, B2… With
   * the standard bracket order (`playoffFirstRound`) that pairs A1–B4, B2–A3,
   * B1–A4 and A2–B3, so the two group winners can only meet in the final.
   */
  seededTeamIds: string[];
  /** Each seeded team's group and place in it: "A1", "B5". */
  labels: Map<string, string>;
};

/**
 * How many teams each group sends to a bracket of `bracketSize`: an equal
 * share each, except that a group left with too few eligible teams
 * (withdrawals) hands its spare spots to the next group with teams to spare.
 * Depends only on the counts, so a group's cut is known before its ties are
 * played off.
 */
export function groupShares(
  eligibleCounts: readonly number[],
  bracketSize: number,
): number[] {
  const share =
    eligibleCounts.length > 0 ? Math.floor(bracketSize / eligibleCounts.length) : 0;
  const own = eligibleCounts.map((count) => Math.min(share, count));
  let missing = own.reduce((sum, count) => sum + (share - count), 0);
  return eligibleCounts.map((count, i) => {
    const take = Math.min(count - own[i], missing);
    missing -= take;
    return own[i] + take;
  });
}

/**
 * Seed a bracket of `bracketSize` from the group tables (`groupShares`). A
 * team sent in a short group's place takes the missing team's slot in the
 * bracket.
 */
export function seedGroups(
  groups: readonly SeedingGroup[],
  bracketSize: number,
): GroupSeeding {
  const share = groups.length > 0 ? Math.floor(bracketSize / groups.length) : 0;
  const shares = groupShares(
    groups.map((g) => g.eligibleTeamIds.length),
    bracketSize,
  );
  const own = groups.map((g) => Math.min(share, g.eligibleTeamIds.length));
  const extra = shares.map((count, i) => count - own[i]);
  const qualifiers = new Map(groups.map((g, i) => [g.key, shares[i]]));
  const fillers = groups.flatMap((g, i) =>
    g.eligibleTeamIds.slice(own[i], own[i] + extra[i]).map((teamId, k) => ({
      teamId,
      label: `${g.key}${own[i] + k + 1}`,
    })),
  );
  const seededTeamIds: string[] = [];
  const labels = new Map<string, string>();
  for (let place = 0; place < share; place++) {
    groups.forEach((g, i) => {
      const seed =
        place < own[i]
          ? { teamId: g.eligibleTeamIds[place], label: `${g.key}${place + 1}` }
          : fillers.shift();
      if (!seed) return;
      seededTeamIds.push(seed.teamId);
      labels.set(seed.teamId, seed.label);
    });
  }
  return { qualifiers, seededTeamIds, labels };
}

export type SeasonPlanStep = {
  kind: "REGULAR" | "TIEBREAKER" | "PLAYOFF";
  /** "Regular season", "Group stage", "Tiebreakers", "Semifinals", "Grand final". */
  label: string;
  /** First and last week of the step (equal for a single week). */
  fromWeek: number;
  toWeek: number;
  /** Match nights of those weeks on the league's clock, when week 1 is set. */
  from: Date | null;
  to: Date | null;
};

/**
 * The season's calendar from the day its schedule is made: the regular
 * weeks, the tiebreaker week (played only if a tie needs it) and each playoff
 * round. `lastRegularWeek` is the schedule's real last week when fixtures
 * exist. Dates follow `firstMatchNight` on the league's clock, so moving the
 * season's match night with the cascade moves the whole plan.
 */
export function seasonPlan(
  format: SeasonFormat,
  firstMatchNight: Date | null,
  lastRegularWeek: number = format.regularWeeks,
  timeZone?: string | null,
): SeasonPlanStep[] {
  const night = (week: number) =>
    firstMatchNight
      ? timeZone === undefined
        ? matchNightForWeek(firstMatchNight, week)
        : matchNightForWeek(firstMatchNight, week, timeZone)
      : null;
  const step = (
    kind: SeasonPlanStep["kind"],
    label: string,
    fromWeek: number,
    toWeek: number,
  ): SeasonPlanStep => ({
    kind,
    label,
    fromWeek,
    toWeek,
    from: night(fromWeek),
    to: night(toWeek),
  });
  const tiebreakerWeek = lastRegularWeek + 1;
  return [
    step(
      "REGULAR",
      format.kind === "GROUPS" ? "Group stage" : "Regular season",
      1,
      lastRegularWeek,
    ),
    step("TIEBREAKER", "Tiebreakers", tiebreakerWeek, tiebreakerWeek),
    ...Array.from({ length: format.playoffRounds }, (_, round) =>
      step(
        "PLAYOFF",
        roundName(round, format.playoffRounds),
        tiebreakerWeek + 1 + round,
        tiebreakerWeek + 1 + round,
      ),
    ),
  ];
}

const COUNT_WORDS = ["No", "One", "Two", "Three", "Four"];

/** "Two groups of 6", "Two groups of 6 and 5", "One table", "One table, played twice". */
export function formatName(format: SeasonFormat): string {
  if (format.kind === "GROUPS") {
    const sizes = format.groupSizes;
    const count = COUNT_WORDS[sizes.length] ?? String(sizes.length);
    return sizes.every((size) => size === sizes[0])
      ? `${count} groups of ${sizes[0]}`
      : `${count} groups of ${sizes.join(" and ")}`;
  }
  return format.doubleRound ? "One table, played twice" : "One table";
}

/** "The top 4 of each group", "The top 4", "The top 2". */
function playoffEntrants(format: SeasonFormat): string {
  if (format.kind === "GROUPS") return `The top ${format.qualifiersPerGroup} of each group`;
  return format.playoffSpots >= format.teamCount
    ? `All ${format.teamCount} teams`
    : `The top ${format.playoffSpots}`;
}

/** The playoff rounds as a phrase: "the semifinals and the grand final". */
function playoffRoundsPhrase(format: SeasonFormat): string {
  const names = Array.from({ length: format.playoffRounds }, (_, round) =>
    roundName(round, format.playoffRounds).toLowerCase(),
  );
  if (names.length === 1) return `the ${names[0]}`;
  return `the ${names.slice(0, -1).join(", the ")} and the ${names[names.length - 1]}`;
}

/**
 * One plain sentence pair describing a format, for the admin card, /rules and
 * Discord: "Two groups of 6. Each group plays a round robin over 5 weeks, then
 * the top 4 of each group play the quarterfinals, the semifinals and the grand
 * final."
 */
export function describeSeasonFormat(format: SeasonFormat): string {
  const weeks = `${format.regularWeeks} week${format.regularWeeks === 1 ? "" : "s"}`;
  const play =
    format.kind === "GROUPS"
      ? `Each group plays a round robin over ${weeks}`
      : format.doubleRound
        ? `Everyone plays everyone twice over ${weeks}`
        : `Everyone plays everyone once over ${weeks}`;
  const entrants = playoffEntrants(format);
  return `${formatName(format)}. ${play}, then ${entrants.charAt(0).toLowerCase()}${entrants.slice(1)} play ${playoffRoundsPhrase(format)}.`;
}

/** "9 weeks in all: 5 group weeks, the tiebreaker week and 3 playoff weeks". */
export function seasonLengthPhrase(format: SeasonFormat): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(format.totalWeeks, "week")} in all: ${plural(
    format.regularWeeks,
    format.kind === "GROUPS" ? "group week" : "regular week",
  )}, the tiebreaker week and ${plural(format.playoffRounds, "playoff week")}`;
}

/**
 * What an admin reads while picking captains: the season this many teams
 * make, and how long one fewer or one more would make it, so a count that
 * stretches the season (9 teams, 13 teams) is a choice and not a surprise.
 */
export function teamCountSeasonNote(teamCount: number): string | null {
  const here = seasonFormat(teamCount);
  if (!here) return null;
  const others = [teamCount - 1, teamCount + 1].flatMap((count) => {
    const format = seasonFormat(count);
    return format ? [`${count} teams: ${format.totalWeeks} weeks`] : [];
  });
  return `${teamCount} teams: ${formatName(here).toLowerCase()}, ${seasonLengthPhrase(here)}.${
    others.length > 0 ? ` ${others.join(" · ")}.` : ""
  }`;
}

/** What a format plays, without the week count: for `formatSteps`. */
function formatStepPhrase(format: SeasonFormat): string {
  const play =
    format.kind === "GROUPS"
      ? "play two groups, each a round robin on the same match nights"
      : format.doubleRound
        ? "play one table twice"
        : "play one table once";
  const entrants = playoffEntrants(format);
  const who =
    format.kind === "GROUPS"
      ? `the top ${format.qualifiersPerGroup} of each group`
      : entrants.startsWith("All")
        ? format.teamCount === 2
          ? "both"
          : "all of them"
        : `the top ${format.playoffSpots}`;
  return `${play}, and ${who} play ${playoffRoundsPhrase(format)}`;
}

/**
 * Every format the site picks, by team count, in one sentence for /rules:
 * "2–3 teams play one table twice, and the top 2 play the grand final; …;
 * 10 or more teams play two groups…". Read from `seasonFormat`, so a new
 * rule rewrites this line too.
 */
export function formatSteps(maxTeams = 32): string {
  const steps: { phrase: string; from: number; to: number }[] = [];
  for (let count = 2; count <= maxTeams; count++) {
    const phrase = formatStepPhrase(seasonFormat(count)!);
    const last = steps[steps.length - 1];
    if (last && last.phrase === phrase) last.to = count;
    else steps.push({ phrase, from: count, to: count });
  }
  return steps
    .map((step, index) => {
      const range =
        index === steps.length - 1 && step.to === maxTeams
          ? `${step.from} or more teams`
          : step.from === step.to
            ? `${step.from} teams`
            : `${step.from}–${step.to} teams`;
      return `${range} ${step.phrase}`;
    })
    .join("; ");
}

/**
 * Who makes the playoffs at every team count, in one phrase for /rules: "the
 * top 2 of a table of 2–3 teams, the top 4 of a table of 4–9 teams and the top
 * 4 of each group from 10 teams". Read from `seasonFormat`.
 */
export function playoffSteps(maxTeams = 32): string {
  const steps: { phrase: string; from: number; to: number; groups: boolean }[] = [];
  for (let count = 2; count <= maxTeams; count++) {
    const format = seasonFormat(count)!;
    const groups = format.kind === "GROUPS";
    const phrase = groups
      ? `the top ${format.qualifiersPerGroup} of each group`
      : `the top ${format.playoffSpots}`;
    const last = steps[steps.length - 1];
    if (last && last.phrase === phrase) last.to = count;
    else steps.push({ phrase, from: count, to: count, groups });
  }
  const parts = steps.map((step, index) =>
    step.groups
      ? `${step.phrase} from ${step.from} teams`
      : `${step.phrase} of a table of ${step.from === step.to ? step.from : `${step.from}–${step.to}`} teams${
          index === steps.length - 1 && step.to === maxTeams ? " or more" : ""
        }`,
  );
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : parts[0];
}
