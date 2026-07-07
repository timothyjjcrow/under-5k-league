// Central place for the string-union "enums" (SQLite has no native enums) and
// tunable league defaults. Keeping these here makes the state machine explicit.

export const SEASON_STATUS = {
  SIGNUPS: "SIGNUPS",
  DRAFT: "DRAFT",
  REGULAR_SEASON: "REGULAR_SEASON",
  PLAYOFFS: "PLAYOFFS",
  COMPLETE: "COMPLETE",
} as const;
export type SeasonStatus = (typeof SEASON_STATUS)[keyof typeof SEASON_STATUS];

// Ordered progression of a season. Advancing = move to the next entry.
export const SEASON_PHASE_ORDER: SeasonStatus[] = [
  "SIGNUPS",
  "DRAFT",
  "REGULAR_SEASON",
  "PLAYOFFS",
  "COMPLETE",
];

export const REGISTRATION_TYPE = {
  PLAYER: "PLAYER",
  STANDIN: "STANDIN",
} as const;
export type RegistrationType = (typeof REGISTRATION_TYPE)[keyof typeof REGISTRATION_TYPE];

export const REGISTRATION_STATUS = {
  ACTIVE: "ACTIVE",
  WITHDRAWN: "WITHDRAWN",
} as const;

export const DRAFT_STATUS = {
  NOT_STARTED: "NOT_STARTED",
  IN_PROGRESS: "IN_PROGRESS",
  PAUSED: "PAUSED",
  COMPLETE: "COMPLETE",
} as const;
export type DraftStatus = (typeof DRAFT_STATUS)[keyof typeof DRAFT_STATUS];

export const MATCH_STATUS = {
  SCHEDULED: "SCHEDULED",
  LIVE: "LIVE",
  COMPLETED: "COMPLETED",
} as const;

export const MATCH_PHASE = {
  REGULAR: "REGULAR",
  PLAYOFF: "PLAYOFF",
  FINAL: "FINAL",
} as const;

export const ROLE = {
  USER: "USER",
  ADMIN: "ADMIN",
} as const;

// League defaults (also stored per-Season so they can be overridden).
export const DEFAULTS = {
  TEAM_SIZE: 5,
  MIN_TEAMS: 4,
  DRAFT_BUDGET: 100,
  // Seconds the auction clock runs for a nominated player; each new bid resets it.
  BID_TIMER_SECONDS: 30,
  // Seconds the team on the clock has to nominate before the draft auto-picks
  // the top available player for them (keeps a live draft from stalling).
  NOMINATION_TIMER_SECONDS: 90,
  // Minimum opening nomination bid.
  MIN_BID: 1,
} as const;

export const SESSION_COOKIE = "ld2l_session";
