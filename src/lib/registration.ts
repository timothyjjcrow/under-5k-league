import {
  HARD_MMR_CEILING,
  REGISTRATION_TYPE,
  SEASON_STATUS,
  type RegistrationType,
} from "./constants";
import { rankMedalName, rankTierExactMinMmr } from "./rank";

export type RegistrationGateInput = {
  season: { maxMmr: number; status: string };
  type: RegistrationType;
  /**
   * The RAW claimed MMR — never the medal-clamped value. The clamp snaps
   * implausible claims DOWN to a medal floor (always under the ceiling), so
   * gating the clamped number would let any medaled player through by
   * overstating: the bigger the lie, the more acceptable it becomes.
   */
  mmr: number;
  /** OpenDota medal, when known — a 5K+ medal is ineligible whatever they type. */
  rankTier?: number | null;
  /** Whether the user already has a registration for this season. */
  hasExisting: boolean;
  /** The existing registration's type, when there is one. */
  existingType?: RegistrationType | null;
};

export type WithdrawGateInput = {
  /** The registration's current status string. */
  status: string;
  /** Does this user captain a team this season? */
  isCaptain: boolean;
  /** Is this user on a roster this season? */
  isRostered: boolean;
  /** Is this user the lot currently under the hammer in a live auction? */
  isOnTheBlock?: boolean;
  /**
   * Standin assignments this user holds on UNPLAYED matches. A withdrawal that
   * leaves these behind is invisible: nothing downstream re-checks registration
   * status, so `matchNightRoster` keeps swapping the covered player out for a
   * standin who has left the league — the team shows as covered right up to
   * kickoff, and the ex-standin's own /me stops listing the match (it filters on
   * ACTIVE), so they get no reminder either.
   */
  pendingAssignments?: number;
};

/**
 * Whether a signup can be withdrawn (by the player or an admin). Rostered
 * players and captains must be released/replaced first — withdrawing them
 * would silently orphan a team. Returns an error message, or null when OK.
 */
export function withdrawGateError({
  status,
  isCaptain,
  isRostered,
  isOnTheBlock,
  pendingAssignments = 0,
}: WithdrawGateInput): string | null {
  if (status !== "ACTIVE") return "This signup isn't active.";
  // The admin path checked this inline; the SELF path didn't, so a player
  // could withdraw while captains were actively bidding on them — every draft
  // room rendered a headless auction and the expiring lot was voided.
  if (isOnTheBlock) {
    return "They're on the auction block right now — wait for the lot to settle.";
  }
  if (isCaptain) {
    return "They captain a team — replace the captain first.";
  }
  if (isRostered) {
    return "They're on a roster — release them from the team first.";
  }
  // Refuse rather than auto-cancelling: the captain who arranged the cover is
  // the one who needs to know the seat is open again, and silently deleting the
  // assignment would take that news away from them. Same rule and wording family
  // as promoteGateError, which already blocks on this.
  if (pendingAssignments > 0) {
    return "They're standing in for an unplayed match — remove that assignment first.";
  }
  return null;
}

/**
 * Enforce signup rules: the hard MMR ceiling, and that PLAYER registrations
 * only *begin* during SIGNUPS. The soft limit (`season.maxMmr`) does NOT block
 * signup — players above it join and are reviewed before the draft; only the
 * `HARD_MMR_CEILING` (no 5K+/Immortals) is a firm reject. Standins may sign up
 * any time; an existing registrant may always update their signup — but a
 * standin can't upgrade themselves to a full player once signups have closed
 * (that would sneak past the closed-signups rule). Returns an error message,
 * or null when allowed.
 */
export function registrationGate({
  season,
  type,
  mmr,
  rankTier,
  hasExisting,
  existingType,
}: RegistrationGateInput): string | null {
  // The soft limit (season.maxMmr) is a review threshold, not a block — only
  // the hard ceiling turns anyone away (keeps out 5K+ players and Immortals).
  if (mmr > HARD_MMR_CEILING) {
    return `This league doesn't take players over ${HARD_MMR_CEILING} MMR — you entered ${mmr}.`;
  }
  // The medal alone can prove ineligibility: a Divine 3+/Immortal medal means
  // 5K+ MMR whatever number is typed (its EXACT band floor is over the
  // ceiling — no padding here, padding is for validating claims). Without
  // this, sandbagging a low claim under a high medal walks past the ceiling.
  if (medalProvesIneligible(rankTier)) {
    return `This league doesn't take players over ${HARD_MMR_CEILING} MMR — your ${rankMedalName(rankTier)} medal puts you above it.`;
  }
  const wasPlayer = hasExisting && existingType === REGISTRATION_TYPE.PLAYER;
  if (
    type === REGISTRATION_TYPE.PLAYER &&
    !wasPlayer &&
    season.status !== SEASON_STATUS.SIGNUPS
  ) {
    return "Player signups are closed for this season";
  }
  return null;
}

/**
 * Does a medal we only learned about LATER prove an already-stored signup
 * ineligible? Same medal-floor rule `registrationGate` applies at signup — but
 * that gate only runs when the player submits, and a stored MMR is treated as
 * league-approved (an unchanged resubmit is never re-judged, so an admin's
 * setRegistrationMmr correction survives). So a player who signs up before
 * linking a Dota account — or while OpenDota is unreachable — is admitted with
 * `rankTier: null`, and when the admin's later "Sync ranks" fills in a Divine
 * 3+/Immortal medal, nothing re-checks: they stay ACTIVE, over the ceiling.
 *
 * This is the detector for that gap. It never removes anyone — who plays is the
 * operator's call — it just lets the sync say "these N need a look".
 */
export function medalProvesIneligible(rankTier: number | null | undefined): boolean {
  const medalFloor = rankTierExactMinMmr(rankTier);
  return medalFloor != null && medalFloor > HARD_MMR_CEILING;
}

export type PromoteGateInput = {
  seasonStatus: string;
  /** Draft row status, or null when no draft row exists yet. */
  draftStatus: string | null;
  registrationStatus: string;
  registrationType: string;
  /** Standin assignments on this season's UNPLAYED matches. */
  pendingAssignments: number;
};

/**
 * Why an admin can't promote this standin to a full player (null = can).
 * The mid-season roster refill path: registrationGate closes self-serve
 * PLAYER signups after SIGNUPS, so late joiners file as standins and an
 * admin upgrades them here before signing them via the free-agent form.
 */
export function promoteGateError(i: PromoteGateInput): string | null {
  if (i.seasonStatus === "SIGNUPS") {
    return "Signups are open — they can just switch to Player on their own profile.";
  }
  if (i.seasonStatus === "COMPLETE") return "The season is over.";
  // Live auction: the pool is ACTIVE PLAYER registrations, so promoting
  // mid-run would inject them into the running draft. Pre-start (they'll be
  // auctioned normally) and post-draft (free-agent top-up) are both fine.
  if (
    i.seasonStatus === "DRAFT" &&
    (i.draftStatus === "IN_PROGRESS" || i.draftStatus === "PAUSED")
  ) {
    return "The draft is live — promote before it starts or after it completes.";
  }
  if (i.registrationStatus !== "ACTIVE") return "This signup isn't active.";
  if (i.registrationType !== "STANDIN") return "They're already a full player.";
  if (i.pendingAssignments > 0) {
    return "They're assigned as a standin for an unplayed match — remove that assignment first.";
  }
  return null;
}
