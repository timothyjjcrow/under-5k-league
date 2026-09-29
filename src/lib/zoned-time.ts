// Wall clock <-> instant conversion on a NAMED IANA zone (the league's), plus
// the plain-words labels the admin forms show beside it. Pure: nothing here
// reads the host's own zone, so the UTC server, the tests and every browser
// get the same answer.
//
// Why this exists: a datetime-local box posts a zone-less "2026-10-07T20:00".
// <LocalDatetimeField> used to read it on the BROWSER's clock, so a Europe
// admin travelling (or Tim running Europe from Los Angeles) who typed 20:00
// scheduled week 1 for 05:00 Berlin time — and saw "20:00" everywhere they
// looked, because every surface also renders in their own zone.

import { LEAGUE_CONFIG } from "./league-config";

/** A formatter that exposes `timeZone`'s wall clock, field by field. */
export function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
}

/** `date`'s wall clock on the formatter's zone, encoded as a UTC epoch. */
export function wallTime(date: Date, formatter: Intl.DateTimeFormat): number {
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
    date.getUTCMilliseconds(),
  );
}

/**
 * The instant whose wall clock on the formatter's zone reads `target` (a wall
 * clock encoded as a UTC epoch, as `wallTime` returns).
 *
 * Deterministic at both daylight-saving edges, and the same choices a browser
 * makes for its own zone: a REPEATED local time (clocks go back) takes the
 * earlier occurrence; a SKIPPED one (clocks go forward) moves forward by the
 * size of the jump, so 02:30 on the spring-forward night becomes 03:30.
 */
export function dateAtWallTime(target: number, formatter: Intl.DateTimeFormat): Date {
  const offsets = new Set<number>();
  // Sample both sides of a possible clock change, including half-hour changes.
  for (const hours of [-36, 0, 36]) {
    const sample = new Date(target + hours * 3_600_000);
    offsets.add(wallTime(sample, formatter) - sample.getTime());
  }
  const candidates = [...offsets].map((offset) => new Date(target - offset));
  const exact = candidates.filter((date) => wallTime(date, formatter) === target);
  if (exact.length) return new Date(Math.min(...exact.map((date) => date.getTime())));
  const after = candidates.filter((date) => wallTime(date, formatter) > target);
  return new Date(Math.min(...after.map((date) => date.getTime())));
}

const DATETIME_LOCAL =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * A datetime-local value ("2026-10-07T20:00", seconds optional) as its wall
 * clock encoded as a UTC epoch. Null when malformed or not a real calendar
 * date (Feb 30, 24:00) — never a silently rolled-over neighbour.
 */
export function parseDatetimeLocal(value: string): number | null {
  const m = DATETIME_LOCAL.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }
  return wall;
}

/** The instant a datetime-local value names when read on `timeZone`'s clock. */
export function zonedDatetimeLocalToEpoch(
  value: string,
  timeZone: string,
): number | null {
  const wall = parseDatetimeLocal(value);
  if (wall === null) return null;
  return dateAtWallTime(wall, zoneFormatter(timeZone)).getTime();
}

/** `ms` as a datetime-local value on `timeZone`'s clock, to the minute. */
export function epochToZonedDatetimeLocal(ms: number, timeZone: string): string {
  // toISOString of the wall clock is "YYYY-MM-DDTHH:mm:ss.sssZ"; the first 16
  // characters are exactly the minute-precision datetime-local shape.
  return new Date(wallTime(new Date(ms), zoneFormatter(timeZone)))
    .toISOString()
    .slice(0, 16);
}

// The US zones have names players already use ("Pacific", "Eastern"); the
// league-config label for the US night is "Pacific" for the same reason.
const US_ZONE_NAMES: Record<string, string> = {
  "America/Los_Angeles": "Pacific",
  "America/Vancouver": "Pacific",
  "America/Denver": "Mountain",
  "America/Edmonton": "Mountain",
  "America/Phoenix": "Arizona",
  "America/Chicago": "Central",
  "America/Winnipeg": "Central",
  "America/New_York": "Eastern",
  "America/Toronto": "Eastern",
  "America/Detroit": "Eastern",
  "America/Anchorage": "Alaska",
  "Pacific/Honolulu": "Hawaii",
};

const REGION_PREFIX =
  /^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\//;

/**
 * A zone in plain words: "Berlin time", "Pacific time". A zone with no city
 * in its id ("UTC", "Etc/GMT-1") falls back to the id itself.
 */
export function zoneLabel(timeZone: string): string {
  const known = US_ZONE_NAMES[timeZone];
  if (known) return `${known} time`;
  if (REGION_PREFIX.test(timeZone)) {
    const city = timeZone.slice(timeZone.lastIndexOf("/") + 1).replace(/_/g, " ");
    if (city) return `${city} time`;
  }
  return `${timeZone} time`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Wed 7 Oct, 20:00 Berlin time" — an instant on `timeZone`'s clock, named.
 * Safe on the server: the zone is explicit, so the UTC host can't leak in.
 */
export function formatInZone(
  date: Date,
  timeZone: string,
  locale: string | undefined,
): string {
  const when = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${when} ${zoneLabel(timeZone)}`;
}

/**
 * What a league-time entry is on the viewer's own clock — "= 11:00 your
 * time", or "= Thu 8 Oct, 03:00 your time" when it lands on another day.
 * Null when both clocks read the same (a Paris admin on a Berlin league), so
 * the line only appears when it tells the viewer something.
 *
 * Also null when the browser reports a zone Intl can't format (Chrome says
 * "Etc/Unknown" when it can't map the OS zone): the field calls this from
 * its sync effect, so a throw here would take down every scheduling box on
 * /admin over an optional hint line.
 */
export function yourTimeHint(
  ms: number,
  timeZone: string,
  viewerZone: string,
  locale: string | undefined,
): string | null {
  try {
    return yourTimeHintOrThrow(ms, timeZone, viewerZone, locale);
  } catch {
    return null;
  }
}

function yourTimeHintOrThrow(
  ms: number,
  timeZone: string,
  viewerZone: string,
  locale: string | undefined,
): string | null {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const league = wallTime(date, zoneFormatter(timeZone));
  const yours = wallTime(date, zoneFormatter(viewerZone));
  if (league === yours) return null;
  const sameDay = Math.floor(league / DAY_MS) === Math.floor(yours / DAY_MS);
  const when = new Intl.DateTimeFormat(locale, {
    timeZone: viewerZone,
    ...(sameDay
      ? {}
      : { weekday: "short" as const, day: "numeric" as const, month: "short" as const }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `= ${when} your time`;
}

/** The locale league-time copy is written in: "Wed 7 Oct, 20:00" in Europe. */
export const LEAGUE_LOCALE = LEAGUE_CONFIG.region === "eu" ? "en-GB" : "en-US";

/** An instant as the league's own clock reads it, zone named. */
export function formatLeagueTime(date: Date): string {
  return formatInZone(date, LEAGUE_CONFIG.timeZone, LEAGUE_LOCALE);
}
