// The weekly match night a season's pages print ("Match night — ...").
//
// Before fixtures exist the only sources are the admin's free-text box
// (Season.matchSchedule, how the night is announced before signups) and the
// deployment default. Once the schedule has kickoffs, week 1's time IS the
// weekly slot (every later week, playoffs included, is dated off it on the
// league's clock), so the label is worked out from it. Without that, a
// Europe league whose default is empty kept printing "Match night to be
// announced" beside real kickoff times.

import { MATCH_SCHEDULE } from "./constants";
import { LEAGUE_CONFIG } from "./league-config";
import { zoneLabel } from "./zone-label";
import { LEAGUE_LOCALE } from "./zoned-time";

/**
 * Week 1's kickoff as a weekly slot on the league's clock:
 * "Wednesdays at 20:00 Berlin time", "Sundays at 6:00 PM Pacific time".
 */
export function weeklyMatchNightLabel(
  firstMatchNight: Date,
  timeZone: string = LEAGUE_CONFIG.timeZone,
  locale: string = LEAGUE_LOCALE,
): string {
  const weekday = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
  }).format(firstMatchNight);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(firstMatchNight);
  return `${weekday}s at ${time} ${zoneLabel(timeZone)}`;
}

/**
 * The season's match night: week 1's slot once the schedule has one, else the
 * admin's text, else the deployment default.
 */
export function seasonMatchNightLabel(
  season: { firstMatchNight: Date | null; matchSchedule: string | null },
  timeZone?: string,
  locale?: string,
): string {
  if (season.firstMatchNight) {
    return weeklyMatchNightLabel(season.firstMatchNight, timeZone, locale);
  }
  return season.matchSchedule?.trim() || MATCH_SCHEDULE.label;
}
