// Round-robin schedule generation (circle method) + single-elimination seeding.
// Pure + testable.

import { AUTO_SYNC, MATCH_PHASE, MATCH_STATUS } from "./constants";
import { LEAGUE_CONFIG } from "./league-config";

export type Pairing = { home: string; away: string };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Existing US seasons were generated in UTC intervals. Preserve their anchors
// and future playoff dates; new EU seasons follow the configured local clock.
const SCHEDULE_TIME_ZONE = LEAGUE_CONFIG.region === "eu" ? LEAGUE_CONFIG.timeZone : null;

function wallTime(date: Date, formatter: Intl.DateTimeFormat): number {
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
    date.getUTCMilliseconds(),
  );
}

function timeFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
}

function dateAtWallTime(target: number, formatter: Intl.DateTimeFormat): Date {
  const offsets = new Set<number>();
  // Sample both sides of a possible clock change, including half-hour changes.
  for (const hours of [-36, 0, 36]) {
    const sample = new Date(target + hours * 3_600_000);
    offsets.add(wallTime(sample, formatter) - sample.getTime());
  }
  const candidates = [...offsets].map((offset) => new Date(target - offset));
  const exact = candidates.filter((date) => wallTime(date, formatter) === target);
  // A repeated local time chooses the earlier occurrence. A skipped local time
  // moves forward by the clock change, matching calendar scheduling semantics.
  if (exact.length) return new Date(Math.min(...exact.map((date) => date.getTime())));
  const after = candidates.filter((date) => wallTime(date, formatter) > target);
  return new Date(Math.min(...after.map((date) => date.getTime())));
}

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

/**
 * Human label for a match's slot in the season: playoff matches carry a
 * continuing week number in the DB, so raw "Week N" reads wrong for them.
 */
export function matchPhaseLabel(phase: string, week: number): string {
  if (phase === MATCH_PHASE.FINAL) return "Grand final";
  if (phase === MATCH_PHASE.PLAYOFF) return "Playoffs";
  return `Week ${week}`;
}

/** Compact chip form of matchPhaseLabel: "GF" | "PO" | "W3". */
export function matchPhaseAbbrev(phase: string, week: number): string {
  if (phase === MATCH_PHASE.FINAL) return "GF";
  if (phase === MATCH_PHASE.PLAYOFF) return "PO";
  return `W${week}`;
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
 * Each team's unplayed regular-season opponents, in week order — the
 * "run-in" a playoff race is decided by.
 */
export function remainingSchedule<
  T extends {
    week: number;
    homeTeamId: string;
    awayTeamId: string;
    phase: string;
    status: string;
  },
>(
  teamIds: string[],
  matches: T[],
): Map<string, { week: number; opponentId: string }[]> {
  const out = new Map<string, { week: number; opponentId: string }[]>(
    teamIds.map((id) => [id, []]),
  );
  const open = matches
    .filter(
      (m) =>
        m.phase === MATCH_PHASE.REGULAR && m.status !== MATCH_STATUS.COMPLETED,
    )
    .sort((a, b) => a.week - b.week);
  for (const m of open) {
    out.get(m.homeTeamId)?.push({ week: m.week, opponentId: m.awayTeamId });
    out.get(m.awayTeamId)?.push({ week: m.week, opponentId: m.homeTeamId });
  }
  return out;
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
 * match, otherwise the EARLIEST week that still has an unplayed regular
 * fixture — plus the heading that describes it.
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
      slate: open.filter((m) => m.phase !== MATCH_PHASE.REGULAR),
      title: "The round in progress",
    };
  }
  const openRegular = open.filter((m) => m.phase === MATCH_PHASE.REGULAR);
  if (openRegular.length === 0) return { slate: [], title: "This week" };
  const week = Math.min(...openRegular.map((m) => m.week));
  return {
    slate: openRegular.filter((m) => m.week === week),
    title: `This week · Week ${week}`,
  };
}
