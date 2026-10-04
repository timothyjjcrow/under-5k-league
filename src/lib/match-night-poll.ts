// The match-night poll: a ranked-choice vote on the league's weekly slot.
// Pure: the slot model, the labels, and the instant-runoff count that turns
// ranked ballots into one winner. The service (match-night-poll-service.ts)
// stores and claims; this file decides.
//
// A slot is a weekday plus a minute of the day on the LEAGUE's clock
// (LEAGUE_CONFIG.timeZone), never an instant: "Sundays at 6 PM" stays 6 PM
// across daylight saving, the way matchNightForWeek schedules fixtures. A
// ballot is the slots a voter can make, best first; a slot left off means
// "I can't play then".

import { zoneLabel } from "./zone-label";
import { dateAtWallTime, wallTime, zoneFormatter } from "./zoned-time";

export type PollSlot = {
  /** 0 = Sunday … 6 = Saturday, as Date.getUTCDay counts. */
  day: number;
  /** Minutes after midnight on the league's clock, 0–1439. */
  minute: number;
};

/** Fewest and most slots a poll may offer. */
export const POLL_MIN_SLOTS = 2;
export const POLL_MAX_SLOTS = 10;
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

/** "19:30" (an `<input type="time">` value) as minutes, or null. */
export function parseTimeOfDay(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * The admin's slot rows (parallel weekday and time fields) as a poll's
 * slots, Monday first. Blank rows are skipped, so the form can offer spare
 * rows; a half-filled row, a repeat or a count outside the limits is refused
 * by name instead of being dropped, so the poll never offers fewer slots than
 * the admin thinks it does.
 */
export function parseSlotRows(
  days: readonly string[],
  times: readonly string[],
): { slots: PollSlot[] } | { error: string } {
  const slots: PollSlot[] = [];
  const seen = new Set<string>();
  const rows = Math.max(days.length, times.length);
  for (let i = 0; i < rows; i++) {
    const dayRaw = (days[i] ?? "").trim();
    const timeRaw = (times[i] ?? "").trim();
    if (!dayRaw && !timeRaw) continue;
    if (!dayRaw || !timeRaw) {
      return { error: `Slot ${i + 1} needs both a day and a time.` };
    }
    const day = Number(dayRaw);
    const minute = parseTimeOfDay(timeRaw);
    if (minute === null || !validSlot(day, minute)) {
      return { error: `Slot ${i + 1} isn't a real day and time.` };
    }
    const slot = { day, minute };
    if (seen.has(slotKey(slot))) {
      return { error: `${slotLabel(slot)} is listed twice.` };
    }
    seen.add(slotKey(slot));
    slots.push(slot);
  }
  if (slots.length < POLL_MIN_SLOTS) {
    return { error: `Offer at least ${POLL_MIN_SLOTS} slots to vote between.` };
  }
  if (slots.length > POLL_MAX_SLOTS) {
    return { error: `A poll can offer at most ${POLL_MAX_SLOTS} slots.` };
  }
  return { slots: [...slots].sort((a, b) => weekOrder(a) - weekOrder(b)) };
}

/**
 * A ballot as stored or submitted: slot keys, best first. Unknown keys and
 * repeats are dropped (a repeat keeps its higher rank), and garbage reads as
 * an empty ballot.
 */
export function parseRanking(
  json: string,
  slots: readonly PollSlot[],
): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  return cleanRanking(raw, slots);
}

/** `parseRanking` for an already-decoded value. */
export function cleanRanking(raw: unknown, slots: readonly PollSlot[]): string[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(slots.map(slotKey));
  const ranking: string[] = [];
  for (const key of raw) {
    if (typeof key !== "string" || !known.has(key) || ranking.includes(key)) {
      continue;
    }
    ranking.push(key);
  }
  return ranking;
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

/** "Sunday". */
export function slotDayName(slot: PollSlot): string {
  return WEEKDAYS[slot.day];
}

/** "Sun". */
export function slotDayShort(slot: PollSlot): string {
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
 * What a weekly slot is on the viewer's clock: "Mon 3:00 AM your time", or
 * null when both clocks read the same weekday and time (nothing to tell
 * them). Null too for a zone Intl can't format, so a browser reporting
 * "Etc/Unknown" loses a hint line, not the ballot.
 */
export function yourSlotTime(
  ms: number,
  timeZone: string,
  viewerZone: string,
  locale?: string,
): string | null {
  try {
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    const league = wallTime(date, zoneFormatter(timeZone));
    const yours = wallTime(date, zoneFormatter(viewerZone));
    if (league === yours) return null;
    const when = new Intl.DateTimeFormat(locale, {
      timeZone: viewerZone,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    return `${when} your time`;
  } catch {
    return null;
  }
}

/** "1st", "2nd", "3rd", "4th" … for a ballot position (1-based). */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
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
 * Who sees the standings. While voting is open only people who have voted
 * (and admins), so a voter ranks what they can make instead of piling onto
 * the leader; once it closes, everyone. The tally is left out of the page
 * payload for everyone else, not merely hidden.
 */
export function pollResultsVisible(input: {
  open: boolean;
  hasVoted: boolean;
  isAdmin: boolean;
}): boolean {
  return !input.open || input.hasVoted || input.isAdmin;
}

// ---------------------------------------------------------------------------
// Instant runoff
// ---------------------------------------------------------------------------

/** Which rule picked the slot to drop when the bottom of a round was tied. */
export type RunoffTiebreak = "earlier-round" | "reach" | "order";

export type RunoffRound = {
  /** Votes for each slot still standing this round, in poll order. */
  tallies: { key: string; votes: number }[];
  /** Ballots with no standing slot left on them (empty ballots included). */
  exhausted: number;
  /** Slots knocked out after this round; empty on the deciding round. */
  eliminated: string[];
  /** Set when the fewest votes were tied and a rule chose who went. */
  tiebreak: RunoffTiebreak | null;
};

export type RunoffResult = {
  /** Every ballot cast, including "none of these work" ones. */
  ballots: number;
  rounds: RunoffRound[];
  /** Null only when no ballot ranks anything. */
  winner: string | null;
  /** Ballots that rank each slot at all: how many can make it. */
  reach: Record<string, number>;
};

/**
 * Count ranked ballots by instant runoff.
 *
 * Each round, every ballot counts for its highest-ranked slot still standing.
 * A slot with more than half of those counted ballots wins. Otherwise the
 * slot with the fewest votes is dropped and its ballots move to their next
 * choice; a ballot with no choice left is exhausted and stops counting, so
 * the majority is of the ballots still in play.
 *
 * Slots on zero votes drop together (they carry no ballots, so dropping them
 * one by one would land in the same place). A tie for fewest is broken, in
 * order, by fewer votes in the latest earlier round that separates them, by
 * fewer ballots ranking the slot at all, and finally by poll order (the slot
 * listed later drops). Every rule is deterministic, so the same ballots
 * always crown the same slot, and the round says which rule decided.
 */
export function instantRunoff(
  slotKeys: readonly string[],
  ballots: readonly (readonly string[])[],
): RunoffResult {
  const known = new Set(slotKeys);
  const clean = ballots.map((ballot) => {
    const seen = new Set<string>();
    return ballot.filter((key) => {
      if (!known.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  const reach: Record<string, number> = Object.fromEntries(
    slotKeys.map((key) => [key, 0]),
  );
  for (const ballot of clean) for (const key of ballot) reach[key] += 1;

  const result: RunoffResult = {
    ballots: clean.length,
    rounds: [],
    winner: null,
    reach,
  };
  if (!clean.some((ballot) => ballot.length > 0)) return result;

  let standing = [...new Set(slotKeys)];
  for (;;) {
    const live = new Set(standing);
    const votes = new Map(standing.map((key) => [key, 0]));
    let exhausted = 0;
    for (const ballot of clean) {
      const top = ballot.find((key) => live.has(key));
      if (top === undefined) exhausted += 1;
      else votes.set(top, (votes.get(top) ?? 0) + 1);
    }
    const round: RunoffRound = {
      tallies: standing.map((key) => ({ key, votes: votes.get(key) ?? 0 })),
      exhausted,
      eliminated: [],
      tiebreak: null,
    };
    result.rounds.push(round);

    const counted = clean.length - exhausted;
    const leader = round.tallies.reduce((best, t) =>
      t.votes > best.votes ? t : best,
    );
    if (standing.length === 1 || leader.votes * 2 > counted) {
      result.winner = leader.key;
      return result;
    }

    const zero = standing.filter((key) => votes.get(key) === 0);
    if (zero.length > 0) {
      round.eliminated = zero;
    } else {
      const fewest = Math.min(...standing.map((key) => votes.get(key) ?? 0));
      let bottom = standing.filter((key) => votes.get(key) === fewest);
      if (bottom.length > 1) {
        // The latest earlier round that separates them, then the next one
        // back, narrowing the tie each time.
        for (let r = result.rounds.length - 2; r >= 0 && bottom.length > 1; r--) {
          const tally = new Map(
            result.rounds[r].tallies.map((t) => [t.key, t.votes]),
          );
          const low = Math.min(...bottom.map((key) => tally.get(key) ?? 0));
          const narrowed = bottom.filter((key) => (tally.get(key) ?? 0) === low);
          if (narrowed.length < bottom.length) {
            bottom = narrowed;
            round.tiebreak = "earlier-round";
          }
        }
      }
      if (bottom.length > 1) {
        const low = Math.min(...bottom.map((key) => reach[key]));
        const narrowed = bottom.filter((key) => reach[key] === low);
        if (narrowed.length < bottom.length) {
          bottom = narrowed;
          round.tiebreak = "reach";
        }
      }
      if (bottom.length > 1) {
        bottom = [bottom[bottom.length - 1]];
        round.tiebreak = "order";
      }
      round.eliminated = bottom;
    }
    const out = new Set(round.eliminated);
    standing = standing.filter((key) => !out.has(key));
  }
}

/**
 * The slots in finishing order: the winner, then whoever lasted longest, so
 * a results list reads top to bottom as the count played out. Slots that
 * went out in the same round are ordered by their votes in that round, then
 * by poll order. Every slot appears once, including when nobody voted.
 */
export function runoffPlacement(
  slotKeys: readonly string[],
  result: RunoffResult,
): string[] {
  const outRound = new Map<string, number>();
  const lastVotes = new Map<string, number>();
  result.rounds.forEach((round, index) => {
    for (const t of round.tallies) lastVotes.set(t.key, t.votes);
    for (const key of round.eliminated) outRound.set(key, index);
  });
  const lasted = (key: string) =>
    key === result.winner
      ? Number.POSITIVE_INFINITY
      : (outRound.get(key) ?? result.rounds.length - 1);
  return slotKeys
    .map((key, index) => ({ key, index }))
    .sort(
      (a, b) =>
        lasted(b.key) - lasted(a.key) ||
        (lastVotes.get(b.key) ?? 0) - (lastVotes.get(a.key) ?? 0) ||
        a.index - b.index,
    )
    .map(({ key }) => key);
}

/** The round a slot went out in (0-based), or null if it never did. */
export function eliminatedInRound(
  result: RunoffResult,
  key: string,
): number | null {
  const index = result.rounds.findIndex((round) => round.eliminated.includes(key));
  return index === -1 ? null : index;
}

/**
 * Where a dropped slot's ballots went in the next round: the votes each
 * still-standing slot gained, and how many ran out of choices. Empty for the
 * deciding round.
 */
export function roundTransfers(
  result: RunoffResult,
  roundIndex: number,
): { gained: { key: string; votes: number }[]; exhausted: number } {
  const round = result.rounds[roundIndex];
  const next = result.rounds[roundIndex + 1];
  if (!round || !next) return { gained: [], exhausted: 0 };
  const before = new Map(round.tallies.map((t) => [t.key, t.votes]));
  return {
    gained: next.tallies
      .map((t) => ({ key: t.key, votes: t.votes - (before.get(t.key) ?? 0) }))
      .filter((t) => t.votes > 0),
    exhausted: next.exhausted - round.exhausted,
  };
}

/** The plain-words reason a tiebreak picked the slot it dropped. */
export function tiebreakReason(tiebreak: RunoffTiebreak): string {
  switch (tiebreak) {
    case "earlier-round":
      return "it had fewer votes in an earlier round";
    case "reach":
      return "fewer voters ranked it at all";
    case "order":
      return "it was still tied after every other check, and it's listed later in the poll";
  }
}

// ---------------------------------------------------------------------------
// The page's view of a poll
// ---------------------------------------------------------------------------

export type PollSlotView = {
  key: string;
  /** "Sundays at 6:00 PM Pacific time". */
  label: string;
  /** "Sundays". */
  days: string;
  /** "Sun". */
  dayShort: string;
  /** "6:00 PM", on the league's clock. */
  time: string;
  /** The next time the slot comes round, for the viewer's-clock hint. */
  nextAt: number;
};

export type PollView = {
  id: string;
  question: string;
  closesAt: number;
  open: boolean;
  slots: PollSlotView[];
  ballots: number;
  /** Ballots that rank nothing: "none of these work for me". */
  noneOfThese: number;
  /** The viewer's ranking, or null when they haven't voted. */
  myRanking: string[] | null;
  /** When the viewer last saved, so a fresh save remounts the ballot. */
  myBallotAt: number | null;
  /** The count, only for viewers allowed to see it (pollResultsVisible). */
  results: RunoffResult | null;
  /** Whose votes count: the voting season's signed-up players. */
  electorate: PollElectorate | null;
  /** The signed-in viewer is signed up for that season, so may vote. */
  canVote: boolean;
};

export type PollElectorate = {
  seasonName: string;
  /** The season still takes signups (players or standins), so a viewer who
   *  isn't signed up has somewhere to go. */
  signupsOpen: boolean;
};

/**
 * Everything a page needs to draw one poll for one viewer. The tally is
 * computed for everyone but handed over only when pollResultsVisible says
 * so; nothing in the view says who ranked what.
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
  const keys = slots.map(slotKey);
  const rankings = ballots.map((b) => parseRanking(b.ranking, slots));
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
    slots: slots.map((slot) => ({
      key: slotKey(slot),
      label: slotLabel(slot, timeZone, locale),
      days: `${slotDayName(slot)}s`,
      dayShort: slotDayShort(slot),
      time: slotTime(slot.minute, locale),
      nextAt: nextSlotOccurrence(slot, nowMs, timeZone),
    })),
    ballots: ballots.length,
    noneOfThese: rankings.filter((r) => r.length === 0).length,
    myRanking: mine === -1 ? null : rankings[mine],
    myBallotAt: mine === -1 ? null : ballots[mine].updatedAt.getTime(),
    results: visible ? instantRunoff(keys, rankings) : null,
    electorate: input.electorate,
    canVote: !!viewerId && input.canVote,
  };
}

// ---------------------------------------------------------------------------
// Who may vote
// ---------------------------------------------------------------------------

/**
 * Whether a season still takes a signup of some kind: full signups during
 * SIGNUPS, standin registration through the draft, regular season and
 * playoffs. An archived season takes none.
 */
export function pollSignupsOpen(season: { isActive: boolean; status: string }): boolean {
  return season.isActive && season.status !== "COMPLETE";
}

/** "A", "A and B", "A, B and C". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One round of the count in a sentence, for the results chart's caption:
 * who was dropped and where their ballots went, or, on the last round, who
 * won (or leads, while voting is open) and by how much. `name` turns a slot
 * key into the short name the chart prints.
 */
export function roundStory(input: {
  result: RunoffResult;
  round: number;
  open: boolean;
  name: (key: string) => string;
}): string {
  const { result, round, open, name } = input;
  const current = result.rounds[round];
  if (!current) return "";
  const counted = result.ballots - current.exhausted;
  if (round === result.rounds.length - 1 && result.winner) {
    const votes =
      current.tallies.find((t) => t.key === result.winner)?.votes ?? 0;
    const pct = counted > 0 ? Math.round((votes / counted) * 100) : 0;
    const runoffs = result.rounds.length - 1;
    return `${name(result.winner)} ${open ? "leads" : "wins"} with ${votes} of the ${plural(counted, "ballot")} in play (${pct}%)${
      runoffs === 0
        ? ", a majority on first choices."
        : ` after ${plural(runoffs, "runoff round")}.`
    }`;
  }
  const need = Math.floor(counted / 2) + 1;
  const out = current.eliminated.map(name);
  let story = `No slot has a majority yet: it takes ${need} of the ${plural(counted, "ballot")} in play.`;
  const votesOf = (key: string) =>
    current.tallies.find((t) => t.key === key)?.votes ?? 0;
  if (current.eliminated.every((key) => votesOf(key) === 0)) {
    return `${story} ${listOf(out)} ${out.length === 1 ? "has no first-choice votes and drops" : "have no first-choice votes and drop"} out.`;
  }
  story += current.tiebreak
    ? ` ${listOf(out)} drops out: it tied for the fewest votes, and ${tiebreakReason(current.tiebreak)}.`
    : ` ${listOf(out)} has the fewest votes and drops out.`;
  const moves = roundTransfers(result, round);
  const moved =
    moves.gained.reduce((sum, g) => sum + g.votes, 0) + moves.exhausted;
  if (moved > 0) {
    const parts = moves.gained.map((g) => `${g.votes} to ${name(g.key)}`);
    if (moves.exhausted > 0) parts.push(`${moves.exhausted} with no choice left`);
    story += ` Its ${plural(moved, "ballot")} ${moved === 1 ? "moves" : "move"} on: ${listOf(parts)}.`;
  }
  return story;
}
