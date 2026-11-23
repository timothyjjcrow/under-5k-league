// Breaks: league nights with no games (holidays), stored on the Season as
// calendar dates on the league's clock (`Season.breakDates`, JSON
// ["2026-12-26"]). The date math that skips them is in schedule.ts
// (`roundNight`); this file reads and writes the column and makes the pure
// decisions behind /admin's Add break and Remove: which nights can take a
// break, which fixtures move, and what a player is told. Client-safe.

import { MATCH_STATUS, SEASON_STATUS } from "./constants";
import {
  BREAK_REACH_DAYS,
  breakCoversNight,
  breakDayNumber,
  leagueDateKey,
  leagueDayNumber,
  matchNightForWeek,
  roundNight,
  roundSlot,
  shiftMatchNight,
} from "./schedule";
import { LEAGUE_CONFIG } from "./league-config";
import { LEAGUE_LOCALE } from "./zoned-time";

const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_TIME_ZONE: string | null = LEAGUE_CONFIG.timeZone;

/** Two breaks this close could cover the same night, so they never coexist. */
const MIN_BREAK_GAP_DAYS = 2 * BREAK_REACH_DAYS + 1;

/**
 * `Season.breakDates` as sorted, unique, real dates. Null or anything this
 * version didn't write reads as no breaks: only the admin's Add break and
 * Remove write the column.
 */
export function parseBreakDates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const dates = value.filter(
    (date): date is string => typeof date === "string" && breakDayNumber(date) !== null,
  );
  return [...new Set(dates)].sort();
}

/** Breaks are season planning: editable in every phase but a finished season. */
export function seasonBreaksEditable(seasonStatus: string): boolean {
  return seasonStatus !== SEASON_STATUS.COMPLETE;
}

/**
 * The claim a breaks form posts: the column value it was rendered with, ""
 * for none. A form from before another admin's change is refused.
 */
export function seasonBreaksToken(breakDates: string | null): string {
  return breakDates ?? "";
}

/** A stored date as the league reads it: "Sat, Dec 26" (en-GB in Europe: "Sat 26 Dec"). */
export function formatBreakDate(date: string): string {
  const day = breakDayNumber(date);
  if (day === null) return date;
  return new Intl.DateTimeFormat(LEAGUE_LOCALE, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(day * DAY_MS));
}

/** The column value for `dates`: a sorted JSON array, or null for none. */
export function serializeBreakDates(dates: readonly string[]): string | null {
  const sorted = [...new Set(dates)].sort();
  return sorted.length > 0 ? JSON.stringify(sorted) : null;
}

/** The league night (counted from week 1's, which is 1) nearest a date. */
function nearestSlot(firstNight: Date, day: number, timeZone: string | null): number {
  const firstDay = leagueDayNumber(firstNight, timeZone);
  return Math.round((day - firstDay) / 7) + 1;
}

export type BreakChoice =
  | { ok: true; date: string; night: Date | null }
  | { ok: false; error: string };

/**
 * Whether `date` ("YYYY-MM-DD", from the admin's picker) can become a break,
 * and the date to store. With week 1's night known, the break is the league
 * night nearest the date and is stored as that night's date; it must be a
 * night after week 1's that hasn't started and isn't a break already. Before
 * week 1's night is set, any later date may be planned: it covers whichever
 * night ends up nearest it.
 */
export function chooseBreak(input: {
  date: string;
  firstMatchNight: Date | null;
  breaks: readonly string[];
  nowMs: number;
  timeZone?: string | null;
}): BreakChoice {
  const timeZone = input.timeZone === undefined ? SCHEDULE_TIME_ZONE : input.timeZone;
  const day = breakDayNumber(input.date.trim());
  if (day === null) return { ok: false, error: "Pick the night to skip." };
  const today = leagueDayNumber(new Date(input.nowMs), timeZone);
  let date = input.date.trim();
  let night: Date | null = null;
  if (input.firstMatchNight) {
    const slot = nearestSlot(input.firstMatchNight, day, timeZone);
    if (slot <= 1) {
      return {
        ok: false,
        error:
          "That's week 1's night or earlier. To start the season later, move the first match night instead.",
      };
    }
    night = matchNightForWeek(input.firstMatchNight, slot, timeZone);
    if (night.getTime() <= input.nowMs) {
      return { ok: false, error: "That night has already started. Pick a later one." };
    }
    date = leagueDateKey(night, timeZone);
    if (breakCoversNight(night, input.breaks, timeZone)) {
      return { ok: false, error: "That night is already a break." };
    }
  } else if (day <= today) {
    return { ok: false, error: "Pick a date after today." };
  }
  const normalized = breakDayNumber(date)!;
  const close = input.breaks.find((other) => {
    const otherDay = breakDayNumber(other);
    return otherDay !== null && Math.abs(otherDay - normalized) < MIN_BREAK_GAP_DAYS;
  });
  if (close) {
    return { ok: false, error: "There's already a break that week." };
  }
  return { ok: true, date, night };
}

/**
 * Whether the break on `date` can be removed. A break whose night has passed
 * stays: removing it would re-date every later round onto nights already
 * gone.
 */
export function breakRemoveRefusal(input: {
  date: string;
  firstMatchNight: Date | null;
  breaks: readonly string[];
  nowMs: number;
  timeZone?: string | null;
}): string | null {
  const timeZone = input.timeZone === undefined ? SCHEDULE_TIME_ZONE : input.timeZone;
  const day = breakDayNumber(input.date);
  if (day === null || !input.breaks.includes(input.date)) {
    return "That break was already removed. Reload to see the season's breaks.";
  }
  const night = breakNight(input.firstMatchNight, input.date, timeZone);
  const passed = night
    ? night.getTime() <= input.nowMs
    : day <= leagueDayNumber(new Date(input.nowMs), timeZone);
  return passed ? "That break's night has passed, so it stays on the season." : null;
}

/** The league night a break covers, or null before week 1's night is set. */
export function breakNight(
  firstMatchNight: Date | null,
  date: string,
  timeZone: string | null = SCHEDULE_TIME_ZONE,
): Date | null {
  const day = breakDayNumber(date);
  if (!firstMatchNight || day === null) return null;
  return matchNightForWeek(firstMatchNight, nearestSlot(firstMatchNight, day, timeZone), timeZone);
}

export type BreakFixture = {
  id: string;
  week: number;
  status: string;
  scheduledAt: Date | null;
};

export type BreakShift = {
  /** Scheduled fixtures on their round's night, which move with the round. */
  moves: { id: string; week: number; from: Date; to: Date }[];
  /**
   * Scheduled fixtures of a round that moves, kept where they are because
   * they aren't on the round's night: a time the captains agreed, or one an
   * admin set by hand.
   */
  kept: { id: string; week: number; at: Date }[];
  /** Fixtures on a moving round's night that are live or played: the change is refused. */
  started: { id: string; week: number }[];
};

/**
 * What a change to the breaks does to the season's fixtures. A round whose
 * night changes takes the fixtures on that night with it (same time of day
 * on the league's clock, `shiftMatchNight`); a fixture elsewhere is left
 * alone and reported, because someone arranged that time. Rounds with no
 * fixture yet (playoff rounds still to come) need nothing: they are dated
 * from the breaks when they are created.
 */
export function breakShift(input: {
  firstMatchNight: Date;
  before: readonly string[];
  after: readonly string[];
  fixtures: readonly BreakFixture[];
  timeZone?: string | null;
}): BreakShift {
  const timeZone = input.timeZone === undefined ? SCHEDULE_TIME_ZONE : input.timeZone;
  const shift: BreakShift = { moves: [], kept: [], started: [] };
  const nights = new Map<number, { from: Date; to: Date } | null>();
  const roundMove = (week: number) => {
    if (!nights.has(week)) {
      const from = roundNight(input.firstMatchNight, week, input.before, timeZone);
      const to = roundNight(input.firstMatchNight, week, input.after, timeZone);
      nights.set(week, from.getTime() === to.getTime() ? null : { from, to });
    }
    return nights.get(week)!;
  };
  const ordered = [...input.fixtures].sort(
    (a, b) =>
      a.week - b.week ||
      (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const fixture of ordered) {
    if (!fixture.scheduledAt || fixture.week < 1) continue;
    const round = roundMove(fixture.week);
    if (!round) continue;
    const onNight =
      leagueDayNumber(fixture.scheduledAt, timeZone) === leagueDayNumber(round.from, timeZone);
    if (fixture.status !== MATCH_STATUS.SCHEDULED) {
      if (onNight) shift.started.push({ id: fixture.id, week: fixture.week });
      continue;
    }
    if (onNight) {
      shift.moves.push({
        id: fixture.id,
        week: fixture.week,
        from: fixture.scheduledAt,
        to: shiftMatchNight(fixture.scheduledAt, round.from, round.to, timeZone),
      });
    } else {
      shift.kept.push({ id: fixture.id, week: fixture.week, at: fixture.scheduledAt });
    }
  }
  return shift;
}

export type BreakNightOption = {
  /** The night's date on the league's clock, what Add break posts. */
  date: string;
  night: Date;
  /** The round planned on that night today, if any. */
  round: number | null;
};

/**
 * The nights /admin offers for a new break: every league night after week
 * 1's that hasn't started and isn't a break, through two nights past the
 * season's last planned round.
 */
export function breakNightOptions(input: {
  firstMatchNight: Date;
  breaks: readonly string[];
  lastRound: number;
  nowMs: number;
  timeZone?: string | null;
}): BreakNightOption[] {
  const timeZone = input.timeZone === undefined ? SCHEDULE_TIME_ZONE : input.timeZone;
  const lastSlot = roundSlot(input.firstMatchNight, Math.max(1, input.lastRound), input.breaks, timeZone) + 2;
  const roundAt = new Map<number, number>();
  for (let round = 1; round <= input.lastRound; round += 1) {
    roundAt.set(roundSlot(input.firstMatchNight, round, input.breaks, timeZone), round);
  }
  const options: BreakNightOption[] = [];
  for (let slot = 2; slot <= lastSlot; slot += 1) {
    const night = matchNightForWeek(input.firstMatchNight, slot, timeZone);
    if (night.getTime() <= input.nowMs) continue;
    if (breakCoversNight(night, input.breaks, timeZone)) continue;
    options.push({ date: leagueDateKey(night, timeZone), night, round: roundAt.get(slot) ?? null });
  }
  return options;
}

export type SeasonBreakView = {
  date: string;
  /** The night it skips, or null before week 1's night is set. */
  night: Date | null;
  /** The round that plays next, the one the break delays; null past the plan. */
  delays: number | null;
  /** Its night has passed (it can't be removed). */
  past: boolean;
};

/** The season's breaks, in date order, as /admin and the pages list them. */
export function seasonBreakViews(input: {
  firstMatchNight: Date | null;
  breaks: readonly string[];
  lastRound: number;
  nowMs: number;
  timeZone?: string | null;
}): SeasonBreakView[] {
  const timeZone = input.timeZone === undefined ? SCHEDULE_TIME_ZONE : input.timeZone;
  const today = leagueDayNumber(new Date(input.nowMs), timeZone);
  return input.breaks.map((date) => {
    const night = breakNight(input.firstMatchNight, date, timeZone);
    let delays: number | null = null;
    if (night && input.firstMatchNight) {
      for (let round = 2; round <= input.lastRound; round += 1) {
        if (roundNight(input.firstMatchNight, round, input.breaks, timeZone).getTime() > night.getTime()) {
          delays = round;
          break;
        }
      }
    }
    const past = night ? night.getTime() <= input.nowMs : breakDayNumber(date)! <= today;
    return { date, night, delays, past };
  });
}

/**
 * The break players are told about now: one whose night is within the next
 * week (or is today, until the end of its day on the league's clock), and
 * when the league is back: the first scheduled kickoff after it, or the next
 * planned round's night when that round has no fixtures yet. Null when no
 * break is that close or nothing is left to play after it.
 */
export function upcomingBreak(input: {
  firstMatchNight: Date | null;
  breaks: readonly string[];
  /** Kickoffs of the season's scheduled fixtures. */
  kickoffs: readonly Date[];
  /** The season plan's last round (`totalWeeks`), for rounds not built yet. */
  lastRound: number;
  /**
   * The reserved tiebreaker week, played only if a tie needs it: never the
   * planned night the league is back on (its fixtures, once built, are
   * among the kickoffs).
   */
  tiebreakerRound?: number;
  nowMs: number;
  timeZone?: string | null;
}): { night: Date; resumesAt: Date } | null {
  const timeZone = input.timeZone === undefined ? SCHEDULE_TIME_ZONE : input.timeZone;
  const first = input.firstMatchNight;
  if (!first) return null;
  const today = leagueDayNumber(new Date(input.nowMs), timeZone);
  for (const date of input.breaks) {
    const night = breakNight(first, date, timeZone);
    if (!night) continue;
    const day = leagueDayNumber(night, timeZone);
    if (day < today || night.getTime() - input.nowMs > 7 * DAY_MS) continue;
    const scheduled = input.kickoffs.filter(
      (kickoff) => leagueDayNumber(kickoff, timeZone) > day,
    );
    let planned: Date | null = null;
    for (let round = 2; round <= input.lastRound; round += 1) {
      if (round === input.tiebreakerRound) continue;
      const at = roundNight(first, round, input.breaks, timeZone);
      if (at.getTime() > night.getTime()) {
        planned = at;
        break;
      }
    }
    const candidates = [...scheduled, ...(planned ? [planned] : [])].sort(
      (a, b) => a.getTime() - b.getTime(),
    );
    return candidates[0] ? { night, resumesAt: candidates[0] } : null;
  }
  return null;
}
