// The weekly match night a season's pages print ("Match night — ...").
//
// Before fixtures exist the only sources are the admin's free-text box
// (Season.matchSchedule, how the night is announced before signups) and the
// deployment default. Once fixtures have kickoffs, the label is worked out
// from them. Without that, a Europe league whose default is empty kept
// printing "Match night to be announced" beside real kickoff times.
//
// It is read from the fixtures themselves, never from Season.firstMatchNight.
// That field is the arithmetic anchor playoff rounds are dated from, and
// moving any single week moves it too, so a one-off Tuesday in week 3 would
// have relabelled the whole season "Tuesdays".

import { MATCH_SCHEDULE, MATCH_STATUS } from "./constants";
import { LEAGUE_CONFIG } from "./league-config";
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
 * kickoff yet. It is the slot most fixtures share, so a week the admin moved
 * on its own or a match two captains rescheduled stays an exception instead
 * of becoming the league's night. Fixtures still to be played decide it (a
 * later-season move to a new night counts from then on); once every fixture
 * is played, all of them do. A tie goes to the slot that comes first.
 */
export function fixturesMatchNightLabel(
  fixtures: readonly FixtureKickoff[],
  timeZone: string = LEAGUE_CONFIG.timeZone,
  locale: string = LEAGUE_LOCALE,
): string | null {
  const timed = fixtures.filter(
    (f): f is { scheduledAt: Date; status: string } => f.scheduledAt != null,
  );
  const open = timed.filter((f) => f.status !== MATCH_STATUS.COMPLETED);
  const counted = open.length > 0 ? open : timed;
  if (counted.length === 0) return null;

  const slotOf = weeklySlotFormatter(timeZone, locale);
  const slots = new Map<string, { count: number; first: number }>();
  for (const { scheduledAt } of counted) {
    const label = slotOf(scheduledAt);
    const at = scheduledAt.getTime();
    const slot = slots.get(label);
    if (slot) {
      slot.count += 1;
      slot.first = Math.min(slot.first, at);
    } else {
      slots.set(label, { count: 1, first: at });
    }
  }
  let best: { label: string; count: number; first: number } | null = null;
  for (const [label, slot] of slots) {
    if (
      !best ||
      slot.count > best.count ||
      (slot.count === best.count && slot.first < best.first)
    ) {
      best = { label, ...slot };
    }
  }
  return best?.label ?? null;
}

/**
 * The season's match night: the fixtures' weekly slot once any has a
 * kickoff, else the admin's text, else the deployment default.
 */
export function seasonMatchNightLabel(
  season: { matchSchedule: string | null },
  fixtures: readonly FixtureKickoff[],
  timeZone?: string,
  locale?: string,
): string {
  return (
    fixturesMatchNightLabel(fixtures, timeZone, locale) ??
    (season.matchSchedule?.trim() || MATCH_SCHEDULE.label)
  );
}
