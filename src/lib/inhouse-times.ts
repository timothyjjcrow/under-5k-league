// Play later: inhouse times the players set themselves on /inhouse ("I can
// play at 8, who's in?"). Separate from the admin's inhouse night
// (inhouse-night.ts) on purpose: no Discord post, no ping, no admin. Any
// signed-in player posts a time within the next day, on the quarter hour, and
// anyone signed in says "I'm in" on it. A time has no owner: it is the players
// in on it, first in first, one InhouseTimeRsvp row each
// (inhouse-times-service.ts). So posting a time is being first in, two
// players posting 8:00 PM share one, and a time is gone once its last player
// takes it back. It shows until an hour after it starts, when the way in is
// the queue; nobody is queued for them. Pure.

import { INHOUSE } from "./constants";
import { icsDate, type CalendarEvent } from "./ics";
import { INHOUSE_NIGHT_LENGTH_MS } from "./inhouse-night";
import { dateAtWallTime, wallTime, zoneFormatter } from "./zoned-time";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Times start on the quarter hour. Every UTC offset in use is a whole number
 * of quarter hours, so a quarter hour in UTC is one on every player's clock.
 */
export const INHOUSE_TIME_STEP_MS = 15 * MINUTE_MS;

/**
 * How far ahead a time can be: the next time the player's clock reads it,
 * which is within a day, and a day is 25 hours long when the clocks go back.
 */
export const INHOUSE_TIME_MAX_LEAD_MS = 25 * HOUR_MS;

/** How long a time shows once it has started ("On now"), and its calendar entry's length. */
export const INHOUSE_TIME_ON_MS = HOUR_MS;

/**
 * Upcoming times one player can be in on at once. It is also the most times
 * one account can keep on the list, since a time with nobody in it is gone.
 */
export const INHOUSE_TIME_MAX_PER_PLAYER = 3;

export type InhouseTimePhase = "upcoming" | "on" | "over";

export function inhouseTimePhase(startsAtMs: number, nowMs: number): InhouseTimePhase {
  if (nowMs < startsAtMs) return "upcoming";
  if (nowMs < startsAtMs + INHOUSE_TIME_ON_MS) return "on";
  return "over";
}

/** The starts the list shows: the ones on now, up to the furthest a time can be. */
export function inhouseTimesWindow(nowMs: number): { afterMs: number; untilMs: number } {
  return { afterMs: nowMs - INHOUSE_TIME_ON_MS, untilMs: nowMs + INHOUSE_TIME_MAX_LEAD_MS };
}

/** A time's start as forms and links carry it: "2026-10-11T03:00Z". */
export function inhouseTimeParam(startsAtMs: number): string {
  return `${new Date(startsAtMs).toISOString().slice(0, 16)}Z`;
}

const PARAM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

/**
 * The start a form or link names, or null for anything malformed, off the
 * quarter hour or not a real date. Only the exact shape inhouseTimeParam
 * writes passes, so one time has one link.
 */
export function parseInhouseTimeParam(raw: string | null | undefined): number | null {
  if (!raw || !PARAM.test(raw)) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms % INHOUSE_TIME_STEP_MS !== 0) return null;
  // A date that rolled over (Feb 30) prints as a different one.
  return inhouseTimeParam(ms) === raw ? ms : null;
}

/** Where a time's link opens: /inhouse with that time's card first. */
export function inhouseTimeLinkPath(startsAtMs: number): string {
  return `/inhouse?at=${inhouseTimeParam(startsAtMs)}`;
}

/** Why "I'm in" (or posting) on this start is refused now, or null when it isn't. */
export function inhouseTimeProblem(startsAtMs: number, nowMs: number): string | null {
  if (!Number.isFinite(startsAtMs) || startsAtMs % INHOUSE_TIME_STEP_MS !== 0) {
    return "Pick a time on the quarter hour.";
  }
  const phase = inhouseTimePhase(startsAtMs, nowMs);
  if (phase === "on") return "That time has started: join the queue instead.";
  if (phase === "over") return "That time has been and gone. Post a new one.";
  if (startsAtMs - nowMs > INHOUSE_TIME_MAX_LEAD_MS) return "Pick a time in the next day.";
  return null;
}

/**
 * Whether a start falls inside the planned inhouse night, from its start to
 * its end. A new time there would split the night's players, so the night
 * comes first; a time posted before the night was planned stays as it is.
 */
export function inhouseTimeDuringNight(
  startsAtMs: number,
  night: { startsAtMs: number } | null,
): boolean {
  return (
    !!night &&
    startsAtMs >= night.startsAtMs &&
    startsAtMs < night.startsAtMs + INHOUSE_NIGHT_LENGTH_MS
  );
}

export const INHOUSE_TIME_DURING_NIGHT =
  "That's during the inhouse night: say you're in on its card at the top of the page instead.";

export const INHOUSE_TIME_AT_CAP = `You're in on ${INHOUSE_TIME_MAX_PER_PLAYER} upcoming times, the most at once. Take yourself off one first.`;

/** A player in on a time, for the page: display fields only. */
export type InhouseTimePlayer = { id: string; name: string; avatar: string | null };

export type InhouseTime = {
  startsAtMs: number;
  phase: Exclude<InhouseTimePhase, "over">;
  /** First in first. */
  players: InhouseTimePlayer[];
};

/**
 * The stored rows as the list shows them: one entry per start, soonest
 * first, each with its players in the order they said so (a tie on the
 * stamp goes to the id). Times that are over are left out.
 */
export function groupInhouseTimes(
  rows: readonly { startsAtMs: number; createdAtMs: number; player: InhouseTimePlayer }[],
  nowMs: number,
): InhouseTime[] {
  const sorted = [...rows].sort(
    (a, b) =>
      a.startsAtMs - b.startsAtMs ||
      a.createdAtMs - b.createdAtMs ||
      (a.player.id < b.player.id ? -1 : a.player.id > b.player.id ? 1 : 0),
  );
  const times: InhouseTime[] = [];
  for (const row of sorted) {
    const phase = inhouseTimePhase(row.startsAtMs, nowMs);
    if (phase === "over") continue;
    const last = times[times.length - 1];
    if (last?.startsAtMs === row.startsAtMs) last.players.push(row.player);
    else times.push({ startsAtMs: row.startsAtMs, phase, players: [row.player] });
  }
  return times;
}

/** How many of a viewer's times are still ahead: what the cap counts. */
export function upcomingInhouseTimesFor(times: readonly InhouseTime[], userId: string): number {
  return times.filter(
    (time) => time.phase === "upcoming" && time.players.some((player) => player.id === userId),
  ).length;
}

/** "6 in · 4 more for a game", "12 in · enough for a game", "20 in · enough for two games". */
export function inhouseTimeCountText(count: number): string {
  const games = Math.min(Math.floor(count / INHOUSE.LOBBY_SIZE), INHOUSE.MAX_LIVE_GAMES);
  if (games === 0) return `${count} in · ${INHOUSE.LOBBY_SIZE - count} more for a game`;
  if (games === 1) return `${count} in · enough for a game`;
  return `${count} in · enough for ${games === 2 ? "two" : games} games`;
}

/** What one time's row offers the viewer (one rule for every row). */
export type InhouseTimeControls = {
  /** "I'm in": a sign-in, the toggle (pressed when `mine`), or nothing. */
  rsvp: "sign-in" | "toggle" | "none";
  /** "Join the queue": the time is on. */
  queue: boolean;
  /** Calendar links: a reminder for a player who is in and waiting. */
  calendar: boolean;
};

/**
 * The controls a time's row shows. "I'm in" is offered while the time is
 * ahead, except to a player already at the cap; once it's on, the queue is
 * the way in. A player in on it keeps the pressed toggle either way, so
 * taking it back is never hidden.
 */
export function inhouseTimeControls(input: {
  phase: InhouseTime["phase"];
  signedIn: boolean;
  /** The viewer is in on this time. */
  mine: boolean;
  /** The viewer is in on INHOUSE_TIME_MAX_PER_PLAYER upcoming times. */
  atCap: boolean;
}): InhouseTimeControls {
  const upcoming = input.phase === "upcoming";
  let rsvp: InhouseTimeControls["rsvp"] = "none";
  if (input.mine) rsvp = "toggle";
  else if (upcoming && !input.signedIn) rsvp = "sign-in";
  else if (upcoming && !input.atCap) rsvp = "toggle";
  return { rsvp, queue: !upcoming, calendar: upcoming && input.mine };
}

/** Whether the viewer can post a new time: signed in and under the cap. */
export function inhouseTimeCanPost(input: { signedIn: boolean; atCap: boolean }): boolean {
  return input.signedIn && !input.atCap;
}

/** Times the strip at the top of /inhouse shows before its "N more times" link. */
export const INHOUSE_TIMES_STRIP_SHOWN = 3;

/**
 * What the strip above the live room shows (Tim, 2026-10-10: a time should be
 * seen without scrolling past the queue): the soonest open times, on now or
 * ahead, at most INHOUSE_TIMES_STRIP_SHOWN, and how many more the card under
 * the room has. Null when no time is open, so the top of the page carries no
 * empty box, and when the page was opened from a time's link (`linked`),
 * which already puts the whole card first.
 */
export function inhouseTimesStrip<T extends { startsAtMs: number; phase: InhouseTimePhase }>(
  times: readonly T[],
  input: { linked: boolean },
): { shown: T[]; more: number } | null {
  if (input.linked) return null;
  const open = times
    .filter((time) => time.phase === "upcoming" || time.phase === "on")
    .sort((a, b) => a.startsAtMs - b.startsAtMs);
  if (open.length === 0) return null;
  const shown = open.slice(0, INHOUSE_TIMES_STRIP_SHOWN);
  return { shown, more: open.length - shown.length };
}

/**
 * The strip's link down to the card: how many more times it has, else
 * "Post a time" (the card's sign-in for a signed-out viewer), else, for a
 * player at the cap who can't post, "All times".
 */
export function inhouseTimesStripLinkText(input: { more: number; atCap: boolean }): string {
  if (input.more > 0) return `${input.more} more ${input.more === 1 ? "time" : "times"}`;
  return input.atCap ? "All times" : "Post a time";
}

/**
 * Who's in on a time, for its avatar stack's label: "Ana is in", "Ana and
 * Bo are in", "Ana, Bo, Cy, Di, Ed and 3 more are in". Names past `shown`
 * (the faces the stack draws) are counted, not listed.
 */
export function inhouseTimeWhoText(names: readonly string[], shown: number): string {
  const listed = names.slice(0, Math.max(1, shown));
  const rest = names.length - listed.length;
  const parts = rest > 0 ? [...listed, `${rest} more`] : listed;
  const last = parts.pop() ?? "";
  const text = parts.length > 0 ? `${parts.join(", ")} and ${last}` : last;
  return `${text} ${names.length === 1 ? "is" : "are"} in`;
}

/**
 * Which day a time falls on against now, on `timeZone`'s clock: "Today",
 * "Tomorrow", or "Yesterday" for one on since before midnight. Null further
 * out (a 25-hour day can put a time two midnights away), for a full date.
 */
export function inhouseTimeDayWord(
  startsAtMs: number,
  nowMs: number,
  timeZone: string,
): "Today" | "Tomorrow" | "Yesterday" | null {
  const formatter = zoneFormatter(timeZone);
  const day = (ms: number) => Math.floor(wallTime(new Date(ms), formatter) / (24 * HOUR_MS));
  const diff = day(startsAtMs) - day(nowMs);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return null;
}

/**
 * The /inhouse preview for a time's link (Discord, X and Slack show og:title
 * and og:description): when it is on the league's clock, how many are in,
 * and what the link does.
 */
export function inhouseTimePreviewText(input: {
  /** The start on the league's clock, zone named (formatLeagueMatchTime). */
  when: string;
  phase: InhouseTime["phase"];
  count: number;
}): { title: string; description: string } {
  if (input.phase === "on") {
    return {
      title: `Inhouse is on · ${input.when}`,
      description: `${input.count} said they're in. Open this to join the queue: the lobby fires at ten players and captains draft the teams.`,
    };
  }
  return {
    title: `Inhouse · ${input.when}`,
    description: `${inhouseTimeCountText(input.count)}. Open this to say you're in, then queue up when it comes round. Inhouse 5v5s: the lobby fires at ten players and captains draft the teams.`,
  };
}

/**
 * A clock time a time box posted ("20:00", seconds allowed), rounded to the
 * nearest quarter hour ("20:07" is 20:00, "23:53" is midnight). Null when it
 * isn't a time of day.
 */
export function quarterHourClock(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const quarters = Math.round((hour * 60 + minute) / 15) % (24 * 4);
  return { hour: Math.floor(quarters / 4), minute: (quarters % 4) * 15 };
}

/**
 * The next instant after `nowMs` when `timeZone`'s clock reads `hour`:`minute`:
 * today, or tomorrow once today's has passed. A time the clocks skip moves
 * forward by the jump and a repeated one takes the earlier pass, the way a
 * browser reads its own zone (dateAtWallTime).
 */
export function nextInhouseTimeAt(
  nowMs: number,
  clock: { hour: number; minute: number },
  timeZone: string,
): number {
  const formatter = zoneFormatter(timeZone);
  const today = new Date(wallTime(new Date(nowMs), formatter));
  const on = (days: number) =>
    dateAtWallTime(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + days,
        clock.hour,
        clock.minute,
      ),
      formatter,
    ).getTime();
  const first = on(0);
  return first > nowMs ? first : on(1);
}

/**
 * The time box's starting value: the first whole hour at least half an hour
 * away, on `timeZone`'s clock ("19:00" at 6:20 PM, "20:00" at 6:40 PM).
 */
export function defaultInhouseTimeClock(nowMs: number, timeZone: string): string {
  const wall = new Date(wallTime(new Date(nowMs + 30 * MINUTE_MS), zoneFormatter(timeZone)));
  const hour = (wall.getUTCHours() + (wall.getUTCMinutes() > 0 ? 1 : 0)) % 24;
  return `${String(hour).padStart(2, "0")}:00`;
}

function calendarText(site: string): string {
  return `Inhouse 5v5s: join the queue on the site when it comes round. ${site}/inhouse`;
}

/** Google Calendar's "add this event" link for a time. */
export function inhouseTimeGoogleCalendarUrl(
  startsAtMs: number,
  site: string,
  leagueName: string,
): string {
  const start = new Date(startsAtMs);
  const end = new Date(startsAtMs + INHOUSE_TIME_ON_MS);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${leagueName} inhouse`,
    dates: `${icsDate(start)}/${icsDate(end)}`,
    details: calendarText(site),
    location: `${site}/inhouse`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** A time as one calendar entry, for the .ics download. One time, one UID. */
export function inhouseTimeCalendarEvent(
  startsAtMs: number,
  site: string,
  leagueName: string,
  stampMs: number,
): CalendarEvent {
  return {
    uid: `inhouse-time-${startsAtMs}@${new URL(site).host}`,
    stamp: new Date(stampMs),
    sequence: 0,
    start: new Date(startsAtMs),
    durationMinutes: INHOUSE_TIME_ON_MS / MINUTE_MS,
    summary: `${leagueName} inhouse`,
    description: calendarText(site),
    url: `${site}${inhouseTimeLinkPath(startsAtMs)}`,
  };
}
