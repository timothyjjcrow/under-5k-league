// Pure "I'm away" date-range logic: which of a player's fixtures a range
// covers, what happens to each one, and how the result is reported.
//
// Browser-safe on purpose — the /me card previews the range with the same
// `inAwayRange` the action writes with, so the list a player sees before
// saving is the list the server judges.

import {
  AVAILABILITY,
  CHECKIN_REFUSAL,
  type CheckinRefusal,
} from "./availability";
import { MATCH_STATUS } from "./constants";
import { matchPhaseLabel } from "./schedule";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Longest range one save accepts. A break longer than a season is a
 *  conversation with the captain, not a form. */
export const AWAY_RANGE_MAX_DAYS = 90;

/** How many fixture names a toast lists before it says "and N more". */
const LIST_MAX = 5;

/** `[fromMs, backMs)`: from the start of the day they leave, up to (not
 *  including) the start of the day they are back. */
export type AwayRange = { fromMs: number; backMs: number };

/**
 * Local midnight of a `YYYY-MM-DD` date-input value, in the zone of whatever
 * runs it. Call it in the BROWSER: the server's zone is UTC in production, so
 * the same string there lands hours away from the day the player meant
 * (the LocalDatetimeField rule, for a date-only input).
 */
export function localDayStartMs(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  // `new Date` rolls "Feb 31" into March and maps years below 100 onto the
  // 1900s; either way it is not the day that was typed.
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d
  ) {
    return null;
  }
  return date.getTime();
}

function epochField(raw: string): number | null {
  if (!/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * What's wrong with a pair of day starts, or null when they make a range.
 * Shared by the card's live preview and the action, so the button can't
 * offer a range the server will refuse (the server adds "already over",
 * which needs a clock the render mustn't read).
 */
export function awayRangeProblem(
  fromMs: number | null,
  backMs: number | null,
): string | null {
  if (fromMs == null || backMs == null) {
    return "Pick the day you leave and the day you're back.";
  }
  if (backMs <= fromMs) {
    return "The day you're back has to be after the day you leave.";
  }
  // An hour of slack: a local-midnight range that crosses a clock change is
  // an hour longer or shorter than a whole number of days.
  if (backMs - fromMs > AWAY_RANGE_MAX_DAYS * DAY_MS + 60 * 60 * 1000) {
    return `Pick ${AWAY_RANGE_MAX_DAYS} days or fewer. For a longer break, talk to your captain.`;
  }
  return null;
}

/** Validate the two browser-computed epochs an away form submits. */
export function parseAwayRange(
  fromRaw: string,
  backRaw: string,
  nowMs: number,
): { range: AwayRange } | { error: string } {
  const fromMs = epochField(fromRaw.trim());
  const backMs = epochField(backRaw.trim());
  const problem = awayRangeProblem(fromMs, backMs);
  if (problem) return { error: problem };
  if (backMs! <= nowMs) return { error: "Those dates are already over." };
  return { range: { fromMs: fromMs!, backMs: backMs! } };
}

export function inAwayRange(kickoffMs: number, range: AwayRange): boolean {
  return kickoffMs >= range.fromMs && kickoffMs < range.backMs;
}

/** The fixtures a range covers, kickoff order preserved. */
export function fixturesInAwayRange<T extends { kickoffMs: number }>(
  fixtures: T[],
  range: AwayRange | null,
): T[] {
  return range ? fixtures.filter((f) => inAwayRange(f.kickoffMs, range)) : [];
}

/**
 * What the page showed for one fixture. The revision is the scheduleRevision
 * setAvailability's `expectedScheduleRevision` carries: an OUT is only ever
 * written for the kickoff the player actually saw.
 */
export type SeenFixture = {
  matchId: string;
  scheduleRevision: number;
  kickoffMs: number;
};

/** One fixture on the /me "Away dates" card. */
export type AwayCardFixture = SeenFixture & {
  label: string;
  /** Cover the player is booked for, rather than their own roster's game. */
  standin: boolean;
  /** Their answer for the current kickoff. */
  rsvp: string | null;
};

const SEEN_MAX = 200;

export function seenFixturesField(fixtures: SeenFixture[]): string {
  return fixtures
    .map((f) => `${f.matchId}:${f.scheduleRevision}:${f.kickoffMs}`)
    .join(",");
}

/** Parse the card's hidden `seen` field; malformed entries are dropped. */
export function parseSeenFixtures(raw: string): Map<string, SeenFixture> {
  const out = new Map<string, SeenFixture>();
  for (const token of raw.split(",").slice(0, SEEN_MAX)) {
    const m = /^([A-Za-z0-9_-]{1,64}):(0|[1-9]\d{0,8}):(\d{1,15})$/.exec(
      token.trim(),
    );
    if (!m) continue;
    const kickoffMs = Number(m[3]);
    if (!Number.isSafeInteger(kickoffMs)) continue;
    out.set(m[1], {
      matchId: m[1],
      scheduleRevision: Number(m[2]),
      kickoffMs,
    });
  }
  return out;
}

/** Why a covered fixture was left alone. The check-in refusals plus three
 *  that only a range can hit. */
export const AWAY_SKIP = {
  ...CHECKIN_REFUSAL,
  LIVE: "LIVE",
  KICKOFF_CHANGED: "KICKOFF_CHANGED",
  UNSEEN: "UNSEEN",
} as const;

export type AwaySkip = (typeof AWAY_SKIP)[keyof typeof AWAY_SKIP];

export const AWAY_SKIP_LABEL: Record<AwaySkip, string> = {
  FINISHED: "already played",
  PHASE: "check-in isn't open",
  KICKOFF_PASSED: "kickoff has passed",
  NO_KICKOFF: "no kickoff time",
  COVERED: "a standin covers your seat",
  NOT_PLAYING: "not yours",
  WITHDRAWN: "team withdrew",
  INELIGIBLE: "your roster spot changed",
  LIVE: "already under way",
  KICKOFF_CHANGED: "kickoff moved, reload to check it",
  UNSEEN: "new since you opened the page, reload to include it",
};

export type AwayOutcome =
  | { kind: "ignore" }
  | { kind: "mark" }
  | { kind: "already-out" }
  | { kind: "skip"; reason: AwaySkip };

export type AwayScheduleFacts = {
  /** What the page showed, when it listed this fixture. */
  seen: SeenFixture | undefined;
  status: string;
  scheduleRevision: number;
  kickoffMs: number | null;
  /** `checkinClosedReason` for this fixture right now. */
  closedReason: CheckinRefusal | null;
};

/**
 * The fixture-level verdict, before anyone asks which seat the player holds.
 * `null` means "check the seat" (awaySeatVerdict) — the one part that needs
 * the database, so it only runs for fixtures that could still be marked.
 *
 * A fixture counts when EITHER its kickoff now OR the kickoff the page showed
 * falls in the range: a retime in either direction is reported rather than
 * silently marked or silently dropped.
 */
export function awayScheduleVerdict(
  f: AwayScheduleFacts,
  range: AwayRange,
  nowMs: number,
): AwayOutcome | null {
  const coversNow = f.kickoffMs != null && inAwayRange(f.kickoffMs, range);
  const coveredOnPage = !!f.seen && inAwayRange(f.seen.kickoffMs, range);
  if (!coversNow && !coveredOnPage) return { kind: "ignore" };
  if (f.closedReason) return { kind: "skip", reason: f.closedReason };
  // matchCheckinOpen lets a LIVE series answer "ready for the next game";
  // being away is about nights that haven't started.
  if (f.status !== MATCH_STATUS.SCHEDULED) {
    return { kind: "skip", reason: AWAY_SKIP.LIVE };
  }
  if (f.seen && f.seen.scheduleRevision !== f.scheduleRevision) {
    return { kind: "skip", reason: AWAY_SKIP.KICKOFF_CHANGED };
  }
  // Stricter than check-in, which stays open through the result window: a
  // kickoff that has already gone by is a result to report, not a night to
  // miss, and an OUT now would ping the captain about a game under way.
  if (f.kickoffMs == null || f.kickoffMs < nowMs) {
    return { kind: "skip", reason: AWAY_SKIP.KICKOFF_PASSED };
  }
  return null;
}

/** The verdict for a fixture that passed awayScheduleVerdict. */
export function awaySeatVerdict(f: {
  seen: SeenFixture | undefined;
  seatRefusal: CheckinRefusal | null;
  /** The player's answer at the CURRENT scheduleRevision, if any. */
  priorStatus: string | null;
}): AwayOutcome {
  if (f.seatRefusal) return { kind: "skip", reason: f.seatRefusal };
  // Theirs, in range, but the page never showed it (a booking or signing
  // after it loaded): never answer for a fixture the player didn't see.
  if (!f.seen) return { kind: "skip", reason: AWAY_SKIP.UNSEEN };
  if (f.priorStatus === AVAILABILITY.OUT) return { kind: "already-out" };
  return { kind: "mark" };
}

/** "Week 3 vs Radiant Rejects" — one fixture, from the viewer's side. */
export function awayFixtureLabel(
  phase: string,
  week: number,
  opponentName: string,
): string {
  return `${matchPhaseLabel(phase, week)} vs ${opponentName}`;
}

export type AwayFixtureRef = { matchId: string; label: string };

export type AwayRangeReport = {
  marked: AwayFixtureRef[];
  alreadyOut: AwayFixtureRef[];
  skipped: (AwayFixtureRef & { reason: AwaySkip })[];
  /** Fixtures the page showed in range that are no longer on the schedule. */
  gone: number;
};

function listOf(items: string[]): string {
  const shown = items.slice(0, LIST_MAX);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The toast. An error when nothing is (or already was) marked, so the form
 * keeps its dates for a second try; otherwise one message naming every
 * fixture and, for the skipped ones, why.
 */
export function awayRangeResult(
  r: AwayRangeReport,
): { message: string } | { error: string } {
  const goneNote =
    r.gone > 0
      ? `${plural(r.gone, "fixture")} you saw ${r.gone === 1 ? "is" : "are"} no longer on the schedule. Reload the page.`
      : "";
  const skippedNote = r.skipped.length
    ? `Skipped ${listOf(r.skipped.map((s) => `${s.label} (${AWAY_SKIP_LABEL[s.reason]})`))}.`
    : "";
  if (r.marked.length === 0 && r.alreadyOut.length === 0) {
    if (!skippedNote && !goneNote) {
      return { error: "None of your fixtures fall between those dates." };
    }
    return {
      error: ["Nothing was marked.", skippedNote, goneNote]
        .filter(Boolean)
        .join(" "),
    };
  }
  const parts: string[] = [];
  if (r.marked.length) {
    parts.push(
      `Marked you out for ${plural(r.marked.length, "fixture")}: ${listOf(r.marked.map((f) => f.label))}.`,
    );
  }
  if (r.alreadyOut.length) {
    parts.push(
      r.marked.length
        ? `Already out: ${listOf(r.alreadyOut.map((f) => f.label))}.`
        : `You were already out for ${listOf(r.alreadyOut.map((f) => f.label))}. Nothing changed.`,
    );
  }
  if (skippedNote) parts.push(skippedNote);
  if (goneNote) parts.push(goneNote);
  if (r.marked.length) parts.push("Captains can now line up cover.");
  return { message: parts.join(" ") };
}
