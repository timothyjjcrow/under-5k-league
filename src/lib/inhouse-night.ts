// The inhouse night: one evening an admin sets aside for inhouses, so players
// know when to show up. Home and /inhouse show it with a countdown, the
// inhouse Discord channel gets a post when it is set and another when it
// starts, and the bot adds it to the server's Discord events, where players
// mark themselves interested and Discord reminds them. One night at a time:
// saving a new one replaces the last. Pure; inhouse-night-service.ts stores it
// in one Setting row (SETTING_KEYS.INHOUSE_NIGHT) and the pages read it here.

import { LIVE_WINDOW_MS } from "./countdown";
import { icsDate, type CalendarEvent } from "./ics";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead a night may be set: about two months. */
export const INHOUSE_NIGHT_MAX_LEAD_DAYS = 60;

/**
 * How long a night counts as on after it starts: the countdown's "happening
 * now" window, and the Discord event's and the calendar entry's length.
 */
export const INHOUSE_NIGHT_LENGTH_MS = LIVE_WINDOW_MS;

/**
 * The start post goes out within this long after the start, never later: a
 * worker that was down at 8 PM must not ping the role at 10 PM.
 */
export const INHOUSE_NIGHT_START_POST_WINDOW_MS = 30 * 60_000;

/** The admin's note, shown on the site and in Discord. */
export const INHOUSE_NIGHT_NOTE_MAX = 200;

export type InhouseNight = {
  /** Fixed for the night's life: moving it keeps the id, a new night gets a
   *  new one. Its start post's marker is keyed by it. */
  id: string;
  startsAtMs: number;
  /** "" for none. */
  note: string;
  /** When the night was first set: the calendar entry's stable stamp. */
  createdAtMs: number;
  /** Bumped by every save (the calendar entry's SEQUENCE, and the admin
   *  form's guard against a save made from a stale page). */
  revision: number;
  /** The Discord server event the bot created for it, if any. */
  discordEventId: string | null;
};

export function serializeInhouseNight(night: InhouseNight): string {
  return JSON.stringify({
    v: 1,
    id: night.id,
    startsAt: new Date(night.startsAtMs).toISOString(),
    note: night.note,
    createdAt: new Date(night.createdAtMs).toISOString(),
    revision: night.revision,
    discordEventId: night.discordEventId,
  });
}

const SNOWFLAKE = /^\d{5,25}$/;

/** The stored night, or null for nothing saved or a value that won't parse. */
export function parseInhouseNight(raw: string | null | undefined): InhouseNight | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || typeof row.id !== "string" || !row.id) return null;
  if (typeof row.startsAt !== "string" || typeof row.createdAt !== "string") return null;
  const startsAtMs = Date.parse(row.startsAt);
  const createdAtMs = Date.parse(row.createdAt);
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(createdAtMs)) return null;
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) return null;
  const note = typeof row.note === "string" ? row.note : "";
  const discordEventId =
    typeof row.discordEventId === "string" && SNOWFLAKE.test(row.discordEventId)
      ? row.discordEventId
      : null;
  return {
    id: row.id,
    startsAtMs,
    note,
    createdAtMs,
    revision: row.revision as number,
    discordEventId,
  };
}

export type InhouseNightPhase = "upcoming" | "on" | "over";

export function inhouseNightPhase(night: InhouseNight, nowMs: number): InhouseNightPhase {
  if (nowMs < night.startsAtMs) return "upcoming";
  if (nowMs < night.startsAtMs + INHOUSE_NIGHT_LENGTH_MS) return "on";
  return "over";
}

/** The night Home and /inhouse show: the stored one until it is over. */
export function currentInhouseNight(
  night: InhouseNight | null,
  nowMs: number,
): InhouseNight | null {
  return night && inhouseNightPhase(night, nowMs) !== "over" ? night : null;
}

/** Why a start time can't be saved, or null when it can. */
export function inhouseNightTimeProblem(startsAtMs: number, nowMs: number): string | null {
  if (!Number.isFinite(startsAtMs) || startsAtMs <= nowMs) {
    return "Pick a start time in the future.";
  }
  if (startsAtMs - nowMs > INHOUSE_NIGHT_MAX_LEAD_DAYS * DAY_MS) {
    return `Pick a start time within the next ${INHOUSE_NIGHT_MAX_LEAD_DAYS} days.`;
  }
  return null;
}

/**
 * The admin's note as stored: one line, trimmed. Runs of spaces and line
 * breaks become one space (the Discord post flattens them anyway); anything
 * longer than the limit is refused rather than cut.
 */
export function inhouseNightNote(raw: string): { note: string } | { error: string } {
  const note = raw.replace(/\s+/g, " ").trim();
  if (note.length > INHOUSE_NIGHT_NOTE_MAX) {
    return {
      error: `Keep the note to ${INHOUSE_NIGHT_NOTE_MAX} characters (it's ${note.length}).`,
    };
  }
  return { note };
}

/**
 * What a save does to the stored night: moves the upcoming one, changes only
 * its note, or starts a new one. Once a night has started, a save always
 * starts the next one: the live night has had its start post, and Discord
 * runs its event to the end by itself.
 */
export type InhouseNightChange = "new" | "moved" | "note" | "unchanged";

export function inhouseNightChange(
  previous: InhouseNight | null,
  input: { startsAtMs: number; note: string },
  nowMs: number,
): InhouseNightChange {
  if (!previous || inhouseNightPhase(previous, nowMs) !== "upcoming") return "new";
  if (previous.startsAtMs !== input.startsAtMs) return "moved";
  if (previous.note !== input.note) return "note";
  return "unchanged";
}

/** The night a save stores. A new night starts with no Discord event. */
export function nextInhouseNight(
  previous: InhouseNight | null,
  input: { startsAtMs: number; note: string },
  nowMs: number,
  newId: () => string,
): InhouseNight {
  if (inhouseNightChange(previous, input, nowMs) === "new" || !previous) {
    return {
      id: newId(),
      startsAtMs: input.startsAtMs,
      note: input.note,
      createdAtMs: nowMs,
      revision: 0,
      discordEventId: null,
    };
  }
  return {
    ...previous,
    startsAtMs: input.startsAtMs,
    note: input.note,
    revision: previous.revision + 1,
  };
}

/** The Discord server event for a night (an EXTERNAL event at the site). */
export function inhouseNightEvent(
  night: InhouseNight,
  site: string,
  leagueName: string,
) {
  return {
    // Discord: name 1-100, description 1-1000, location 1-100 characters.
    name: `${leagueName} inhouse night`.slice(0, 100),
    description: [
      night.note,
      "Inhouse 5v5s: join the queue on the site and the lobby fires at ten players. Captains draft the teams.",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 1000),
    location: `${site}/inhouse`.slice(0, 100),
    startsAt: new Date(night.startsAtMs),
    endsAt: new Date(night.startsAtMs + INHOUSE_NIGHT_LENGTH_MS),
  };
}

/** A Discord server event's share link, which Discord unfurls as the event. */
export function discordEventUrl(guildId: string, eventId: string): string {
  return `https://discord.com/events/${guildId}/${eventId}`;
}

function calendarText(night: InhouseNight, site: string): string {
  return [night.note, `Join the queue on the site: ${site}/inhouse`]
    .filter(Boolean)
    .join("\n\n");
}

/** Google Calendar's "add this event" link for the night. */
export function inhouseNightGoogleCalendarUrl(
  night: InhouseNight,
  site: string,
  leagueName: string,
): string {
  const start = new Date(night.startsAtMs);
  const end = new Date(night.startsAtMs + INHOUSE_NIGHT_LENGTH_MS);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${leagueName} inhouse night`,
    dates: `${icsDate(start)}/${icsDate(end)}`,
    details: calendarText(night, site),
    location: `${site}/inhouse`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** The night as one calendar entry, for the .ics download. */
export function inhouseNightCalendarEvent(
  night: InhouseNight,
  site: string,
  leagueName: string,
): CalendarEvent {
  return {
    uid: `inhouse-night-${night.id}@${new URL(site).host}`,
    stamp: new Date(night.createdAtMs),
    sequence: night.revision,
    start: new Date(night.startsAtMs),
    durationMinutes: INHOUSE_NIGHT_LENGTH_MS / 60_000,
    summary: `${leagueName} inhouse night`,
    description: calendarText(night, site),
    url: `${site}/inhouse`,
  };
}
