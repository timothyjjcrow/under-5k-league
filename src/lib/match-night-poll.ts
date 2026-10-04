// The match-night poll: players mark every weekly start time they could play,
// and the time the most players can make wins. Pure: the slot grid, labels,
// the count and the viewer's-clock conversion. The service
// (match-night-poll-service.ts) stores and claims; this file decides.
//
// A slot is a weekday plus a minute of the day on the LEAGUE's clock
// (LEAGUE_CONFIG.timeZone), never an instant: "Sundays at 6 PM" stays 6 PM
// across daylight saving, the way matchNightForWeek schedules fixtures.
// Pages show every slot on the viewer's own clock; the league's clock is
// what gets stored and announced.

import { zoneLabel } from "./zone-label";
import { dateAtWallTime, wallTime, zoneFormatter } from "./zoned-time";

export type PollSlot = {
  /** 0 = Sunday … 6 = Saturday, as Date.getUTCDay counts. */
  day: number;
  /** Minutes after midnight on the league's clock, 0–1439. */
  minute: number;
};

/** Every day of the week, Monday first. */
export const POLL_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;
/** The grid a new poll offers: every day, on the hour, noon to 6 PM. */
export const POLL_DEFAULT_FROM_HOUR = 12;
export const POLL_DEFAULT_TO_HOUR = 18;
/** Seven days of twelve hourly start times. */
export const POLL_MAX_SLOTS = 84;
/** How long Home keeps showing a poll's result after voting closes. */
export const POLL_RESULT_DAYS = 7;
export const POLL_QUESTION_MAX = 120;
export const DEFAULT_POLL_QUESTION = "When should match night be?";
/** Home's poll card id: where a Discord link to the poll lands. */
export const POLL_ANCHOR = "match-night-poll";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** A slot's stable id inside one poll: "0@1080" is Sunday 18:00. */
export function slotKey(slot: PollSlot): string {
  return `${slot.day}@${slot.minute}`;
}

/** The slot a key names, or null for a key no slot could have. */
export function parseSlotKey(key: string): PollSlot | null {
  const m = /^(\d)@(\d{1,4})$/.exec(key);
  if (!m) return null;
  const slot = { day: Number(m[1]), minute: Number(m[2]) };
  return validSlot(slot.day, slot.minute) ? slot : null;
}

function validSlot(day: unknown, minute: unknown): boolean {
  return (
    Number.isInteger(day) &&
    (day as number) >= 0 &&
    (day as number) <= 6 &&
    Number.isInteger(minute) &&
    (minute as number) >= 0 &&
    (minute as number) < 24 * 60
  );
}

/** Monday first, so the weekend reads as the end of the week. */
function weekOrder(slot: PollSlot): number {
  return ((slot.day + 6) % 7) * 24 * 60 + slot.minute;
}

/**
 * A poll's stored slots (`MatchNightPoll.slots`). Garbage degrades to an
 * empty list rather than throwing, the way `parsePubStats` treats its JSON:
 * one bad row must not take Home down.
 */
export function parseSlots(json: string): PollSlot[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const slots: PollSlot[] = [];
  for (const entry of raw) {
    const day = (entry as { day?: unknown } | null)?.day;
    const minute = (entry as { minute?: unknown } | null)?.minute;
    if (!validSlot(day, minute)) continue;
    const slot = { day: day as number, minute: minute as number };
    if (seen.has(slotKey(slot))) continue;
    seen.add(slotKey(slot));
    slots.push(slot);
  }
  return slots;
}

/**
 * The start times a poll offers: every chosen day, on the hour, from
 * `fromHour` to `toHour` inclusive on the league's clock, Monday first. The
 * admin form posts the days and the two hours; a new poll defaults to every
 * day, noon to 6 PM.
 */
export function gridSlots(input: {
  days: readonly number[];
  fromHour: number;
  toHour: number;
}): { slots: PollSlot[] } | { error: string } {
  const days = POLL_DAYS.filter((day) => input.days.includes(day));
  if (days.length === 0) return { error: "Pick at least one day." };
  const { fromHour, toHour } = input;
  if (
    !Number.isInteger(fromHour) ||
    !Number.isInteger(toHour) ||
    fromHour < 0 ||
    toHour > 23 ||
    fromHour > toHour
  ) {
    return { error: "Pick a start hour no later than the end hour." };
  }
  const slots: PollSlot[] = [];
  for (const day of days) {
    for (let hour = fromHour; hour <= toHour; hour++) {
      slots.push({ day, minute: hour * 60 });
    }
  }
  if (slots.length > POLL_MAX_SLOTS) {
    return { error: `A poll can offer at most ${POLL_MAX_SLOTS} start times.` };
  }
  return { slots };
}

/**
 * A ballot as stored or submitted: the slot keys a voter can play, in poll
 * order. Unknown keys and repeats are dropped, and garbage reads as an empty
 * ballot. (The column is `ranking` because the first version of the poll was
 * ranked choice; order no longer carries meaning.)
 */
export function parseAvailability(
  json: string,
  slots: readonly PollSlot[],
): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  return cleanAvailability(raw, slots);
}

/** `parseAvailability` for an already-decoded value. */
export function cleanAvailability(
  raw: unknown,
  slots: readonly PollSlot[],
): string[] {
  if (!Array.isArray(raw)) return [];
  const picked = new Set(raw.filter((key) => typeof key === "string"));
  return slots.map(slotKey).filter((key) => picked.has(key));
}

/**
 * A poll's slots as a grid: columns are its days (Monday first), rows its
 * start times. `at` finds the slot in a cell, or nothing for a cell the poll
 * doesn't offer.
 */
export function pollGrid<S extends PollSlot & { key: string }>(
  slots: readonly S[],
): { days: number[]; minutes: number[]; at: (day: number, minute: number) => S | undefined } {
  const byKey = new Map(slots.map((slot) => [slotKey(slot), slot]));
  return {
    days: POLL_DAYS.filter((day) => slots.some((slot) => slot.day === day)),
    minutes: [...new Set(slots.map((slot) => slot.minute))].sort((a, b) => a - b),
    at: (day, minute) => byKey.get(slotKey({ day, minute })),
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** "6:00 PM" (en-US) or "18:00" (en-GB): a minute of the day, zone-free. */
export function slotTime(minute: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 2, Math.floor(minute / 60), minute % 60)));
}

/** "6 PM" (en-US) or "18:00" (en-GB): the compact form a grid prints. */
export function slotHour(minute: number, locale?: string): string {
  const format = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    ...(minute % 60 === 0 ? {} : { minute: "2-digit" as const }),
    timeZone: "UTC",
  });
  const text = format.format(
    new Date(Date.UTC(2000, 0, 2, Math.floor(minute / 60), minute % 60)),
  );
  // en-GB prints a bare "18" for an hour; keep it readable as a time.
  return /^\d{1,2}$/.test(text) ? `${text.padStart(2, "0")}:00` : text;
}

/** "Sunday". */
export function slotDayName(slot: Pick<PollSlot, "day">): string {
  return WEEKDAYS[slot.day];
}

/** "Sun". */
export function slotDayShort(slot: Pick<PollSlot, "day">): string {
  return WEEKDAYS[slot.day].slice(0, 3);
}

/**
 * "Sundays at 6:00 PM Pacific time": the shape `fixturesMatchNightLabel`
 * prints for a season's night, so the poll's winner can become the season's
 * match-night text word for word.
 */
export function slotLabel(
  slot: PollSlot,
  timeZone?: string,
  locale?: string,
): string {
  const zone = timeZone ? ` ${zoneLabel(timeZone)}` : "";
  return `${slotDayName(slot)}s at ${slotTime(slot.minute, locale)}${zone}`;
}

/**
 * "Every day, 12 PM–6 PM", "Mon–Fri, 7 PM–10 PM" or "Sat and Sun, 12 PM–6 PM":
 * a full grid in a few words, for Discord and the admin card. Falls back to a
 * count when the slots aren't one rectangle of days by hours.
 */
export function gridSummary(slots: readonly PollSlot[], locale?: string): string {
  if (slots.length === 0) return "no times";
  const days = POLL_DAYS.filter((day) => slots.some((s) => s.day === day));
  const minutes = [...new Set(slots.map((s) => s.minute))].sort((a, b) => a - b);
  const hourly = minutes.every((m, i) => i === 0 || m - minutes[i - 1] === 60);
  if (!hourly || days.length * minutes.length !== slots.length) {
    return `${slots.length} start times`;
  }
  const times =
    minutes.length === 1
      ? slotHour(minutes[0], locale)
      : `${slotHour(minutes[0], locale)}–${slotHour(minutes.at(-1)!, locale)}`;
  const order = days.map((day) => POLL_DAYS.indexOf(day as (typeof POLL_DAYS)[number]));
  const consecutive = order.every((o, i) => i === 0 || o - order[i - 1] === 1);
  const dayText =
    days.length === 7
      ? "Every day"
      : consecutive && days.length > 2
        ? `${slotDayShort({ day: days[0] })}–${slotDayShort({ day: days.at(-1)! })}`
        : days.length === 1
          ? `${slotDayName({ day: days[0] })}s`
          : `${days.slice(0, -1).map((day) => slotDayShort({ day })).join(", ")} and ${slotDayShort({ day: days.at(-1)! })}`;
  return `${dayText}, ${times}${minutes.length > 1 ? ", on the hour" : ""}`;
}

/**
 * Times picked, as compact ranges per day: ["Sat 12 PM–3 PM", "Sun 1 PM"].
 * Consecutive hours on one day join into a range. `entries` may be on any
 * clock (the league's, or the viewer's from `slotInZone`).
 */
export function describeTimes(
  entries: readonly { day: number; minute: number }[],
  locale?: string,
): string[] {
  const sorted = [...entries].sort((a, b) => weekOrder(a) - weekOrder(b));
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let end = start;
    while (
      i + 1 < sorted.length &&
      sorted[i + 1].day === start.day &&
      sorted[i + 1].minute - end.minute === 60
    ) {
      i += 1;
      end = sorted[i];
    }
    const day = slotDayShort(start);
    out.push(
      end === start
        ? `${day} ${slotHour(start.minute, locale)}`
        : `${day} ${slotHour(start.minute, locale)}–${slotHour(end.minute, locale)}`,
    );
    i += 1;
  }
  return out;
}

/**
 * The next time `slot` comes round on `timeZone`'s clock, as an instant. The
 * browser converts it to the viewer's own clock; a slot equal to now counts
 * as next week's.
 */
export function nextSlotOccurrence(
  slot: PollSlot,
  nowMs: number,
  timeZone: string,
): number {
  const formatter = zoneFormatter(timeZone);
  const wall = wallTime(new Date(nowMs), formatter);
  const today = new Date(wall);
  const midnight = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  let target =
    midnight +
    ((slot.day - today.getUTCDay() + 7) % 7) * DAY_MS +
    slot.minute * 60_000;
  if (target <= wall) target += 7 * DAY_MS;
  return dateAtWallTime(target, formatter).getTime();
}

/**
 * An instant as a weekday and minute on `zone`'s clock: where a slot lands
 * for the viewer. Null for a zone Intl can't format (Chrome reports
 * "Etc/Unknown" when it can't map the OS zone), so a strange browser shows
 * the league's clock instead of crashing the grid.
 */
export function slotInZone(
  ms: number,
  zone: string,
): { day: number; minute: number } | null {
  try {
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    const wall = new Date(wallTime(date, zoneFormatter(zone)));
    return {
      day: wall.getUTCDay(),
      minute: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
    };
  } catch {
    return null;
  }
}

/**
 * A slot as one clock reads it, for a grid's row header or a list: the start
 * time, the weekday, and how many days that weekday is from the slot's own
 * column (+1 when 6 PM Pacific Saturday is 3 AM Sunday in Berlin). With no
 * zone (the server, or a browser zone Intl can't read) it is the league's
 * clock unchanged.
 */
export function slotOnClock(
  slot: { day: number; minute: number; nextAt: number },
  zone: string | null,
): { day: number; minute: number; shift: -1 | 0 | 1 } {
  const local = zone ? slotInZone(slot.nextAt, zone) : null;
  if (!local) return { day: slot.day, minute: slot.minute, shift: 0 };
  const ahead = (local.day - slot.day + 7) % 7;
  return { ...local, shift: ahead === 1 ? 1 : ahead === 6 ? -1 : 0 };
}

/**
 * How far the viewer's clock is from the league's at `ms`, in minutes
 * (positive when the viewer is ahead), or null when they agree or the zone
 * is unknown.
 */
export function zoneOffsetMinutes(
  ms: number,
  leagueZone: string,
  viewerZone: string,
): number | null {
  try {
    const date = new Date(ms);
    const diff =
      wallTime(date, zoneFormatter(viewerZone)) -
      wallTime(date, zoneFormatter(leagueZone));
    const minutes = Math.round(diff / 60_000);
    return minutes === 0 ? null : minutes;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Poll state
// ---------------------------------------------------------------------------

export function pollOpen(poll: { closesAt: Date }, nowMs: number): boolean {
  return poll.closesAt.getTime() > nowMs;
}

/**
 * Whether Home shows this poll: while it is open, and for POLL_RESULT_DAYS
 * after it closes so the league sees the result. Older polls stay on /admin.
 */
export function pollOnHome(poll: { closesAt: Date }, nowMs: number): boolean {
  return poll.closesAt.getTime() + POLL_RESULT_DAYS * DAY_MS > nowMs;
}

/**
 * Who sees the count. While voting is open only people who have voted (and
 * admins), so a voter marks the times they can actually make instead of the
 * ones already winning; once it closes, everyone. The count is left out of
 * the page payload for everyone else, not merely hidden.
 */
export function pollResultsVisible(input: {
  open: boolean;
  hasVoted: boolean;
  isAdmin: boolean;
}): boolean {
  return !input.open || input.hasVoted || input.isAdmin;
}

// ---------------------------------------------------------------------------
// The count
// ---------------------------------------------------------------------------

export type AvailabilityResult = {
  /** Every ballot cast, including "none of these work" ones. */
  ballots: number;
  /** Players who can make each slot. */
  counts: Record<string, number>;
  /** Slots best first (see tallyAvailability); every slot appears once. */
  order: string[];
  /** Null when nobody can make any slot. */
  winner: string | null;
};

/**
 * Count availability ballots. The best slot is the one the most players can
 * make. A tie goes to the slot with more players free an hour either side on
 * the same day (a late start or a long series still works), then to the
 * earlier slot in the week. Deterministic, so the same ballots always pick
 * the same night.
 */
export function tallyAvailability(
  slots: readonly PollSlot[],
  ballots: readonly (readonly string[])[],
): AvailabilityResult {
  const keys = slots.map(slotKey);
  const counts: Record<string, number> = Object.fromEntries(
    keys.map((key) => [key, 0]),
  );
  for (const ballot of ballots) {
    for (const key of new Set(ballot)) {
      if (key in counts) counts[key] += 1;
    }
  }
  const countAt = (day: number, minute: number) =>
    counts[slotKey({ day, minute })] ?? 0;
  const neighbours = (slot: PollSlot) =>
    countAt(slot.day, slot.minute - 60) + countAt(slot.day, slot.minute + 60);
  const order = slots
    .map((slot, index) => ({ slot, key: keys[index] }))
    .sort(
      (a, b) =>
        counts[b.key] - counts[a.key] ||
        neighbours(b.slot) - neighbours(a.slot) ||
        weekOrder(a.slot) - weekOrder(b.slot),
    )
    .map(({ key }) => key);
  const winner = order.length > 0 && counts[order[0]] > 0 ? order[0] : null;
  return { ballots: ballots.length, counts, order, winner };
}

// ---------------------------------------------------------------------------
// The page's view of a poll
// ---------------------------------------------------------------------------

export type PollSlotView = PollSlot & {
  key: string;
  /** "Sundays at 6:00 PM Pacific time". */
  label: string;
  /** The next time the slot comes round, for converting to the viewer's clock. */
  nextAt: number;
};

export type PollElectorate = {
  seasonName: string;
  /** The season still takes signups (players or standins), so a viewer who
   *  isn't signed up has somewhere to go. */
  signupsOpen: boolean;
};

export type PollView = {
  id: string;
  question: string;
  closesAt: number;
  open: boolean;
  /** The league's zone, "America/Los_Angeles": the clock slots are stored on. */
  timeZone: string;
  slots: PollSlotView[];
  /** "Every day, 12 PM–6 PM, on the hour". */
  summary: string;
  ballots: number;
  /** Ballots that mark nothing: "none of these work for me". */
  noneOfThese: number;
  /** The viewer's marked slots, or null when they haven't voted. */
  myAvailability: string[] | null;
  /** When the viewer last saved, so a fresh save remounts the grid. */
  myBallotAt: number | null;
  /** The count, only for viewers allowed to see it (pollResultsVisible). */
  results: AvailabilityResult | null;
  /** Whose votes count: the voting season's signed-up players. */
  electorate: PollElectorate | null;
  /** The signed-in viewer is signed up for that season, so may vote. */
  canVote: boolean;
};

/**
 * Everything a page needs to draw one poll for one viewer. The count is
 * computed for everyone but handed over only when pollResultsVisible says
 * so; nothing in the view says who marked what.
 */
export function buildPollView(input: {
  poll: { id: string; question: string; slots: string; closesAt: Date };
  ballots: readonly { userId: string; ranking: string; updatedAt: Date }[];
  viewerId: string | null;
  isAdmin: boolean;
  electorate: PollElectorate | null;
  canVote: boolean;
  nowMs: number;
  timeZone: string;
  locale?: string;
}): PollView {
  const { poll, ballots, viewerId, nowMs, timeZone, locale } = input;
  const slots = parseSlots(poll.slots);
  const marks = ballots.map((b) => parseAvailability(b.ranking, slots));
  const mine = viewerId
    ? ballots.findIndex((b) => b.userId === viewerId)
    : -1;
  const open = pollOpen(poll, nowMs);
  const visible = pollResultsVisible({
    open,
    hasVoted: mine !== -1,
    isAdmin: input.isAdmin,
  });
  return {
    id: poll.id,
    question: poll.question,
    closesAt: poll.closesAt.getTime(),
    open,
    timeZone,
    slots: slots.map((slot) => ({
      ...slot,
      key: slotKey(slot),
      label: slotLabel(slot, timeZone, locale),
      nextAt: nextSlotOccurrence(slot, nowMs, timeZone),
    })),
    summary: gridSummary(slots, locale),
    ballots: ballots.length,
    noneOfThese: marks.filter((m) => m.length === 0).length,
    myAvailability: mine === -1 ? null : marks[mine],
    myBallotAt: mine === -1 ? null : ballots[mine].updatedAt.getTime(),
    results: visible ? tallyAvailability(slots, marks) : null,
    electorate: input.electorate,
    canVote: !!viewerId && input.canVote,
  };
}

/**
 * Whether a season still takes a signup of some kind: full signups during
 * SIGNUPS, standin registration through the draft, regular season and
 * playoffs. An archived season takes none.
 */
export function pollSignupsOpen(season: { isActive: boolean; status: string }): boolean {
  return season.isActive && season.status !== "COMPLETE";
}
