// The season builder's rules: what an admin may choose for a season's
// format, what each choice makes for a team count, and what the card says
// about it. The card previews in the browser and the actions judge with the
// same functions, so the preview can't promise a season the schedule won't
// build. Pure + testable, and safe to import from client code.

import { SEASON_STATUS } from "./constants";
import { draftSetupOpen } from "./draft-setup";
import {
  buildSeasonFormat,
  drawGroups,
  formatBracketSize,
  recommendedKnobs,
  regularSeasonFixtures,
  seasonPlan,
  type FormatKnobs,
  type SeasonFormat,
  type SeasonPlanStep,
} from "./season-format";

/** The choices the card offers, in the order it shows them. */
export const FORMAT_CHOICES = {
  groups: [1, 2],
  meet: [1, 2],
  playoffs: [2, 4, 8],
} as const;

/** Playing twice is offered while the largest group has this many or fewer. */
export const TWICE_MAX_GROUP_SIZE = 6;
/** A season longer than this many weeks names a shorter layout. */
const LONG_SEASON_WEEKS = 12;
/** Fewer regular matches than this, and the season says so. */
const FEW_MATCHES = 4;

export type FormatProblems = {
  /** Why the layout can't be built for this many teams. */
  errors: string[];
  /** What the admin should know before building it. */
  warnings: string[];
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The layout in a few words: "Two groups, top 2 of each", "One table, played twice, top 4". */
export function knobsLabel(knobs: FormatKnobs): string {
  const layout = knobs.groups > 1 ? "Two groups" : "One table";
  const twice = knobs.meet === 2 ? (knobs.groups > 1 ? ", each played twice" : ", played twice") : "";
  const perGroup = knobs.playoffs / knobs.groups;
  const playoffs =
    knobs.groups > 1
      ? perGroup === 1
        ? "winner of each"
        : `top ${perGroup} of each`
      : knobs.playoffs === 2
        ? "top 2 (a final)"
        : `top ${knobs.playoffs}`;
  return `${layout}${twice}, ${playoffs}`;
}

/** Regular-season fixtures a format makes: each pair in a group meets `meet` times. */
export function regularFixtureCount(format: SeasonFormat): number {
  return format.groupSizes.reduce(
    (sum, size) => sum + ((size * (size - 1)) / 2) * (format.doubleRound ? 2 : 1),
    0,
  );
}

/**
 * Every layout the card offers that can be built for `teamCount` teams,
 * shortest season first (more matches first among equals), each with the
 * season it makes. The Recommended layout is among them.
 */
export function formatAlternatives(
  teamCount: number,
): { knobs: FormatKnobs; format: SeasonFormat; recommended: boolean }[] {
  const recommended = recommendedKnobs(teamCount);
  const options: { knobs: FormatKnobs; format: SeasonFormat; recommended: boolean }[] = [];
  for (const groups of FORMAT_CHOICES.groups) {
    for (const meet of FORMAT_CHOICES.meet) {
      for (const playoffs of FORMAT_CHOICES.playoffs) {
        const knobs = { groups, meet, playoffs };
        const format = buildSeasonFormat(knobs, teamCount);
        if (!format || formatErrors(knobs, teamCount).length > 0) continue;
        options.push({ knobs, format, recommended: sameKnobs(knobs, recommended) });
      }
    }
  }
  return options.sort(
    (a, b) =>
      a.format.totalWeeks - b.format.totalWeeks ||
      b.format.matchesPerTeam.max - a.format.matchesPerTeam.max ||
      Number(b.recommended) - Number(a.recommended),
  );
}

export type FormatChoice =
  | { kind: "RECOMMENDED" }
  | { kind: "CUSTOM"; knobs: FormatKnobs };

/**
 * The layout a form posted: Recommended, or a custom one whose settings are
 * all among `FORMAT_CHOICES`. Anything else is null, refused and never
 * clamped, so a tampered or stale form can't store a format the card
 * doesn't offer.
 */
export function parseFormatChoice(fields: {
  formatChoice: string;
  groups: string;
  meet: string;
  playoffs: string;
}): FormatChoice | null {
  if (fields.formatChoice === "RECOMMENDED") return { kind: "RECOMMENDED" };
  if (fields.formatChoice !== "CUSTOM") return null;
  const pick = (value: string, allowed: readonly number[]) => {
    const n = Number(value);
    return allowed.includes(n) ? n : null;
  };
  const groups = pick(fields.groups, FORMAT_CHOICES.groups);
  const meet = pick(fields.meet, FORMAT_CHOICES.meet);
  const playoffs = pick(fields.playoffs, FORMAT_CHOICES.playoffs);
  if (groups === null || meet === null || playoffs === null) return null;
  return { kind: "CUSTOM", knobs: { groups, meet, playoffs } };
}

/** What a form posts for the format it was rendered with. */
export function formatToken(formatConfig: string | null): string {
  return formatConfig ?? "RECOMMENDED";
}

/** Two layouts are the same choice. */
export function sameKnobs(a: FormatKnobs | null, b: FormatKnobs | null): boolean {
  if (!a || !b) return a === b;
  return a.groups === b.groups && a.meet === b.meet && a.playoffs === b.playoffs;
}

function formatErrors(knobs: FormatKnobs, teamCount: number): string[] {
  const errors: string[] = [];
  if (teamCount < 2) return ["A season needs at least 2 teams."];
  if (knobs.groups > 1 && teamCount < knobs.groups * 3) {
    errors.push(
      `Two groups need at least ${knobs.groups * 3} teams, 3 in each; there are ${teamCount}.`,
    );
  }
  if (knobs.playoffs > teamCount) {
    errors.push(
      `The top ${knobs.playoffs} needs at least ${knobs.playoffs} teams; there are ${teamCount}.`,
    );
  }
  const format = buildSeasonFormat(knobs, teamCount);
  if (format && knobs.meet === 2 && format.groupSizes[0] > TWICE_MAX_GROUP_SIZE) {
    errors.push(
      knobs.groups > 1
        ? `Playing twice needs groups of ${TWICE_MAX_GROUP_SIZE} teams or fewer; the largest has ${format.groupSizes[0]}, which would take ${format.regularWeeks} weeks of group games.`
        : `Playing twice needs a table of ${TWICE_MAX_GROUP_SIZE} teams or fewer; this one has ${teamCount}, which would take ${format.regularWeeks} weeks of regular-season games.`,
    );
  }
  return errors;
}

/**
 * What stops `knobs` being built for `teamCount` teams (errors), and what the
 * admin should know about the season it makes (warnings). Generate refuses a
 * layout with errors; the card shows both.
 */
export function formatProblems(knobs: FormatKnobs, teamCount: number): FormatProblems {
  const errors = formatErrors(knobs, teamCount);
  const format = buildSeasonFormat(knobs, teamCount);
  if (errors.length > 0 || !format) return { errors, warnings: [] };
  const warnings: string[] = [];
  const perGroup = knobs.playoffs / knobs.groups;
  const smallest = format.groupSizes[format.groupSizes.length - 1];
  if (knobs.playoffs >= teamCount) {
    warnings.push("Every team makes the playoffs, so the regular season only decides the seeds.");
  } else if (knobs.groups > 1 && perGroup >= smallest) {
    warnings.push(`The group of ${smallest} sends all ${smallest} of its teams.`);
  }
  if (format.totalWeeks > LONG_SEASON_WEEKS) {
    const shortest = formatAlternatives(teamCount)[0];
    if (shortest && shortest.format.totalWeeks < format.totalWeeks) {
      warnings.push(
        `${plural(format.totalWeeks, "week")} in all; ${knobsLabel(shortest.knobs).toLowerCase()} takes ${shortest.format.totalWeeks}.`,
      );
    }
  }
  const fewest = format.matchesPerTeam.min;
  if (fewest < FEW_MATCHES) {
    warnings.push(`Some teams play only ${fewest} regular match${fewest === 1 ? "" : "es"}.`);
  }
  // The field shrinks its bracket to fit the teams still in (playoff-field).
  const afterOneWithdrawal = formatBracketSize(format, teamCount - 1);
  if (afterOneWithdrawal < knobs.playoffs) {
    warnings.push(`One withdrawal would cut this bracket to ${afterOneWithdrawal}.`);
  }
  return { errors, warnings };
}

export type FormatPreview = {
  format: SeasonFormat;
  problems: FormatProblems;
  /** Regular-season fixtures the schedule will hold. */
  fixtures: number;
  /** The calendar: the regular weeks, the tiebreaker week, each playoff round. */
  plan: SeasonPlanStep[];
  /** Each group's size, the weeks it has no fixture, and each team's byes. */
  groups: { size: number; offWeeks: number[]; byesPerTeam: number }[];
};

/**
 * The season `knobs` make for `teamCount` teams, as generation would build
 * it: groups split by the generator's own draw, fixtures from the same
 * round robin, the plan from week 1's night when it is known. Null below two
 * teams.
 */
export function previewSeasonFormat(
  knobs: FormatKnobs,
  teamCount: number,
  firstMatchNight: Date | null,
  timeZone?: string | null,
): FormatPreview | null {
  const format = buildSeasonFormat(knobs, teamCount);
  if (!format) return null;
  const ids = Array.from({ length: teamCount }, (_, i) => `t${i}`);
  const groups =
    format.kind === "GROUPS"
      ? drawGroups(
          ids.map((id, rank) => ({ id, averageMmr: teamCount - rank })),
          format.groupSizes.length,
        )
      : [ids];
  const fixtures = regularSeasonFixtures(groups, format.doubleRound);
  const groupViews = groups.map((members) => {
    const inGroup = new Set(members);
    const weeks = new Set(
      fixtures.filter((fixture) => inGroup.has(fixture.home)).map((fixture) => fixture.week),
    );
    const offWeeks = Array.from({ length: format.regularWeeks }, (_, i) => i + 1).filter(
      (week) => !weeks.has(week),
    );
    const matches = (members.length - 1) * (format.doubleRound ? 2 : 1);
    return { size: members.length, offWeeks, byesPerTeam: format.regularWeeks - matches };
  });
  return {
    format,
    problems: formatProblems(knobs, teamCount),
    fixtures: fixtures.length,
    plan:
      timeZone === undefined
        ? seasonPlan(format, firstMatchNight)
        : seasonPlan(format, firstMatchNight, undefined, timeZone),
    groups: groupViews,
  };
}

/**
 * What a rebuild changes, for the Regenerate confirm: "One table of 12 →
 * two groups of 6: 66 → 30 matches, 14 → 9 weeks". Empty when nothing a
 * player would notice changes.
 */
export function formatDiff(before: SeasonFormat, after: SeasonFormat): string {
  const describe = (format: SeasonFormat) =>
    format.kind === "GROUPS"
      ? `two groups of ${new Set(format.groupSizes).size === 1 ? format.groupSizes[0] : format.groupSizes.join(" and ")}${format.doubleRound ? ", each played twice" : ""}`
      : `one table of ${format.teamCount}${format.doubleRound ? ", played twice" : ""}`;
  const parts: string[] = [];
  const beforeMatches = regularFixtureCount(before);
  const afterMatches = regularFixtureCount(after);
  if (beforeMatches !== afterMatches) parts.push(`${beforeMatches} → ${afterMatches} matches`);
  if (before.totalWeeks !== after.totalWeeks) {
    parts.push(`${before.totalWeeks} → ${after.totalWeeks} weeks`);
  }
  if (before.playoffSpots !== after.playoffSpots) {
    parts.push(`top ${before.playoffSpots} → top ${after.playoffSpots} in the playoffs`);
  }
  const layout = describe(before) === describe(after) ? "" : `${describe(before)} → ${describe(after)}`;
  const text = [layout, parts.join(", ")].filter(Boolean).join(": ");
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "";
}

export type FormatEditMode = "OPEN" | "BUILT" | "LOCKED";

/**
 * What the season's format can do now, for the card's buttons and both
 * actions (one predicate, so the card never offers what the action refuses):
 *
 *   LOCKED: the playoffs or the record, or while any regular result or game
 *           stands (the regenerate gate); a reopened result unlocks it.
 *   BUILT:  regular fixtures exist and no result: the playoff places change
 *           in place, groups or how often teams meet only by Regenerate.
 *   OPEN:   no fixtures yet. `countFinal` once the auction has begun, so
 *           the team count can no longer change.
 */
export function formatEditState(input: {
  seasonStatus: string;
  draftStatus: string | null | undefined;
  regularFixtures: number;
  regularResults: number;
  games: number;
}): { mode: FormatEditMode; countFinal: boolean; lockReason: string | null } {
  const countFinal = !draftSetupOpen(input.seasonStatus, input.draftStatus);
  if (
    input.seasonStatus === SEASON_STATUS.PLAYOFFS ||
    input.seasonStatus === SEASON_STATUS.COMPLETE
  ) {
    return {
      mode: "LOCKED",
      countFinal,
      lockReason:
        input.seasonStatus === SEASON_STATUS.PLAYOFFS
          ? "The playoffs have started, so this season's format is locked."
          : "The season is complete, so its format is a record.",
    };
  }
  if (input.regularResults > 0 || input.games > 0) {
    return {
      mode: "LOCKED",
      countFinal,
      lockReason:
        "Results are in, so this season's format is locked: it decides the playoff places those results count towards.",
    };
  }
  if (input.regularFixtures > 0) return { mode: "BUILT", countFinal, lockReason: null };
  return { mode: "OPEN", countFinal, lockReason: null };
}
