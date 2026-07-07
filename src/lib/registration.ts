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
};

/**
 * Enforce signup rules: the season's MMR cap, and that a *new* full-player
 * signup only happens during SIGNUPS. Standins may sign up any time, and an
 * existing registrant may always update their signup. Returns an error message,
 * or null when the registration is allowed.
 */
export function registrationGate({
  season,
  type,
  mmr,
  hasExisting,
}: RegistrationGateInput): string | null {
  if (season.maxMmr > 0 && mmr > season.maxMmr) {
    return `This league is capped at ${season.maxMmr} MMR — you entered ${mmr}.`;
  }
  if (
    !hasExisting &&
    type === REGISTRATION_TYPE.PLAYER &&
    season.status !== SEASON_STATUS.SIGNUPS
  ) {
    return "Player signups are closed for this season";
  }
  return null;
}
