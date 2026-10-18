// The weekly match night a season's pages print ("Match night — ...").
//
// Before fixtures exist the only sources are the admin's free-text box
// (Season.matchSchedule, how the night is announced before signups) and the
// deployment default. Once fixtures have kickoffs, the label is worked out
// from them. Without that, a Europe league whose default is empty kept
// printing "Match night to be announced" beside real kickoff times.
//
// It is read from the fixtures themselves, never from Season.firstMatchNight.
// That field is the arithmetic anchor playoff rounds are dated from: moving
// week 1 sets it even as a one-off, and moving any later week used to shift
// it, so a one-off Tuesday would relabel the whole season "Tuesdays" (an
// archived season may still hold such an anchor).
//
// While a match-night poll is open during signups, the night isn't settled,
// and every page that names it says so instead (pollDecidesMatchNight).

import { MATCH_SCHEDULE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import { LEAGUE_CONFIG } from "./league-config";
import { matchNightText } from "./season-copy";
import { zoneLabel } from "./zone-label";
import { LEAGUE_LOCALE } from "./zoned-time";

/** A fixture as the match-night count reads it. */
export type FixtureKickoff = { scheduledAt: Date | null; status: string };

/**
 * A kickoff as a weekly slot on the league's clock: "Wednesdays at 20:00
 * Berlin time", "Sundays at 6:00 PM Pacific time". Built once per label so a
 * season's worth of fixtures doesn't build two formatters each.
 */
function weeklySlotFormatter(
  timeZone: string,
  locale: string,
): (kickoff: Date) => string {
  const weekday = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long" });
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  const zone = zoneLabel(timeZone);
  return (kickoff) => `${weekday.format(kickoff)}s at ${time.format(kickoff)} ${zone}`;
}

/**
 * The weekly slot the season's fixtures kick off in, or null when none has a
 * kickoff yet. It is the slot most timed fixtures share, played ones
 * included, so a week the admin moved on its own or a match two captains
 * rescheduled stays an exception instead of becoming the league's night.
 * Counting only the fixtures still to play let the last open fixture, often
 * the rescheduled one, name the night on every page. A tie goes to the slot
 * with more fixtures still to play (a move of the rest of the season takes
 * over once it holds as many fixtures as the old night), then to the slot
 * that comes first.
 */
export function fixturesMatchNightLabel(
  fixtures: readonly FixtureKickoff[],
  timeZone: string = LEAGUE_CONFIG.timeZone,
  locale: string = LEAGUE_LOCALE,
): string | null {
  const slotOf = weeklySlotFormatter(timeZone, locale);
  const slots = new Map<
    string,
    { count: number; open: number; first: number }
  >();
  for (const { scheduledAt, status } of fixtures) {
    if (!scheduledAt) continue;
    const label = slotOf(scheduledAt);
    const at = scheduledAt.getTime();
    const open = status === MATCH_STATUS.COMPLETED ? 0 : 1;
    const slot = slots.get(label);
    if (slot) {
      slot.count += 1;
      slot.open += open;
      slot.first = Math.min(slot.first, at);
    } else {
      slots.set(label, { count: 1, open, first: at });
    }
  }
  let best: { label: string; count: number; open: number; first: number } | null =
    null;
  for (const [label, slot] of slots) {
    if (
      !best ||
      slot.count > best.count ||
      (slot.count === best.count &&
        (slot.open > best.open ||
          (slot.open === best.open && slot.first < best.first)))
    ) {
      best = { label, ...slot };
    }
  }
  return best?.label ?? null;
}

/**
 * The season's match night when there is one to name: the fixtures' weekly
 * slot once any has a kickoff, else the admin's text, else the deployment
 * default if that region has announced one. Null when nothing is announced
 * yet (between seasons, or a region with no default before the admin types
 * one). The admin's text loses a typed full stop, since every sentence that
 * quotes it ends itself (matchNightText).
 */
export function announcedMatchNight(
  season: { matchSchedule: string | null } | null,
  fixtures: readonly FixtureKickoff[],
  timeZone?: string,
  locale?: string,
): string | null {
  return (
    fixturesMatchNightLabel(fixtures, timeZone, locale) ??
    matchNightText(season?.matchSchedule) ??
    (MATCH_SCHEDULE.announced ? MATCH_SCHEDULE.label : null)
  );
}

/**
 * The season's match night for a page that always prints one: the announced
 * night (above), else the deployment's "to be announced" line. Every page
 * that names the night goes through here, so /me, Schedule, How it works and
 * the admin hint can't disagree.
 */
export function seasonMatchNightLabel(
  season: { matchSchedule: string | null } | null,
  fixtures: readonly FixtureKickoff[],
  timeZone?: string,
  locale?: string,
): string {
  return (
    announcedMatchNight(season, fixtures, timeZone, locale) ??
    MATCH_SCHEDULE.label
  );
}

/**
 * Whether a match-night poll could decide this season's night at all: only
 * while the season takes signups. A page reads whether a poll is open
 * (matchNightPollOpen) only when this holds, so later phases skip the read;
 * pollDecidesMatchNight gives the answer.
 */
export function pollCanDecideMatchNight(
  season: { status: string } | null,
): boolean {
  return season?.status === SEASON_STATUS.SIGNUPS;
}

/**
 * Whether an open match-night poll is choosing the season's night, so a page
 * that names the night prints MATCH_NIGHT_POLL_LABEL ("being decided in a
 * player poll") instead of a time the vote may change. Only while the season
 * takes signups and no fixture has a kickoff: from the draft on, pages print
 * the season's night as before, and timed fixtures are the night whatever a
 * poll says. A poll has no season, so `pollOpen` is whether any poll is open
 * right now (matchNightPollOpen). Home, /me, How it works, Schedule and the
 * rules all ask this one question, so none of them prints a night another
 * says is still being voted on.
 */
export function pollDecidesMatchNight(
  season: { status: string } | null,
  fixtures: readonly FixtureKickoff[],
  pollOpen: boolean,
): boolean {
  return (
    pollOpen &&
    pollCanDecideMatchNight(season) &&
    !fixtures.some((f) => f.scheduledAt != null)
  );
}
