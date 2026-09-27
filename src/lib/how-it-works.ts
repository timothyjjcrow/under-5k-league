// The How it works page's rules, kept pure so they can be tested.

import { HARD_MMR_CEILING, REGISTRATION_STATUS, SEASON_STATUS } from "./constants";
import { LEAGUE_CONFIG } from "./league-config";
import { joinSeasonCta } from "./site-nav";

/**
 * The weekly match night to show. The admin sets it per season (Home, /me and
 * Schedule show it); the regional default only fills in when they haven't.
 * The old feature tour always showed the regional default, so it could
 * disagree with Home ("Sundays at 6:00 PM Pacific" beside "Wednesdays, 8pm
 * ET"), and on Europe, whose default is empty, it said "to be announced" after
 * the admin had announced one.
 */
export function seasonMatchNight(
  seasonSchedule: string | null | undefined,
  fallback: string = LEAGUE_CONFIG.matchSchedule.label,
): string {
  return seasonSchedule?.trim() || fallback;
}

/**
 * Who can join, in one or two sentences. `softLimit` is the season's review
 * threshold (`Season.maxMmr`; 0 = none). Only the hard ceiling turns anyone
 * away, and a Divine 3 or higher medal is over it whatever MMR is typed
 * (`registrationGate`).
 */
export function eligibilityText(softLimit: number): string {
  const ceiling = `Players up to ${HARD_MMR_CEILING.toLocaleString("en-US")} MMR can join; Divine 3 and higher medals and Immortal players can't.`;
  if (softLimit <= 0) return ceiling;
  return `${ceiling} Above ${softLimit.toLocaleString("en-US")} MMR, an admin looks over your signup before the draft.`;
}

/**
 * Standins can sign themselves up while the season needs cover: from the
 * draft through the playoffs. This is Home's rule for its "Register as a
 * standin" button (src/app/page.tsx, `standinRegistrationOpen`): no active
 * signup already, and not a signup an admin removed.
 */
export function standinSignupOpen({
  phase,
  registrationStatus,
}: {
  phase: string | null;
  registrationStatus: string | null;
}): boolean {
  return (
    (phase === SEASON_STATUS.DRAFT ||
      phase === SEASON_STATUS.REGULAR_SEASON ||
      phase === SEASON_STATUS.PLAYOFFS) &&
    registrationStatus !== REGISTRATION_STATUS.ACTIVE &&
    registrationStatus !== REGISTRATION_STATUS.REMOVED
  );
}

export type HowItWorksAction =
  | { kind: "link"; href: string; label: string }
  /** Signed out: straight to Steam, then back to `next` (sign-in-link.ts). */
  | { kind: "sign-in"; next: string; label: string }
  | { kind: "discord" }
  | { kind: "news" };

/**
 * The page's one button. During signups it is the header's "Join Season N"
 * for anyone who hasn't joined; from the draft through the playoffs it asks
 * people without a signup to stand in; otherwise it is the league Discord,
 * where the next season is announced (League news where a region has no
 * Discord invite yet).
 */
export function howItWorksAction({
  phase,
  seasonName,
  signedIn,
  registrationStatus,
  onRoster,
  hasDiscord,
}: {
  phase: string | null;
  seasonName: string | null;
  signedIn: boolean;
  /** The viewer's signup in the active season; null when there is none. */
  registrationStatus: string | null;
  onRoster: boolean;
  hasDiscord: boolean;
}): HowItWorksAction {
  const join = joinSeasonCta({
    phase,
    seasonName,
    signedIn,
    registrationStatus,
    onRoster,
  });
  // Sign-in lands on the signup form, like Home's buttons.
  if (join) {
    return signedIn
      ? { kind: "link", href: "/me", label: join.label }
      : { kind: "sign-in", next: "/me", label: join.label };
  }
  if (standinSignupOpen({ phase, registrationStatus }) && !onRoster) {
    const label = "Sign up as a standin";
    return signedIn
      ? { kind: "link", href: "/me", label }
      : { kind: "sign-in", next: "/me", label };
  }
  return hasDiscord ? { kind: "discord" } : { kind: "news" };
}
