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
  READY_CHECK: "READY_CHECK",
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
  INHOUSE_STATUS.READY_CHECK,
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
  // Inhouse room client poll cadence (ms). The room polls fast while the
  // viewer has skin in the game — in a lobby (ready check / vote / draft /
  // live) or waiting in the queue, where seconds matter — and idle-slow when
  // just spectating a page that updates lazily. The fast rate is the room's
  // `pollMs` prop (default 1500).
  POLL_IDLE_MS: 10000,
  // Hidden-tab keepalive (ms). A hidden tab with NO stake (not queued, not in a
  // lobby) doesn't fetch at all — the sitewide /api/sync ping keeps lobbies
  // advancing, and it re-syncs on refocus. But a hidden tab that's IN THE QUEUE
  // (or a lobby) keeps a slow keepalive so its presence heartbeat holds the
  // spot and a forming ready check's chime/title still reaches it. 45s keeps
  // lastSeenAt inside QUEUE_AWAY_SECONDS (90) even after Chrome clamps hidden
  // timers toward once a minute — which is exactly why that window is generous.
  POLL_KEEPALIVE_MS: 45000,
  // Seconds to press ACCEPT once a lobby fills (the Dota-style ready check).
  // Generous vs. the client's ~10s: web players may be in another tab — the
  // chime + "(!)" tab title have to reach them first.
  ACCEPT_SECONDS: 45,
  // Seconds players get to vote on how captains are chosen once everyone accepts.
  VOTE_SECONDS: 25,
  // Seconds a captain has to pick before the draft auto-picks the top player.
  PICK_SECONDS: 60,
  // The lower-seeded captain (team 2) drafts first, a small nod to the fact
  // that team 1's captain is the higher-seeded player. A SNAKE draft follows
  // (single, then pairs, closing on a single) so first pick isn't a standing
  // advantage — see nextPickTeam.
  FIRST_PICK_TEAM: 2,
  // Auto result detection (OpenDota): don't scan until a game could plausibly be
  // over, and don't scan more than once per interval (there's only ever one
  // active lobby, so this bounds API usage globally). The interval grows with
  // the game's age — an abandoned IN_PROGRESS lobby nobody cancels must not
  // scan every 3 minutes forever — up to the cap.
  DETECT_MIN_MINUTES: 8,
  DETECT_INTERVAL_SECONDS: 180,
  DETECT_INTERVAL_MAX_SECONDS: 1800,
  // Queue presence: a spot is held by keeping /inhouse open — each state poll
  // refreshes the entry's lastSeenAt heartbeat, throttled to one write per
  // interval so ten 1.5s pollers don't produce a constant write stream.
  QUEUE_HEARTBEAT_SECONDS: 30,
  // Seen longer ago than this = "away": still listed, but doesn't count toward
  // forming a lobby or the public queue count. Generous because Chrome
  // throttles hidden tabs' timers toward once a minute.
  QUEUE_AWAY_SECONDS: 90,
  // Silent past this = dropped from the queue entirely (ghost cleanup).
  QUEUE_DROP_SECONDS: 180,
  // After an admin cancels a lobby its players are re-queued with a backdated
  // heartbeat: anyone still polling re-confirms within this window; the ghosts
  // that likely caused the cancel never do, so the same lobby can't instantly
  // re-form around them.
  QUEUE_RECONFIRM_SECONDS: 45,
  // Discord "almost there" ping: fires when a join crosses LOBBY_SIZE-2
  // present players, at most once per this window (leave/rejoin churn at the
  // threshold must not spam the channel).
  QUEUE_PING_MIN_MINUTES: 15,
} as const;

// Match-night Discord reminder: announced lazily from dashboard//schedule
// renders for the next week whose matches kick off inside the window. Sent at
// most once per season+week (atomic Setting-row claim).
export const WEEK_REMINDER = {
  AHEAD_HOURS: 24, // announce once kickoff is within a day
  BEHIND_HOURS: 3, // still worth announcing shortly after kickoff
} as const;

// Automatic result sync: league games are pulled from OpenDota without anyone
// pressing a button. Driven lazily by the sitewide <ResultSyncPing> hitting
// POST /api/sync (no cron/websocket — same philosophy as the draft clock).
// A match is scannable from shortly after kickoff (a Dota game can't be over
// sooner) until the window closes (after that it's captain/admin territory —
// no point burning API budget on a fixture nobody played).
export const AUTO_SYNC = {
  MIN_MINUTES_AFTER_KICKOFF: 25,
  WINDOW_HOURS: 48,
  // One roster scan is ~10 recentMatches + up to 12 match fetches, so each
  // match is rescanned at most once per interval, ONE match per sync run —
  // that keeps worst-case OpenDota usage inside the free tier on a full
  // league night while every series still lands within minutes.
  MATCH_INTERVAL_SECONDS: 240,
  // Consecutive EMPTY scans double a match's rescan interval (capped at
  // MATCH_INTERVAL << BACKOFF_DOUBLINGS ≈ 4.3h), so a fixture that never
  // yields games — forfeit, no-show, private match data — costs a handful of
  // scans across its whole 48h window instead of one every 4 minutes. Any
  // imported game resets the counter (a live Bo3 keeps rescanning briskly).
  BACKOFF_DOUBLINGS: 6,
  // Global floor between roster scans (Setting claim): N concurrent pollers
  // can otherwise each claim a DIFFERENT due match in the same instant and
  // burst past OpenDota's per-minute cap on league nights.
  SCAN_GAP_SECONDS: 45,
  // The league-id path (one /leagues/{id}/matches call) is cheap; its global
  // throttle can be tighter.
  LEAGUE_INTERVAL_SECONDS: 180,
  // Automated league-id runs fetch at most this many unknown game ids per run
  // (a typo'd league id can list thousands) and remember ids that fetched but
  // didn't import so they're never refetched. The admin's manual sync button
  // bypasses both (rosters/standins may have changed since an id was skipped).
  LEAGUE_MAX_FETCHES_PER_RUN: 25,
  LEAGUE_SKIP_MEMORY: 1000,
  // Client ping cadence: fast while matches are in their detection window or
  // an inhouse game is live (so parked dashboards update themselves), slow
  // otherwise (a near-free keepalive that notices a window opening).
  WATCH_POLL_SECONDS: 60,
  IDLE_POLL_SECONDS: 300,
} as const;

export const SESSION_COOKIE = "ld2l_session";

// Community — the league's Discord invite.
export const DISCORD_INVITE_URL = "https://discord.gg/H7PJ4VxUGh";

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

// MMR policy. 4.5K is a SOFT limit, not a hard cap: players above it can still
// sign up, but they're reviewed before the draft (`Season.maxMmr` is that
// per-season soft/review threshold — default `SOFT_MMR_LIMIT`, 0 = no soft
// limit). `HARD_MMR_CEILING` is the one firm line the site actually enforces —
// nobody over it can join — which keeps out 5K+ players and Immortals.
export const SOFT_MMR_LIMIT = 4500 as const;
export const HARD_MMR_CEILING = 5000 as const;
