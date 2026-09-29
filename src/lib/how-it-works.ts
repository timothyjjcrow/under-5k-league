// The How it works page's rules, kept pure so they can be tested.

import { REGISTRATION_STATUS, SEASON_STATUS } from "./constants";
import { NO_TICKET_RESULT_LEAD } from "./match-hosting";
import { mmrCeilingPhrase } from "./season-copy";
import { joinSeasonCta } from "./site-nav";

/**
 * How results get recorded: the end of the "Weekly matches and playoffs" step
 * and the answer to "How do our games get recorded?". `hasLeagueTicket` is
 * whether the active season has a Valve league ticket (`Season.dotaLeagueId`),
 * or null between seasons, when the next season's ticket isn't known yet.
 *
 * Only a ticketed season may say results arrive by themselves. Without a
 * ticket a private lobby may never reach OpenDota, so this says what the
 * match page says (match-hosting.ts): the result may not appear on its own,
 * the captain adds it by match ID, and if nothing finds the game an admin
 * takes the score. Public match data is only mentioned where it helps: it
 * can't get a ticketless private lobby onto OpenDota.
 */
export function resultsCopy(hasLeagueTicket: boolean | null): {
  step: string;
  faq: string;
} {
  if (hasLeagueTicket === true) {
    return {
      step: "Results come in from Dota by themselves, and the top of the table goes to the playoffs.",
      faq: "Follow the lobby setup on your match page and turn on Expose Public Match Data in Dota's settings. Results then import from OpenDota; if a game doesn't show up, your captain can add it by match ID.",
    };
  }
  if (hasLeagueTicket === false) {
    return {
      step: "This season has no league ticket yet, so captains may need to add results on the match page. The top of the table goes to the playoffs.",
      faq: `Follow the lobby setup on your match page. ${NO_TICKET_RESULT_LEAD} If it doesn't, your captain adds it on the match page by its Dota match ID, and if the game can't be found, sends an admin the score.`,
    };
  }
  return {
    step: "Results are recorded from your Dota games, and the top of the table goes to the playoffs.",
    faq: "Follow the lobby setup on your match page. When the season has a Dota league ticket, results import by themselves. If a game doesn't show up, your captain adds it on the match page by its Dota match ID, and if the game can't be found, sends an admin the score.",
  };
}

/**
 * Who can join, in one or two sentences. `softLimit` is the season's review
 * threshold (`Season.maxMmr`; 0 = none, and also what to pass between
 * seasons, when the next season's threshold isn't known yet). Only the hard ceiling turns anyone
 * away, and a Divine 3 or higher medal is over it whatever MMR is typed
 * (`registrationGate`).
 */
export function eligibilityText(softLimit: number): string {
  const ceiling = `Players ${mmrCeilingPhrase()} can join; Divine 3 and higher medals and Immortal players can't.`;
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
    const label = "Register as a standin";
    return signedIn
      ? { kind: "link", href: "/me", label }
      : { kind: "sign-in", next: "/me", label };
  }
  return hasDiscord ? { kind: "discord" } : { kind: "news" };
}
