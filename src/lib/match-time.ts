// Match-time display formats. The server writes a time on the league's own
// clock with its zone named (formatLeagueMatchTime); <LocalTime> shows that
// text until the browser takes over and rewrites it on the viewer's clock
// (formatMatchTime).

import { LEAGUE_CONFIG } from "./league-config";
import { zoneName } from "./zone-label";
import { LEAGUE_LOCALE } from "./zoned-time";

export type TimeVariant = "full" | "short" | "date";

function variantFields(variant: TimeVariant): Intl.DateTimeFormatOptions {
  if (variant === "date") {
    return { weekday: "short", month: "short", day: "numeric" };
  }
  return {
    ...(variant === "full" ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
}

/**
 * "Sat, Jul 12, 6:00 PM" (full), "Jul 12, 6:00 PM" (short, phone width), or
 * "Sat, Jul 12" (date — week headers, no time of day), on the clock of
 * whoever runs it. Only the browser should: it is the viewer's own time
 * (`<LocalTime>`'s client text). On the server it printed the host's clock,
 * UTC in production, with nothing saying so.
 */
export function formatMatchTime(d: Date, variant: TimeVariant): string {
  return variant === "date"
    ? d.toLocaleDateString(undefined, variantFields(variant))
    : d.toLocaleString(undefined, variantFields(variant));
}

/**
 * The same variants on a named clock, the zone's plain name after any time of
 * day: "Sat, Oct 3, 3:00 PM Pacific", "Sat 3 Oct, 20:00 Berlin". Pure, so both
 * leagues are tested from one process.
 */
export function formatMatchTimeInZone(
  d: Date,
  variant: TimeVariant,
  timeZone: string,
  locale: string,
): string {
  const text = new Intl.DateTimeFormat(locale, {
    timeZone,
    ...variantFields(variant),
  }).format(d);
  return variant === "date" ? text : `${text} ${zoneName(timeZone)}`;
}

/**
 * The server's text for a match time: the league's clock, zone named. It is
 * `<LocalTime>`'s `initial` (what a phone shows until the page has loaded)
 * and all that a screen reader hears in a server-written label, a visitor
 * without scripts reads, or a confirm dialog says. The final used to read
 * "Sat, Oct 3, 10:00 PM" (UTC) before flipping to 3:00 PM on a Pacific phone.
 */
export function formatLeagueMatchTime(d: Date, variant: TimeVariant): string {
  return formatMatchTimeInZone(d, variant, LEAGUE_CONFIG.timeZone, LEAGUE_LOCALE);
}

/**
 * A kickoff split for a compact time chip: "Sat", "Oct 10", "8:00 PM", on the
 * clock of whoever runs it. Only the browser should (the chip's client text);
 * the server writes `leagueMatchTimeParts`.
 */
export function matchTimeParts(d: Date): {
  day: string;
  date: string;
  time: string;
} {
  return {
    day: d.toLocaleDateString(undefined, { weekday: "short" }),
    date: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

/**
 * `matchTimeParts` on the league's clock, the zone named after the time:
 * the server's text for a time chip until the browser rewrites it on the
 * viewer's clock (formatLeagueMatchTime's rule, split for a chip).
 */
export function leagueMatchTimeParts(d: Date): {
  day: string;
  date: string;
  time: string;
} {
  const timeZone = LEAGUE_CONFIG.timeZone;
  const on = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(LEAGUE_LOCALE, { timeZone, ...options }).format(d);
  return {
    day: on({ weekday: "short" }),
    date: on({ month: "short", day: "numeric" }),
    time: `${on({ hour: "numeric", minute: "2-digit" })} ${zoneName(timeZone)}`,
  };
}
