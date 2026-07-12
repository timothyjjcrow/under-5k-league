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
