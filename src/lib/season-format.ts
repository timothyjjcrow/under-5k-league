// The league's shape for any number of teams. Admins choose a season's
// layout in the season builder (Tim's call, 2026-10-24); unless they do, the
// Recommended format follows the team count (the 2026-10-19 rule): one table
// up to nine teams, two groups from ten. Every season keeps the week after
// its regular season for tiebreakers. Pure + testable, and safe to import
// from client code.

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

/** The settings a season's format is built from. */
export type FormatKnobs = {
  /** 1 plays one table; more split the teams into groups A, B… */
  groups: number;
  /** How often teams meet in their table or group: once (1) or twice (2). */
  meet: number;
  /** Teams in the playoff bracket, a power of two. */
  playoffs: number;
};

/**
 * The settings the site recommends for `teamCount` teams, or null below two
 * teams (Tim's call, 2026-10-19):
 *
 *   2–3 teams: one table played twice, the top 2 play the final.
 *   4 teams:   one table played twice, all 4 play the semifinals.
 *   5–9:       one table, the top 4 play the semifinals.
 *   10+:       two groups, the top 4 of each play the quarterfinals.
 *
 * Every season without a stored format (`Season.formatConfig`) plays this
 * rule, archived ones included (a table of ten or
 * more generated before groups excepted, `resolveSeasonFormat`), so it never
 * changes: season-format-golden.test.ts pins what it makes. A new
 * recommendation is a new rule beside it.
 */
export function recommendedKnobs(teamCount: number): FormatKnobs | null {
  if (!Number.isInteger(teamCount) || teamCount < 2) return null;
  const groups = teamCount >= GROUP_STAGE_MIN_TEAMS;
  return {
    groups: groups ? SEASON_GROUP_KEYS.length : 1,
    meet: !groups && teamCount <= DOUBLE_ROUND_MAX_TEAMS ? 2 : 1,
    playoffs: groups ? GROUP_PLAYOFF_SPOTS : tablePlayoffSpots(teamCount),
  };
}

/**
 * The season `knobs` make for `teamCount` teams, or null below two teams:
 * groups split as evenly as possible, largest first, each a round robin on
 * the same match nights, and one week after the regular season kept for
 * tiebreakers, so the playoff dates are known the day the schedule is made.
 * It doesn't judge the knobs; the caller passes settings that fit.
 */
export function buildSeasonFormat(
  knobs: FormatKnobs,
  teamCount: number,
): SeasonFormat | null {
  if (!Number.isInteger(teamCount) || teamCount < 2) return null;
  const groupSizes = Array.from(
    { length: knobs.groups },
    (_, index) =>
      Math.floor(teamCount / knobs.groups) + (index < teamCount % knobs.groups ? 1 : 0),
  );
  const doubleRound = knobs.meet === 2;
  const regularWeeks = Math.max(
    ...groupSizes.map((size) => roundsFor(size, doubleRound)),
  );
  const matches = groupSizes.map((size) => (size - 1) * knobs.meet);
  const playoffRounds = Math.round(Math.log2(knobs.playoffs));
  return {
    teamCount,
    kind: groupSizes.length > 1 ? "GROUPS" : "TABLE",
    groupSizes,
    doubleRound,
    regularWeeks,
    matchesPerTeam: { min: Math.min(...matches), max: Math.max(...matches) },
    playoffSpots: knobs.playoffs,
    qualifiersPerGroup: knobs.playoffs / groupSizes.length,
    playoffRounds,
    tiebreakerWeek: regularWeeks + 1,
    firstPlayoffWeek: regularWeeks + 2,
    totalWeeks: regularWeeks + 1 + playoffRounds,
  };
}

/**
 * The Recommended season for `teamCount` teams (`recommendedKnobs`), or null
 * below two teams. Pages and actions read a season's format through
 * `plannedSeasonFormat` and `resolveSeasonFormat`, never this
 * (season-format-guards.test.ts).
 */
export function seasonFormat(teamCount: number): SeasonFormat | null {
  const knobs = recommendedKnobs(teamCount);
  return knobs ? buildSeasonFormat(knobs, teamCount) : null;
}

/** What a season stores about its format (`Season.formatConfig`). */
export type FormatSource = { formatConfig: string | null };

/** The fields every season select spreads, so no reader forgets the format. */
export const SEASON_FORMAT_SELECT = { formatConfig: true } as const;

const FORMAT_VERSION = 1;
const STORED_KNOBS = { groups: [1, 2], meet: [1, 2], playoffs: [2, 4, 8] } as const;

export type StoredFormat =
  | { kind: "RECOMMENDED" }
  | { kind: "CUSTOM"; knobs: FormatKnobs }
  | { kind: "UNREADABLE" };

/**
 * A season's stored format. Null is the Recommended format; anything else
 * must be this version's exact shape. A value this code can't read (a newer
 * version's, or junk written by hand) is UNREADABLE, never Recommended: read
 * as Recommended, a season whose group winners play the final would seed a
 * top 8 by its team count. Commands that build from the format refuse it.
 */
export function parseFormatConfig(raw: string | null): StoredFormat {
  if (raw === null) return { kind: "RECOMMENDED" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "UNREADABLE" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "UNREADABLE" };
  }
  const fields = value as Record<string, unknown>;
  const allowed = (key: keyof typeof STORED_KNOBS) =>
    (STORED_KNOBS[key] as readonly unknown[]).includes(fields[key]);
  if (
    Object.keys(fields).sort().join(",") !== "groups,meet,playoffs,v" ||
    fields.v !== FORMAT_VERSION ||
    !allowed("groups") ||
    !allowed("meet") ||
    !allowed("playoffs")
  ) {
    return { kind: "UNREADABLE" };
  }
  return {
    kind: "CUSTOM",
    knobs: {
      groups: fields.groups as number,
      meet: fields.meet as number,
      playoffs: fields.playoffs as number,
    },
  };
}

/** Every command that builds from an UNREADABLE format refuses with this. */
export const FORMAT_UNREADABLE_MESSAGE =
  "This season's format was saved by a newer version of the site, so this version can't build from it. Nothing was changed.";

/**
 * The stored value for `knobs`, or null for the Recommended format. One key
 * order, so two equal strings are the same format.
 */
export function serializeFormatConfig(knobs: FormatKnobs | null): string | null {
  if (!knobs) return null;
  return JSON.stringify({
    v: FORMAT_VERSION,
    groups: knobs.groups,
    meet: knobs.meet,
    playoffs: knobs.playoffs,
  });
}

/**
 * The format a schedule generated now would build for `teamCount` teams:
 * the season's stored format, or the Recommended one. Schedule generation
 * and the fixture seeder read it. An UNREADABLE format shows as Recommended;
 * generation refuses it first (`parseFormatConfig`).
 */
export function plannedSeasonFormat(
  season: FormatSource,
  teamCount: number,
): SeasonFormat | null {
  const stored = parseFormatConfig(season.formatConfig);
  return stored.kind === "CUSTOM"
    ? buildSeasonFormat(stored.knobs, teamCount)
    : seasonFormat(teamCount);
}

/**
 * The season's groups, or null when it plays one table: every team must
 * carry a group and there must be two or more, else the season renders (and
 * seeds) as one table. Schedule generation writes every team's group in one
 * transaction, so a half-grouped season is a leftover the admin regenerates.
 */
export function seasonGroupKeys(
  teams: readonly { groupKey: string | null }[],
): string[] | null {
  if (teams.length === 0 || teams.some((team) => !team.groupKey)) return null;
  const keys = [...new Set(teams.map((team) => team.groupKey!))].sort();
  return keys.length >= 2 ? keys : null;
}

/**
 * The format a season plays, which every page and post prints. Pass the
 * season, its whole field, withdrawn teams included, so a withdrawal never
 * changes it, and whether its regular-season fixtures exist. A stored format
 * is the season's (while fixtures exist it is what they were built from).
 * With none, it is the planned Recommended format until the fixtures exist;
 * once they do, a season whose teams carry no groups is one table, as its
 * standings and bracket are (`seasonGroupKeys`), whatever the count says: a
 * table of ten or more generated before groups existed keeps the bracket it
 * was built for.
 */
export function resolveSeasonFormat(
  season: FormatSource,
  teams: readonly { groupKey: string | null }[],
  regularFixturesExist: boolean,
): SeasonFormat | null {
  const planned = plannedSeasonFormat(season, teams.length);
  if (
    !planned ||
    parseFormatConfig(season.formatConfig).kind === "CUSTOM" ||
    !regularFixturesExist ||
    planned.kind === "TABLE" ||
    seasonGroupKeys(teams)
  ) {
    return planned;
  }
  return buildSeasonFormat(
    {
      groups: 1,
      meet: teams.length <= DOUBLE_ROUND_MAX_TEAMS ? 2 : 1,
      playoffs: tablePlayoffSpots(teams.length),
    },
    teams.length,
  );
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
 * The bracket `season` seeds: a stored format's playoff places, else the
 * Recommended ones (`playoffBracketSize`), shrunk to the largest power of
 * two its eligible teams can fill, or 0 below two.
 */
export function seasonBracketSize(
  season: FormatSource,
  kind: SeasonFormatKind,
  teamCount: number,
  eligibleCount: number,
): number {
  const stored = parseFormatConfig(season.formatConfig);
  if (stored.kind !== "CUSTOM") return playoffBracketSize(kind, teamCount, eligibleCount);
  if (eligibleCount < 2) return 0;
  return Math.min(stored.knobs.playoffs, pickBracketSize(eligibleCount));
}

/**
 * The bracket a resolved format seeds from `eligibleCount` teams: its
 * playoff places, shrunk the same way (`seasonBracketSize`).
 */
export function formatBracketSize(format: SeasonFormat, eligibleCount: number): number {
  if (eligibleCount < 2) return 0;
  return Math.min(format.playoffSpots, pickBracketSize(eligibleCount));
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

/**
 * "Two groups of 6", "Two groups of 6 and 5, each played twice", "One
 * table", "One table, played twice".
 */
export function formatName(format: SeasonFormat): string {
  if (format.kind === "GROUPS") {
    const sizes = format.groupSizes;
    const count = COUNT_WORDS[sizes.length] ?? String(sizes.length);
    const groups = sizes.every((size) => size === sizes[0])
      ? `${count} groups of ${sizes[0]}`
      : `${count} groups of ${sizes.join(" and ")}`;
    return format.doubleRound ? `${groups}, each played twice` : groups;
  }
  return format.doubleRound ? "One table, played twice" : "One table";
}

/** "The top 4 of each group", "The group winners", "The top 4", "All 4 teams". */
function playoffEntrants(format: SeasonFormat): string {
  if (format.kind === "GROUPS") {
    return format.qualifiersPerGroup === 1
      ? "The group winners"
      : `The top ${format.qualifiersPerGroup} of each group`;
  }
  return format.playoffSpots >= format.teamCount
    ? `All ${format.teamCount} teams`
    : `The top ${format.playoffSpots}`;
}

/**
 * Who makes the playoffs, to follow a colon or start a clause: "the top 4 of
 * each group", "the group winners", "the top 4", "all 4 teams".
 */
export function playoffEntrantsPhrase(format: SeasonFormat): string {
  const entrants = playoffEntrants(format);
  return `${entrants.charAt(0).toLowerCase()}${entrants.slice(1)}`;
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
      ? format.doubleRound
        ? `Each group plays everyone in it twice over ${weeks}`
        : `Each group plays a round robin over ${weeks}`
      : format.doubleRound
        ? `Everyone plays everyone twice over ${weeks}`
        : `Everyone plays everyone once over ${weeks}`;
  return `${formatName(format)}. ${play}, then ${playoffEntrantsPhrase(format)} play ${playoffRoundsPhrase(format)}.`;
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
 * It follows the season's stored format, if it has one.
 */
export function teamCountSeasonNote(
  season: FormatSource,
  teamCount: number,
  /** Whether a saved layout can be built for a neighbouring count; one it
   *  can't is left out rather than quoted with a length. */
  fits: (count: number) => boolean = () => true,
): string | null {
  const here = plannedSeasonFormat(season, teamCount);
  if (!here) return null;
  const others = [teamCount - 1, teamCount + 1].filter(fits).flatMap((count) => {
    const format = plannedSeasonFormat(season, count);
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
