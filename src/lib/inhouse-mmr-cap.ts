// The inhouse queue's MMR rules: the MMR a join uses whatever is typed, and
// the cap. Pure so the join (joinQueue) and the page that decides whether to
// offer Join read one rule.

import { HARD_MMR_CEILING } from "./constants";
import { MEDAL_APPROVAL_ASK_HINT } from "./medal-approval";
import { rankMedalName } from "./rank";
import { medalProvesIneligible } from "./registration";

/**
 * Where the MMR a queue join stores came from (joinQueue's trust chain): an
 * admin's inhouse MMR for the player, as set; else the newest league
 * signup's, as stored; else the number typed; else, for a blank join, the
 * player's last inhouse game's.
 */
export type InhouseMmrSource = "admin" | "signup" | "typed" | "last-game";

/** The highest inhouse MMR an admin can set, the league editor's limit too. */
export const INHOUSE_ADMIN_MMR_MAX = 12000;

/**
 * `User.inhouseMmr` as a number the chain uses: an admin's whole number from
 * 1, or null for none. saveInhouseRating writes only those, so anything else
 * (a hand edit) reads as no admin number rather than as "unknown".
 */
export function adminInhouseMmr(value: number | null | undefined): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= INHOUSE_ADMIN_MMR_MAX
    ? value
    : null;
}

/** A join's MMR that no typed number changes (inhouseFixedMmr). */
export type InhouseFixedMmr = { mmr: number; source: "admin" | "signup" };

/**
 * The MMR a queue join uses as it stands, whatever is typed: the inhouse MMR
 * an admin set for the player (Tim, 2026-10-17: admins edit any player's
 * inhouse MMR, signup or not), else the MMR an admin approved them at over
 * the medal limit (medal-approval.ts; Tim, 2026-11-21), else the newest
 * league signup's. None is clamped to the medal: each is a deliberate number
 * (an admin's call, or a signup clamped at its own save or set by an admin),
 * and the clamp is for self-reported ones. An approval's number reads as an
 * admin's, which it is. Null: the player types theirs.
 */
export function inhouseFixedMmr({
  adminMmr,
  approvedMmr = null,
  signupMmr,
}: {
  /** User.inhouseMmr: null = no admin number. */
  adminMmr: number | null;
  /** approvedMedalMmr: null = no approval over the medal limit. */
  approvedMmr?: number | null;
  /** The newest league signup's MMR, 0 = none. */
  signupMmr: number;
}): InhouseFixedMmr | null {
  const admin = adminInhouseMmr(adminMmr);
  if (admin !== null) return { mmr: admin, source: "admin" };
  if (approvedMmr !== null && approvedMmr > 0) {
    return { mmr: approvedMmr, source: "admin" };
  }
  if (signupMmr > 0) return { mmr: signupMmr, source: "signup" };
  return null;
}

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
 *
 * The one exemption is an admin's approval over the medal limit, which the
 * player asks for (medal-approval.ts; Tim, 2026-11-21): neither the medal
 * nor the number refuses them, since the admin chose the number they play
 * at, over the line or not.
 */
export function inhouseJoinRefusal({
  mmr,
  source,
  rankTier,
  approved = false,
}: {
  mmr: number;
  source: InhouseMmrSource;
  rankTier: number | null | undefined;
  /** An admin approved them over the medal limit (approvedMedalMmr). */
  approved?: boolean;
}): string | null {
  if (approved) return null;
  const cap = `Inhouses are for players up to ${MMR_FORMAT.format(HARD_MMR_CEILING)} MMR, the same as the league`;
  if (medalProvesIneligible(rankTier)) {
    return `${cap}: your ${rankMedalName(rankTier)} medal puts you above it. ${MEDAL_APPROVAL_ASK_HINT}`;
  }
  if (!(mmr > HARD_MMR_CEILING)) return null;
  const at = MMR_FORMAT.format(mmr);
  switch (source) {
    case "admin":
      return `${cap}: an admin set your inhouse MMR to ${at}.`;
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
 * the medal, or a fixed MMR (an admin's, else a league signup's) over the
 * line. A typed number is judged when it's sent (joinQueue). The page loads
 * the same facts joinQueue reads (loadInhouseJoinFacts).
 */
export function inhouseJoinRefusalBeforeTyping({
  adminMmr,
  approvedMmr = null,
  signupMmr,
  rankTier,
}: {
  /** User.inhouseMmr: null = no admin number. */
  adminMmr: number | null;
  /** approvedMedalMmr: null = no approval over the medal limit. */
  approvedMmr?: number | null;
  /** The newest league signup's MMR, 0 = none. */
  signupMmr: number;
  rankTier: number | null | undefined;
}): string | null {
  const fixed = inhouseFixedMmr({ adminMmr, approvedMmr, signupMmr });
  // With no fixed number only the medal can refuse before typing.
  return inhouseJoinRefusal({
    mmr: fixed?.mmr ?? 0,
    source: fixed?.source ?? "signup",
    rankTier,
    approved: approvedMmr !== null,
  });
}
