// The roll call: before the season's first match night, every player signed
// up for the draft taps "I'm in" on Home to say they can play the season's
// match night every week and will play for whichever team drafts them. An
// admin opens it from /admin; Home lists who is in and who hasn't answered.
// Pure: reading the night, matching an answer to it, and the card's view.
// The service (roll-call-service.ts) stores; this file decides.
//
// The night is the season's own (announcedMatchNight), read every time,
// never a copy: an answer stores the night as the card printed it, and once
// the season's night changes that answer no longer counts and the player is
// asked again.

import { SEASON_STATUS } from "./constants";
import { slotKey, slotLabel, type PollSlot, type PollSlotView } from "./match-night-poll";
import { zoneName } from "./zone-label";

/** Home's roll-call card id: where a link to the roll call lands. */
export const ROLL_CALL_ANCHOR = "roll-call";

/**
 * The phases a roll call runs in: signups and the draft, before the first
 * match night. From the regular season on, the weekly match check-in asks
 * each rostered player about each match instead.
 */
export function rollCallPhase(status: string): boolean {
  return status === SEASON_STATUS.SIGNUPS || status === SEASON_STATUS.DRAFT;
}

/**
 * Whether the roll call is up: an admin opened it, the season is in a phase
 * it runs in, and there is a settled night to agree to (one is announced and
 * no match-night poll is still deciding it). Home shows the card and the
 * answer action accepts only while this holds.
 */
export function rollCallLive(input: {
  status: string;
  openedAt: Date | null;
  night: string | null;
  pollDecidesNight: boolean;
}): boolean {
  return (
    input.openedAt != null &&
    rollCallPhase(input.status) &&
    input.night != null &&
    !input.pollDecidesNight
  );
}

/**
 * Why an admin can't open the roll call now, or null when they can. The
 * admin section shows the button only when this is null, and the action
 * refuses with the same words.
 */
export function rollCallCannotOpen(input: {
  status: string;
  night: string | null;
  pollDecidesNight: boolean;
}): string | null {
  if (!rollCallPhase(input.status)) {
    return "The roll call runs during signups and the draft, before the first match night.";
  }
  if (input.pollDecidesNight) {
    return "A match-night poll is still deciding the night. Close it and set the season's match night first.";
  }
  if (!input.night) {
    return "Set the season's match night first, under Season settings.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading the night
// ---------------------------------------------------------------------------

const DAY_WORDS: Record<string, number> = {};
for (const [day, names] of [
  ["sunday", "sun"],
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday", "wed"],
  ["thursday", "thu", "thur", "thurs"],
  ["friday", "fri"],
  ["saturday", "sat"],
].entries()) {
  for (const name of names) {
    DAY_WORDS[name] = day;
    DAY_WORDS[`${name}s`] = day;
  }
}

const FILLER_WORDS = new Set(["at", "on", "every", "each", "from", "the", "time"]);

/**
 * The words a night's text may use for the league's own zone: its plain name
 * ("Pacific", "Berlin") and the names Intl gives it in either league's
 * locale, summer and winter ("PST", "PDT", "PT", "Pacific Standard Time",
 * "CET", "CEST"). Offsets like "GMT-8" are left out.
 */
function zoneWords(timeZone: string): Set<string> {
  const words = new Set(zoneName(timeZone).toLowerCase().split(/\s+/));
  for (const locale of ["en-US", "en-GB"]) {
    for (const month of [0, 6]) {
      for (const timeZoneName of ["short", "shortGeneric", "long"] as const) {
        try {
          const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName })
            .formatToParts(new Date(Date.UTC(2026, month, 15, 12)))
            .find((p) => p.type === "timeZoneName")?.value;
          if (!part || /\d/.test(part)) continue;
          for (const word of part.toLowerCase().split(/\s+/)) words.add(word);
        } catch {
          // A zone or style Intl can't format adds nothing.
        }
      }
    }
  }
  return words;
}

const zoneWordCache = new Map<string, Set<string>>();

/**
 * The season's night as a weekday and a minute on the league's clock, or
 * null when the text doesn't say exactly one: "Saturdays at 2:00 PM Pacific
 * time" (the shape every page prints) is Saturday 14:00, and so are
 * "Saturday 2pm PT" and "Sat 2:00 p.m.". Strict on purpose: a text that names
 * another zone ("2 PM EST" in a Pacific league), two times, two days or
 * anything else is null, and the card prints it as typed without converting
 * it, since a wrong conversion is worse than none. Without AM or PM a time
 * reads as 24-hour only where that can't be misread: on a 24-hour league
 * clock ("20:00"), or from 13:00 or with a leading zero.
 */
export function parseMatchNight(
  text: string | null | undefined,
  timeZone: string,
  locale: string,
): PollSlot | null {
  if (!text) return null;
  let zone = zoneWordCache.get(timeZone);
  if (!zone) {
    zone = zoneWords(timeZone);
    zoneWordCache.set(timeZone, zone);
  }
  const words = text
    .toLowerCase()
    .replace(/\b([ap])\.m\.?/g, "$1m")
    .replace(/[,;!?()–—]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/\.+$/, "").replace(/'s$/, ""))
    .filter(Boolean);

  let day: number | null = null;
  let time: { hour: number; minute: number | null; hourText: string } | null = null;
  let meridiem: "am" | "pm" | null = null;
  for (const word of words) {
    if (word in DAY_WORDS) {
      if (day !== null && day !== DAY_WORDS[word]) return null;
      day = DAY_WORDS[word];
      continue;
    }
    const clock = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/.exec(word);
    if (clock) {
      if (time) return null;
      time = {
        hour: Number(clock[1]),
        minute: clock[2] === undefined ? null : Number(clock[2]),
        hourText: clock[1],
      };
      if (clock[3]) meridiem = clock[3] as "am" | "pm";
      continue;
    }
    if (word === "am" || word === "pm") {
      if (!time || meridiem) return null;
      meridiem = word;
      continue;
    }
    if (FILLER_WORDS.has(word) || zone.has(word)) continue;
    return null;
  }
  if (day === null || !time) return null;

  const minute = time.minute ?? 0;
  if (minute > 59) return null;
  let hour = time.hour;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else {
    const twentyFourHour = !/am|pm/i.test(
      new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone: "UTC" }).format(
        new Date(Date.UTC(2000, 0, 2, 15)),
      ),
    );
    const unambiguous =
      time.minute !== null && (twentyFourHour || hour >= 13 || time.hourText.startsWith("0"));
    if (!unambiguous || hour > 23) return null;
  }
  return { day, minute: hour * 60 + minute };
}

/**
 * Is an answer's night the season's night now? The same weekday and time
 * when both texts read as one ("Saturdays at 2:00 PM Pacific time" and
 * "Saturday 2pm PT" agree), else the same words, so a reworded but
 * unchanged night doesn't ask everyone again.
 */
export function sameMatchNight(
  answered: string,
  current: string,
  timeZone: string,
  locale: string,
): boolean {
  const a = parseMatchNight(answered, timeZone, locale);
  const b = parseMatchNight(current, timeZone, locale);
  if (a && b) return slotKey(a) === slotKey(b);
  const plain = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  return plain(answered) === plain(current);
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** A player on the roll call, for the page: display fields only. */
export type RollCallPlayer = { id: string; name: string; avatar: string | null };

/**
 * Where the viewer stands: signed out; signed in but not on the list (not
 * signed up for the draft, or a standin); on the list and still to answer;
 * answered for a night that has since moved; or in.
 */
export type RollCallViewer = "signed-out" | "not-listed" | "owed" | "renew" | "in";

export type RollCallView = {
  seasonName: string;
  /** The season's night as pages print it: "Saturdays at 2:00 PM Pacific time". */
  night: string;
  /** The night as a slot on the league's clock, when its text reads as one. */
  slot: PollSlotView | null;
  timeZone: string;
  /** The first match night after the draft: where the viewer's clock is read. */
  clockAt: number;
  viewedAt: number;
  /** Everyone in, by name. */
  locked: RollCallPlayer[];
  /** Everyone still to answer (or to answer again), by name. */
  waiting: RollCallPlayer[];
  viewer: RollCallViewer;
  /** When the viewer locked in, while they are in. */
  answeredAtMs: number | null;
  /** The season still takes a player signup, for a viewer not on the list. */
  signupsOpen: boolean;
};

/**
 * The roll call as Home and /admin show it. `players` is everyone expected
 * to answer (rollCallRoster); an answer counts only while its player is on
 * that list and its night is the season's night now, so a player who
 * withdrew stops counting and one who answered before the night moved is
 * asked again.
 */
export function buildRollCallView(input: {
  seasonName: string;
  status: string;
  night: string;
  timeZone: string;
  locale: string;
  nowMs: number;
  clockAt: number;
  players: readonly RollCallPlayer[];
  answers: readonly { userId: string; matchNight: string; answeredAt: Date }[];
  viewerId: string | null;
}): RollCallView {
  const parsed = parseMatchNight(input.night, input.timeZone, input.locale);
  const answers = new Map(input.answers.map((a) => [a.userId, a]));
  const byName = (a: RollCallPlayer, b: RollCallPlayer) =>
    a.name.localeCompare(b.name, input.locale, { sensitivity: "base", numeric: true }) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const locked: RollCallPlayer[] = [];
  const waiting: RollCallPlayer[] = [];
  for (const player of input.players) {
    const answer = answers.get(player.id);
    const counts =
      !!answer &&
      sameMatchNight(answer.matchNight, input.night, input.timeZone, input.locale);
    (counts ? locked : waiting).push(player);
  }
  locked.sort(byName);
  waiting.sort(byName);

  const listed = input.viewerId
    ? input.players.some((p) => p.id === input.viewerId)
    : false;
  const mine = input.viewerId ? answers.get(input.viewerId) : undefined;
  const viewerIn = listed && locked.some((p) => p.id === input.viewerId);
  const viewer: RollCallViewer = !input.viewerId
    ? "signed-out"
    : !listed
      ? "not-listed"
      : viewerIn
        ? "in"
        : mine
          ? "renew"
          : "owed";

  return {
    seasonName: input.seasonName,
    night: input.night,
    slot: parsed
      ? { ...parsed, key: slotKey(parsed), label: slotLabel(parsed, input.timeZone, input.locale) }
      : null,
    timeZone: input.timeZone,
    clockAt: input.clockAt,
    viewedAt: input.nowMs,
    locked,
    waiting,
    viewer,
    answeredAtMs: viewerIn && mine ? mine.answeredAt.getTime() : null,
    signupsOpen: input.status === SEASON_STATUS.SIGNUPS,
  };
}

/** "41 of 66 players are in", "All 66 players are in", "No players signed up yet". */
export function rollCallCountLine(locked: number, total: number): string {
  if (total === 0) return "No players signed up yet";
  if (locked === total) return total === 1 ? "The 1 player is in" : `All ${total} players are in`;
  return `${locked} of ${total} ${total === 1 ? "player is" : "players are"} in`;
}
