// The inhouse queue's MMR cap. Pure so the join (joinQueue) and the page
// that decides whether to offer Join read one rule.

import { HARD_MMR_CEILING } from "./constants";
import { rankMedalName } from "./rank";
import { medalProvesIneligible } from "./registration";

/**
 * Where the MMR a queue join stores came from (joinQueue's trust chain): the
 * newest league signup's, as stored; else the number typed; else, for a blank
 * join, the player's last inhouse game's.
 */
export type InhouseMmrSource = "signup" | "typed" | "last-game";

/** A fixed locale, so a message reads "5,000" on every server. */
const MMR_FORMAT = new Intl.NumberFormat("en-US");

/**
 * Why a player can't join the inhouse queue, or null when they can. Tim's
 * call (2026-10-11, after a Divine 4 joined on an account made 41 seconds
 * earlier): the league's own hard line, `HARD_MMR_CEILING`, the one league
 * signups enforce. A Divine 3 or higher medal is over it whatever number is
 * typed (its exact band floor is, as in registrationGate), and so is an MMR
 * over it.
 *
 * `mmr` is what the trust chain resolved, judged as it came: a typed number
 * BEFORE the medal clamp. The clamp only snaps a claim down to the medal's
 * floor, so judging the clamped number would let a big enough claim through.
 * No medal is no opinion: the typed number stands, as at signup (Tim's call,
 * the same day). Unlike registrationGate, a league signup earns no medal
 * exemption (Tim's call too): every join is judged.
 */
export function inhouseJoinRefusal({
  mmr,
  source,
  rankTier,
}: {
  mmr: number;
  source: InhouseMmrSource;
  rankTier: number | null | undefined;
}): string | null {
  const cap = `Inhouses are for players up to ${MMR_FORMAT.format(HARD_MMR_CEILING)} MMR, the same as the league`;
  if (medalProvesIneligible(rankTier)) {
    return `${cap}: your ${rankMedalName(rankTier)} medal puts you above it.`;
  }
  if (!(mmr > HARD_MMR_CEILING)) return null;
  const at = MMR_FORMAT.format(mmr);
  switch (source) {
    case "signup":
      return `${cap}: your league signup has you at ${at} MMR.`;
    case "typed":
      return `${cap}: you entered ${at}.`;
    case "last-game":
      return `${cap}: your last inhouse had you at ${at} MMR. Type your MMR to join.`;
  }
}

/**
 * The refusal the room can show before anything is typed, in place of Join:
 * the medal, or a league signup's MMR over the line. A typed number is
 * judged when it's sent (joinQueue). The page loads the same signup MMR and
 * medal joinQueue reads.
 */
export function inhouseJoinRefusalBeforeTyping({
  signupMmr,
  rankTier,
}: {
  /** The newest league signup's MMR, 0 = none. */
  signupMmr: number;
  rankTier: number | null | undefined;
}): string | null {
  return inhouseJoinRefusal({ mmr: signupMmr, source: "signup", rankTier });
}
