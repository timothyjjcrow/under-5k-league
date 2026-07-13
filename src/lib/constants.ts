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

// ---------- Fantasy ----------

export const FANTASY = {
  /** Roster slots in a fantasy five. */
  SLOTS: 5,
  /** MMR salary cap = league-average rostered MMR × SLOTS × CAP_SLACK. */
  CAP_SLACK: 1.05,
  // Scoring weights, applied per imported game.
  KILL: 3,
  ASSIST: 1.5,
  DEATH: -1,
  WIN: 10,
  /** Points per GPM (economy signal without dwarfing kills). */
  GPM: 0.02,
  /** Points per last hit. */
  LAST_HIT: 0.02,
} as const;

// ---------- Inhouse (casual pick-up mode, separate from the league) ----------

export const INHOUSE_STATUS = {
  CAPTAIN_VOTE: "CAPTAIN_VOTE",
  DRAFTING: "DRAFTING",
  READY: "READY",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;
export type InhouseStatus = (typeof INHOUSE_STATUS)[keyof typeof INHOUSE_STATUS];

// A lobby is "active" (occupies the single live slot) until it ends.
export const INHOUSE_ACTIVE_STATUSES: InhouseStatus[] = [
  INHOUSE_STATUS.CAPTAIN_VOTE,
  INHOUSE_STATUS.DRAFTING,
  INHOUSE_STATUS.READY,
  INHOUSE_STATUS.IN_PROGRESS,
];

// How a filled lobby elects its captains — players vote on this each game.
export const CAPTAIN_METHOD = {
  VOTE: {
    key: "VOTE",
    label: "Elect captains",
    hint: "Vote for the players you want to captain",
  },
  MMR: {
    key: "MMR",
    label: "Highest MMR",
    hint: "The two highest-MMR players captain",
  },
  RECORD: {
    key: "RECORD",
    label: "Best record",
    hint: "The two best inhouse records captain",
  },
} as const;

export const INHOUSE = {
  TEAM_SIZE: 5,
  LOBBY_SIZE: 10, // players needed before a lobby forms
  // Seconds players get to vote on how captains are chosen once a lobby fills.
  VOTE_SECONDS: 25,
  // Seconds a captain has to pick before the draft auto-picks the top player.
  PICK_SECONDS: 60,
  // The lower-seeded captain (team 2) drafts first, a small nod to the fact
  // that team 1's captain is the higher-seeded player. Strict back-and-forth after.
  FIRST_PICK_TEAM: 2,
  // Auto result detection (OpenDota): don't scan until a game could plausibly be
  // over, and don't scan more than once per interval (there's only ever one
  // active lobby, so this bounds API usage globally).
  DETECT_MIN_MINUTES: 8,
  DETECT_INTERVAL_SECONDS: 180,
} as const;

export const SESSION_COOKIE = "ld2l_session";

// Community — the league's Discord invite.
export const DISCORD_INVITE_URL = "https://discord.gg/YkTWVfZRY";

// Weekly match slot — surfaced before signup so players know the commitment.
// Change here to adjust it league-wide (can become a per-season setting later).
export const MATCH_SCHEDULE = {
  day: "Sundays",
  time: "6:00 PM",
  timezone: "PST",
  /** Full human label shown wherever the match time appears. */
  label: "Sundays at 6:00 PM PST",
} as const;

// Dota 2 matchmaking region every league game is hosted on. Surfaced on the
// home page so players know where they'll be playing. Change here to adjust it
// league-wide.
export const GAME_SERVER_REGION = "US East" as const;
