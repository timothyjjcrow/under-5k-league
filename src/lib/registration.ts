import {
  REGISTRATION_TYPE,
  SEASON_STATUS,
  type RegistrationType,
} from "./constants";

export type RegistrationGateInput = {
  season: { maxMmr: number; status: string };
  type: RegistrationType;
  mmr: number;
  /** Whether the user already has a registration for this season. */
  hasExisting: boolean;
  /** The existing registration's type, when there is one. */
  existingType?: RegistrationType | null;
};

/**
 * Enforce signup rules: the season's MMR cap, and that PLAYER registrations
 * only *begin* during SIGNUPS. Standins may sign up any time; an existing
 * registrant may always update their signup — but a standin can't upgrade
 * themselves to a full player once signups have closed (that would sneak past
 * the closed-signups rule). Returns an error message, or null when allowed.
 */
export type WithdrawGateInput = {
  /** The registration's current status string. */
  status: string;
  /** Does this user captain a team this season? */
  isCaptain: boolean;
  /** Is this user on a roster this season? */
  isRostered: boolean;
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
}: WithdrawGateInput): string | null {
  if (status !== "ACTIVE") return "This signup isn't active.";
  if (isCaptain) {
    return "They captain a team — replace the captain first.";
  }
  if (isRostered) {
    return "They're on a roster — release them from the team first.";
  }
  return null;
}

export function registrationGate({
  season,
  type,
  mmr,
  hasExisting,
  existingType,
}: RegistrationGateInput): string | null {
  if (season.maxMmr > 0 && mmr > season.maxMmr) {
    return `This league is capped at ${season.maxMmr} MMR — you entered ${mmr}.`;
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
