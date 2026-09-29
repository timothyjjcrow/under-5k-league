// Round-robin schedule generation (circle method) + single-elimination seeding.
// Pure + testable.

import { AUTO_SYNC, MATCH_PHASE, MATCH_STATUS } from "./constants";
import { LEAGUE_CONFIG } from "./league-config";
import { dateAtWallTime, wallTime, zoneFormatter as timeFormatter } from "./zoned-time";

export type Pairing = { home: string; away: string };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Both leagues follow their configured local clock, so "Sundays at 6 PM" stays
// 6 PM after daylight saving ends. The US league used fixed UTC intervals until
// 2026-09, which moved every fixture after the November clock change an hour
// earlier. Stored kickoffs are never rewritten by this: it only decides the
// dates that generation, playoff rounds and the week mover compute next.
const SCHEDULE_TIME_ZONE: string | null = LEAGUE_CONFIG.timeZone;

/** Week N's match night, preserving the local clock across daylight saving. */
export function matchNightForWeek(
  firstNight: Date,
  week: number,
  timeZone: string | null = SCHEDULE_TIME_ZONE,
): Date {
  if (!timeZone || week === 1)
    return new Date(firstNight.getTime() + (week - 1) * WEEK_MS);
  const formatter = timeFormatter(timeZone);
  const target = wallTime(firstNight, formatter) + (week - 1) * WEEK_MS;
  return dateAtWallTime(target, formatter);
}

/** Apply a league-night move to other fixtures, retaining local-clock offsets. */
export function shiftMatchNight(
  date: Date,
  previousNight: Date,
  nextNight: Date,
  timeZone: string | null = SCHEDULE_TIME_ZONE,
): Date {
  if (!timeZone)
    return new Date(date.getTime() + nextNight.getTime() - previousNight.getTime());
  const formatter = timeFormatter(timeZone);
  const delta = wallTime(nextNight, formatter) - wallTime(previousNight, formatter);
  return dateAtWallTime(wallTime(date, formatter) + delta, formatter);
}

/**
 * The calendar month holding `nowMs` on the league's clock, as a half-open
 * [start, end) pair of instants plus a display label ("September 2026").
 *
 * A monthly board must turn over at midnight on the 1st where the league
 * plays, not where the server runs: on a UTC host a Pacific league's October
 * would begin at 5 PM on September 30th, mid-session. Midnight is resolved the
 * same way as a match night, so a clock change on the 1st still lands on a
 * real local instant. `null` uses UTC (tests only).
 */
export function leagueMonthWindow(
  nowMs: number,
  timeZone: string | null = SCHEDULE_TIME_ZONE,
): { start: Date; end: Date; label: string } {
  const formatter = timeZone ? timeFormatter(timeZone) : null;
  // The wall-clock reading, carried in a UTC Date so its fields are the local
  // year and month whatever the host's own zone is.
  const local = new Date(
    formatter ? wallTime(new Date(nowMs), formatter) : nowMs,
  );
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const at = (target: number) =>
    formatter ? dateAtWallTime(target, formatter) : new Date(target);
  return {
    start: at(Date.UTC(year, month, 1)),
    end: at(Date.UTC(year, month + 1, 1)),
    label: new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month, 1))),
  };
}

/**
 * The league night for `week`, rolled forward if that date has already passed.
 *
 * Playoff rounds are dated by pure arithmetic off `firstMatchNight`, so once a
 * season slips (captain reschedules don't move the anchor) a bracket created
 * today could be stamped with a kickoff LAST week. That silently disables the
 * result pipeline for the biggest matches of the season: `isAutoSyncDue` sees a
 * window that closed 48h ago and never scans, and `autoDetectGamesForMatch`
 * windows its candidate games around the wrong night so a manual "Auto-fetch"
 * reports "no games found" for games that plainly exist.
 *
 * Rolling forward in whole weeks keeps the league's weekday and kickoff time.
 */
export function upcomingMatchNight(
  firstNight: Date,
  week: number,
  nowMs: number,
  timeZone: string | null = SCHEDULE_TIME_ZONE,
): Date {
  const t = matchNightForWeek(firstNight, week, timeZone);
  if (t.getTime() >= nowMs) return t;
  let nextWeek = week + Math.max(0, Math.floor((nowMs - t.getTime()) / WEEK_MS));
  let next = matchNightForWeek(firstNight, nextWeek, timeZone);
  // UTC estimates can be an hour either side of a daylight-saving boundary.
  while (next.getTime() < nowMs) {
    nextWeek += 1;
    next = matchNightForWeek(firstNight, nextWeek, timeZone);
  }
  return next;
}

/**
 * The latest kickoff a captain-agreed reschedule may choose for a REGULAR
 * match, or null when there is no limit to enforce.
 *
 * `startPlayoffs` refuses while any regular result is outstanding, so a
 * regular match moved past the playoff night blocks the whole bracket. The
 * limit is the earliest playoff kickoff already on the calendar, otherwise the
 * planned playoff night: the league night after the last regular week.
 *
 * Once that planned night has passed with no bracket on the calendar, the
 * season has slipped and the playoff date is an admin decision the site can't
 * see, so there is no limit. Rolling forward to the next league night instead
 * would refuse any reschedule past this week's night, a rule no admin chose.
 * Playoff and tiebreaker matches have no limit here: moving one only delays
 * its own round.
 */
export function rescheduleDeadline(options: {
  phase: string;
  firstMatchNight: Date | null;
  lastRegularWeek: number;
  earliestPostseasonKickoffMs: number | null;
  nowMs: number;
  timeZone?: string | null;
}): Date | null {
  if (options.phase !== MATCH_PHASE.REGULAR) return null;
  if (options.earliestPostseasonKickoffMs != null)
    return new Date(options.earliestPostseasonKickoffMs);
  if (!options.firstMatchNight || options.lastRegularWeek < 1) return null;
  const planned = matchNightForWeek(
    options.firstMatchNight,
    options.lastRegularWeek + 1,
    options.timeZone === undefined ? SCHEDULE_TIME_ZONE : options.timeZone,
  );
  return planned.getTime() > options.nowMs ? planned : null;
}

/**
 * Generate a round-robin: every team plays every other once (or twice if
 * `doubleRound`). Returns an array of rounds (weeks); each round is a list of
 * pairings. Handles odd team counts by inserting a bye.
 */
export function roundRobin(
  teamIds: string[],
  doubleRound = false,
): Pairing[][] {
  const teams = [...teamIds];
  if (teams.length < 2) return [];

  const BYE = "__BYE__";
  if (teams.length % 2 !== 0) teams.push(BYE);

  const n = teams.length;
  const arr = [...teams];
  const rounds: Pairing[][] = [];
  // Running (home − away) tally per team. Each pairing's home goes to whichever
  // team has hosted least so far, keeping the season's home/away split fair
  // (|home − away| ≤ 1). A plain round-parity rule leaves the circle-method's
  // fixed team badly imbalanced (e.g. all-away).
  const venue = new Map<string, number>();

  for (let r = 0; r < n - 1; r++) {
    const pairings: Pairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== BYE && b !== BYE) {
        const ba = venue.get(a) ?? 0;
        const bb = venue.get(b) ?? 0;
        // Host the team that has hosted least; break ties by round+position
        // parity. This keeps every team's home/away split within 1 all season.
        const [home, away] =
          ba !== bb
            ? ba < bb
              ? [a, b]
              : [b, a]
            : (r + i) % 2 === 0
              ? [a, b]
              : [b, a];
        pairings.push({ home, away });
        venue.set(home, (venue.get(home) ?? 0) + 1);
        venue.set(away, (venue.get(away) ?? 0) - 1);
      }
    }
    rounds.push(pairings);

    // Rotate all but the first element clockwise.
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop() as string);
    arr.splice(0, arr.length, fixed, ...rest);
  }

  if (doubleRound) {
    const second = rounds.map((round) =>
      round.map((p) => ({ home: p.away, away: p.home })),
    );
    return [...rounds, ...second];
  }
  return rounds;
}

/**
 * Standard single-elimination seeding order for a bracket of `size` slots
 * (size must be a power of two). Returns the 1-indexed seed positions so that
 * seed 1 meets the lowest seed, etc. e.g. size 4 -> [1,4,2,3].
 */
export function seedOrder(size: number): number[] {
  let rounds = [1, 2];
  while (rounds.length < size) {
    const next: number[] = [];
    const total = rounds.length * 2 + 1;
    for (const s of rounds) {
      next.push(s);
      next.push(total - s);
    }
    rounds = next;
  }
  return rounds;
}

/**
 * Build first-round playoff pairings from an ordered list of seeded team IDs.
 * Takes the top `bracketSize` seeds (power of two). e.g. 4 teams -> 1v4, 2v3.
 */
export function playoffFirstRound(
  seededTeamIds: string[],
  bracketSize: number,
): Pairing[] {
  const order = seedOrder(bracketSize);
  const pairings: Pairing[] = [];
  for (let i = 0; i < order.length; i += 2) {
    const homeSeed = order[i];
    const awaySeed = order[i + 1];
    const home = seededTeamIds[homeSeed - 1];
    const away = seededTeamIds[awaySeed - 1];
    if (home && away) pairings.push({ home, away });
  }
  return pairings;
}

/** Largest power-of-two bracket that fits the given number of teams (min 2). */
export function pickBracketSize(teamCount: number): number {
  let size = 1;
  while (size * 2 <= teamCount) size *= 2;
  return Math.max(2, size);
}

/** Number of single-elimination rounds for a bracket size (power of two). */
export function bracketRounds(bracketSize: number): number {
  return Math.round(Math.log2(bracketSize));
}

/** Human name for a playoff round given the total number of rounds. */
export function roundName(roundIndex: number, totalRounds: number): string {
  const fromEnd = totalRounds - roundIndex;
  if (fromEnd <= 1) return "Grand final";
  if (fromEnd === 2) return "Semifinals";
  if (fromEnd === 3) return "Quarterfinals";
  return `Round ${roundIndex + 1}`;
}

/** A fixture as far as naming it goes. */
export type RoundLabelMatch = {
  phase: string;
  week: number;
  bracketSlot?: string | null;
  bestOf?: number | null;
};

/** Round index of a real single-elimination slot ("R1M0" → 1), else null. */
function bracketRoundOf(match: RoundLabelMatch): number | null {
  return /^R\d+M\d+$/.test(match.bracketSlot ?? "")
    ? slotRound(match.bracketSlot)
    : null;
}

/** Singular form of roundName, for one match: "Semifinal", not "Semifinals". */
function playoffMatchName(roundIndex: number, totalRounds: number): string {
  const fromEnd = totalRounds - roundIndex;
  if (fromEnd <= 1) return "Grand final";
  if (fromEnd === 2) return "Semifinal";
  if (fromEnd === 3) return "Quarterfinal";
  return `Round ${roundIndex + 1}`;
}

/**
 * How many rounds a season's playoff bracket has, read from its first-round
 * fixtures (0 = no bracket yet). Pass any of the season's matches: regular,
 * tiebreaker and other non-bracket rows are ignored. The first round is what
 * fixes the depth, so this stays right before later rounds exist.
 */
export function playoffTotalRounds(
  matches: readonly { phase: string; bracketSlot: string | null }[],
): number {
  return groupPlayoffRounds(
    matches.filter(
      (m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL,
    ),
  ).totalRounds;
}

/**
 * The one name a fixture goes by wherever a single match is labelled:
 * "Week 3", "Tiebreaker", "Quarterfinal", "Semifinal", "Grand final".
 *
 * Playoff rows keep counting weeks in the database, so "Week 9" and a bare
 * "Playoffs" both read wrong for a semifinal. `totalRounds` comes from
 * `playoffTotalRounds` over the season's matches; when it can't place the
 * match (no bracket rows, a legacy row without a slot) a PLAYOFF match falls
 * back to "Playoffs" rather than guessing. Only the FINAL phase is ever called
 * "Grand final" — the word "Final" belongs to that match alone.
 *
 * `bestOf: true` appends the series length ("Semifinal · Bo3") for postseason
 * fixtures and leaves it off regular weeks, which are created at the season's
 * `regularBestOf`. A mid-season series-length save moves only regular fixtures
 * that have not started, so played weeks can keep an older length.
 */
export function matchRoundLabel(
  match: RoundLabelMatch,
  totalRounds: number,
  options: { bestOf?: boolean } = {},
): string {
  let label: string;
  if (match.phase === MATCH_PHASE.FINAL) label = "Grand final";
  else if (match.phase === MATCH_PHASE.PLAYOFF) {
    const round = bracketRoundOf(match);
    label =
      round !== null && totalRounds > round + 1
        ? playoffMatchName(round, totalRounds)
        : "Playoffs";
  } else if (match.phase === MATCH_PHASE.TIEBREAKER) label = "Tiebreaker";
  else label = `Week ${match.week}`;
  if (
    options.bestOf &&
    match.phase !== MATCH_PHASE.REGULAR &&
    match.bestOf != null &&
    match.bestOf > 0
  ) {
    label += ` · Bo${match.bestOf}`;
  }
  return label;
}

/**
 * Heading for a group of fixtures that share a week number (pick'em groups
 * its open matches that way): the round's name when the whole group is one
 * playoff round ("Semifinals"), "Tiebreaker" for a tiebreaker group, and
 * "Week N" otherwise.
 */
export function roundGroupLabel(
  matches: readonly RoundLabelMatch[],
  totalRounds: number,
): string {
  const first = matches[0];
  if (!first) return "";
  const groupName = (m: RoundLabelMatch): string => {
    if (m.phase === MATCH_PHASE.PLAYOFF) {
      const round = bracketRoundOf(m);
      return round !== null && totalRounds > round + 1
        ? roundName(round, totalRounds)
        : "Playoffs";
    }
    return matchRoundLabel(m, totalRounds);
  };
  const name = groupName(first);
  return matches.every((m) => groupName(m) === name)
    ? name
    : `Week ${first.week}`;
}

/**
 * Where a knockout series' winner goes next: the following round's name
 * ("Semifinals", "Grand final"), or null for the grand final itself, a
 * non-bracket match, or a slot this bracket can't place.
 */
export function nextPlayoffRoundName(
  match: RoundLabelMatch,
  totalRounds: number,
): string | null {
  if (match.phase !== MATCH_PHASE.PLAYOFF) return null;
  const round = bracketRoundOf(match);
  if (round === null || totalRounds <= round + 1) return null;
  return roundName(round + 1, totalRounds);
}

/**
 * Chronological comparator for match lists: kickoff time first (unscheduled
 * last), then week, then creation order. Reschedules can move a match past its
 * week-mates, so week order alone is NOT chronological.
 */
export function byKickoff(
  a: { scheduledAt: Date | null; week: number; createdAt?: Date },
  b: { scheduledAt: Date | null; week: number; createdAt?: Date },
): number {
  const at = a.scheduledAt ? a.scheduledAt.getTime() : Infinity;
  const bt = b.scheduledAt ? b.scheduledAt.getTime() : Infinity;
  if (at !== bt) return at - bt;
  if (a.week !== b.week) return a.week - b.week;
  return (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
}

/** Pair the winners of one round (in bracket order) into the next round. */
export function nextRoundPairings(winnersInOrder: string[]): Pairing[] {
  const pairings: Pairing[] = [];
  for (let i = 0; i + 1 < winnersInOrder.length; i += 2) {
    pairings.push({ home: winnersInOrder[i], away: winnersInOrder[i + 1] });
  }
  return pairings;
}

/** Round index encoded in a bracket slot like "R2M1" (0 for non-bracket). */
export function slotRound(slot: string | null | undefined): number {
  const m = slot?.match(/^R(\d+)M/);
  return m ? Number(m[1]) : 0;
}

/**
 * Has this playoff series already produced downstream bracket state?
 *
 * Result corrections use this same deliberately conservative rule on the
 * server: once any later round exists, changing an earlier winner would leave
 * the teams in that later round stale. Keeping the projection shared lets the
 * admin UI stop advertising a correction that the mutation must reject.
 */
export function hasLaterBracketRound(
  matches: { bracketSlot: string | null }[],
  bracketSlot: string | null | undefined,
): boolean {
  const round = slotRound(bracketSlot);
  return matches.some((match) => slotRound(match.bracketSlot) > round);
}

/**
 * Which teams sit out each regular-season week (odd team counts give the
 * round-robin a rotating bye). Only weeks that have at least one match are
 * reported — a week number is defined by its fixtures.
 */
export function byeTeamsByWeek<
  T extends {
    week: number;
    homeTeamId: string;
    awayTeamId: string;
    phase: string;
  },
>(matches: T[], teamIds: string[]): Map<number, string[]> {
  const byWeek = new Map<number, Set<string>>();
  for (const m of matches) {
    if (m.phase !== MATCH_PHASE.REGULAR) continue;
    const playing = byWeek.get(m.week) ?? new Set<string>();
    playing.add(m.homeTeamId);
    playing.add(m.awayTeamId);
    byWeek.set(m.week, playing);
  }
  const byes = new Map<number, string[]>();
  for (const [week, playing] of byWeek) {
    byes.set(
      week,
      teamIds.filter((id) => !playing.has(id)),
    );
  }
  return byes;
}

/**
 * The league's current regular week when THIS team sits it out, else null.
 * With an odd number of teams one team rests each week (roundRobin rotates
 * the bye), and the first team in draft order always rests week 1, so on
 * opening night its players watch everyone else check in. Every surface that
 * shows the team's next match should say so rather than jump silently to the
 * week after. "Current" is the earliest week still holding an open, relevant
 * regular fixture: the week /schedule badges "This week" (leagueProgress's
 * focusWeek). A team with no fixtures at all has no bye to report.
 */
export function teamByeWeek<
  T extends SlateMatch & { homeTeamId: string; awayTeamId: string },
>(matches: T[], teamId: string, nowMs: number): number | null {
  const regular = matches.filter((m) => m.phase === MATCH_PHASE.REGULAR);
  const plays = (m: T) => m.homeTeamId === teamId || m.awayTeamId === teamId;
  if (!regular.some(plays)) return null;
  const openWeeks = regular
    .filter((m) => isRelevantOpenMatch(m, nowMs))
    .map((m) => m.week);
  if (openWeeks.length === 0) return null;
  const week = Math.min(...openWeeks);
  return regular.some((m) => m.week === week && plays(m)) ? null : week;
}

/**
 * The order /schedule reads its regular weeks in: the league's current week,
 * then the weeks still to come in order, then the earlier weeks NEWEST first
 * (flagged `earlier`, so the list can head them "Earlier weeks"). A player
 * looking for next week's fixture no longer scrolls past old results to find
 * it. `currentWeek` is the league's current slate (leagueProgress's
 * focusWeek); with none — every result in, or only overdue results left —
 * every week is behind the league and the whole list reads newest first.
 */
export function orderScheduleWeeks<T extends { week: number }>(
  weeks: T[],
  currentWeek: number | null,
): (T & { earlier: boolean })[] {
  const ahead =
    currentWeek == null
      ? []
      : weeks
          .filter((w) => w.week >= currentWeek)
          .sort((a, b) => a.week - b.week);
  const behind = weeks
    .filter((w) => currentWeek == null || w.week < currentWeek)
    .sort((a, b) => b.week - a.week);
  return [
    ...ahead.map((w) => ({ ...w, earlier: false })),
    ...behind.map((w) => ({ ...w, earlier: true })),
  ];
}

/**
 * Does a /schedule week (or playoff round) start closed? Only once every
 * series it SHOWS is final and it lies before the current week. The counts
 * are the ones on the week's header, so under a team filter a past week
 * closes as soon as that team's own series is final: a player's season
 * reads as one line per finished week instead of a stack of full cards.
 */
export function weekStartsCollapsed(
  week: { week: number; completed: number; total: number },
  currentWeek: number | null | undefined,
): boolean {
  return (
    week.total > 0 &&
    week.completed === week.total &&
    (currentWeek == null || week.week < currentWeek)
  );
}

/**
 * The team a /schedule reader is looking at: an explicit `?team=` in the URL
 * wins ("all", or an id that isn't one of these teams, means no team), and
 * without one it is the reader's own team. The fixture filter and the
 * calendar control both read it, so "Add to calendar" offers the team whose
 * matches are on screen.
 */
export function scheduleFilterTeamId(
  requested: string | null,
  initialTeamId: string | null | undefined,
  teamIds: readonly string[],
): string | null {
  const candidate = requested === null ? initialTeamId : requested;
  return candidate != null && teamIds.includes(candidate) ? candidate : null;
}

/** Match index encoded in a bracket slot like "R2M1" (null when absent). */
export function slotIndex(slot: string | null | undefined): number | null {
  const m = slot?.match(/M(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Full bracket structure including rounds that haven't been created yet:
 * every round from the first to the final, each with its expected number of
 * slots, holding either the real match or null (a TBD placeholder). This is
 * what lets the bracket UI draw the whole tree — connectors and future
 * rounds — from just the matches that exist so far.
 */
export function bracketSkeleton<T extends { bracketSlot: string | null }>(
  matches: T[],
): { totalRounds: number; rounds: { round: number; slots: (T | null)[] }[] } {
  const firstRound = matches.filter((m) => slotRound(m.bracketSlot) === 0);
  if (firstRound.length === 0) return { totalRounds: 0, rounds: [] };
  const totalRounds = bracketRounds(firstRound.length * 2);

  const rounds = Array.from({ length: totalRounds }, (_, round) => {
    const count = firstRound.length >> round;
    const slots: (T | null)[] = new Array(count).fill(null);
    const inRound = matches
      .filter((m) => slotRound(m.bracketSlot) === round)
      .sort((a, b) => (a.bracketSlot ?? "").localeCompare(b.bracketSlot ?? ""));
    // Place by the slot's M-index; legacy matches without a slot fill gaps
    // in order.
    const strays: T[] = [];
    for (const m of inRound) {
      const i = slotIndex(m.bracketSlot);
      if (i != null && i < count && slots[i] === null) slots[i] = m;
      else strays.push(m);
    }
    for (const m of strays) {
      const gap = slots.indexOf(null);
      if (gap !== -1) slots[gap] = m;
    }
    return { round, slots };
  });
  return { totalRounds, rounds };
}

/**
 * Group playoff matches into ordered rounds for a bracket view, and report how
 * many rounds the bracket has (derived from the first round's match count).
 * Pure so the schedule + dashboard render the same structure.
 */
export function groupPlayoffRounds<T extends { bracketSlot: string | null }>(
  matches: T[],
): { totalRounds: number; rounds: { round: number; matches: T[] }[] } {
  const firstRoundCount = matches.filter(
    (m) => slotRound(m.bracketSlot) === 0,
  ).length;
  const totalRounds =
    firstRoundCount > 0 ? bracketRounds(firstRoundCount * 2) : 0;
  const roundNums = [
    ...new Set(matches.map((m) => slotRound(m.bracketSlot))),
  ].sort((a, b) => a - b);
  const rounds = roundNums.map((round) => ({
    round,
    matches: matches
      .filter((m) => slotRound(m.bracketSlot) === round)
      .sort((a, b) => (a.bracketSlot ?? "").localeCompare(b.bracketSlot ?? "")),
  }));
  return { totalRounds, rounds };
}

/** The minimum a match needs to be placed on the dashboard's front band. */
export type SlateMatch = {
  id: string;
  week: number;
  phase: string;
  status: string;
  scheduledAt?: Date | null;
};

/**
 * Is an unfinished fixture still relevant as current/upcoming schedule work?
 * LIVE and untimed rows remain visible. A timed row older than the result-sync
 * window is results debt: surfaces should label it overdue rather than call it
 * the player's next match or the league's current week.
 */
export function isRelevantOpenMatch(match: SlateMatch, nowMs: number): boolean {
  if (match.status === MATCH_STATUS.COMPLETED) return false;
  if (match.status === MATCH_STATUS.LIVE || match.scheduledAt == null)
    return true;
  return (
    match.scheduledAt.getTime() >= nowMs - AUTO_SYNC.WINDOW_HOURS * 3600_000
  );
}

/**
 * The slate the dashboard leads with: during PLAYOFFS every open bracket
 * match, otherwise the EARLIEST week that still has an unplayed regular or
 * tiebreaker fixture — plus the heading that describes it.
 *
 * Shared rather than computed twice, and that sharing is the point. The
 * dashboard used to derive this inside its This-week card while the Upcoming
 * card independently took "the next four unplayed matches by kickoff" — which
 * mid-week is the SAME fixtures, so a viewer read tonight's games twice on one
 * screen (three times with their own team's next-up tile). Upcoming now means
 * "what comes AFTER the slate", which is only definable against the same
 * function the slate came from.
 */
export function focusSlate<T extends SlateMatch>(
  seasonStatus: string,
  matches: T[],
  nowMs = Date.now(),
): { slate: T[]; title: string } {
  const open = matches.filter((m) => isRelevantOpenMatch(m, nowMs));
  if (seasonStatus === "PLAYOFFS") {
    return {
      slate: open.filter(
        (m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL,
      ),
      title: "The round in progress",
    };
  }
  const openRegular = open.filter(
    (m) => m.phase === MATCH_PHASE.REGULAR || m.phase === MATCH_PHASE.TIEBREAKER,
  );
  if (openRegular.length === 0) return { slate: [], title: "This week" };
  const week = Math.min(...openRegular.map((m) => m.week));
  const slate = openRegular.filter((m) => m.week === week);
  return {
    slate,
    title: slate.some((m) => m.phase === MATCH_PHASE.TIEBREAKER)
      ? `Tiebreaker week · Week ${week}`
      : `This week · Week ${week}`,
  };
}
