import { deploymentCookieName } from "./cookie-policy";

// Central place for the string-union "enums" (SQLite has no native enums) and
// tunable league defaults. Keeping these here makes the state machine explicit.
// One deliberate exception: the MatchAvailability IN|OUT union lives beside its
// math in src/lib/availability.ts, where its only consumers are.

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
export type RegistrationType =
  (typeof REGISTRATION_TYPE)[keyof typeof REGISTRATION_TYPE];

export const REGISTRATION_STATUS = {
  ACTIVE: "ACTIVE",
  /** The player withdrew themselves — they may sign up again freely. */
  WITHDRAWN: "WITHDRAWN",
  /** An ADMIN removed the signup. Distinct from WITHDRAWN so re-submitting the
   *  /me form can't silently undo a moderation decision: the upsert there sets
   *  status ACTIVE unconditionally, so before this the player just reloaded
   *  /me and signed up again. Reversible from the admin panel. */
  REMOVED: "REMOVED",
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

export const TEAM_STAFF_ROLE = {
  COACH: "COACH",
} as const;
export type TeamStaffRole =
  (typeof TEAM_STAFF_ROLE)[keyof typeof TEAM_STAFF_ROLE];

export const SCRIM_STATUS = {
  OPEN: "OPEN",
  SCHEDULED: "SCHEDULED",
  LIVE: "LIVE",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;
export type ScrimStatus = (typeof SCRIM_STATUS)[keyof typeof SCRIM_STATUS];

export const DOTA_MATCH_KIND = {
  LEAGUE: "LEAGUE",
  SCRIM: "SCRIM",
} as const;
export type DotaMatchKind =
  (typeof DOTA_MATCH_KIND)[keyof typeof DOTA_MATCH_KIND];

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

// Draft-room client poll cadence (ms). Mirrors the inhouse room's adaptive
// loop: a fixed 1.2s setInterval meant every open tab — including hidden and
// spectator ones — burned 50 req/min against /api/draft/tick's 300/min per-IP
// limit, so ~6 tabs behind one NAT could saturate it and 429 everyone. The
// room's fast rate stays its `pollMs` prop (default 1200) while the auction is
// actually live.
/**
 * Deadline on a live room's STATE POLL fetch (draft + inhouse share it).
 *
 * Both loops latch `inFlight` and clear it only in the awaited call's
 * `finally`, so a request that connects and never answers — flaky mobile data,
 * a socket resumed from a suspended tab — stops every later tick, including
 * the `visibilitychange` wake-up. Nothing settles, so `pollFail()` never runs
 * and `usePollHealth` never trips: the room sits on stale state with
 * `disconnected` FALSE and every control live. That is precisely the silent
 * freeze the health strip exists to prevent — a captain watching a frozen
 * auction sell their player. The abort throws into each loop's existing
 * `catch`, which fails the poll and reschedules, so the loop heals itself.
 *
 * Well above any healthy response (the routes' own upstream calls cap out
 * lower) and below the point where a stuck room stops being obvious.
 */
export const ROOM_POLL_TIMEOUT_MS = 10_000;

/**
 * Deadline on a room's ACTION (mutation) fetch — the same freeze as the poll,
 * from the other side: both rooms flip `pending` on before the call and off in
 * its `finally`, so a request that never answers leaves EVERY control in the
 * room disabled until the player reloads.
 *
 * Aborting a mutation is not free, though. The server keeps going, so a
 * request we gave up on may well have committed — the client can only ever say
 * "I don't know", never "that didn't go through". So the deadline has to clear
 * the worst LEGITIMATE latency, or we teach players to re-click things that
 * already landed.
 *
 * This is the DB-bound value, used by every draft action and by every inhouse
 * action except the two below. A healthy one of these is well under a second
 * (DB work plus at most a best-effort 5s Discord send).
 */
export const ROOM_ACTION_TIMEOUT_MS = 15_000;

/**
 * …and the deadline for the inhouse actions that are OpenDota-bound BY DESIGN:
 * `detect` fans out ten 8s recent-match lookups and then up to six 12s match
 * fetches, and `applyResult` adds a 5s Discord send — ~25s worst case, all
 * bounded (dota.ts never retries). `record` is one 12s fetch plus the same
 * tail.
 *
 * Deliberately NOT applied to every action. Sizing one ceiling to the slowest
 * action would punish the most time-critical one: a hung ACCEPT would sit
 * disabled for the WHOLE 45-second ready check, i.e. exactly as broken as
 * having no deadline at all. Slow paths get slack; second-sensitive ones get
 * released fast.
 */
export const INHOUSE_SCAN_ACTION_TIMEOUT_MS = 45_000;
/** The inhouse actions that legitimately go to OpenDota (see above). */
export const INHOUSE_SCAN_ACTIONS = ["detect", "record"] as const;

/**
 * Consecutive failed polls before a room declares itself disconnected (see
 * `pollHealthAfter` / `usePollHealth`). Three, not one: a single blip on mobile
 * data is normal and disabling every control for it would be its own outage —
 * but three in a row at the fast cadence is ~5 seconds of silence, which is
 * long enough that a live auction or ready check has moved without the viewer.
 */
export const ROOM_POLL_FAIL_THRESHOLD = 3;

export const DRAFT_ROOM = {
  /** Waiting room / finished draft — nothing here is second-sensitive. */
  POLL_IDLE_MS: 3000,
  /** Hidden tab belonging to someone with stake (captain, admin, or a player
   *  who could be nominated at any moment). Slower, but still fast enough for
   *  the "your turn" / "outbid" chime and tab-title flip to reach them. */
  POLL_KEEPALIVE_MS: 5000,
  /** Backoff after a 429. The tick limiter is a fixed 60s window, so easing
   *  off actually lets it drain instead of re-saturating it every 1.2s. */
  POLL_RATE_LIMITED_MS: 8000,
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
export type InhouseStatus =
  (typeof INHOUSE_STATUS)[keyof typeof INHOUSE_STATUS];

// A lobby is "active" (occupies the single live slot) until it ends.
export const INHOUSE_ACTIVE_STATUSES: InhouseStatus[] = [
  INHOUSE_STATUS.READY_CHECK,
  INHOUSE_STATUS.CAPTAIN_VOTE,
  INHOUSE_STATUS.DRAFTING,
  INHOUSE_STATUS.READY,
  INHOUSE_STATUS.IN_PROGRESS,
];

export const INHOUSE = {
  TEAM_SIZE: 5,
  LOBBY_SIZE: 10, // players needed before a lobby forms
  // The two Discord voice channels players join to talk during the game (one
  // per team). Match the channel names in the Discord server exactly — change
  // here if they're ever renamed.
  VOICE_TEAM_1: "inhouse team 1",
  VOICE_TEAM_2: "inhouse team 2",
  // Fixed custom-lobby details. The league ticket is operationally required:
  // without it Valve does not publish the private game to OpenDota, so the
  // existing player-account result scan has nothing to discover.
  LOBBY_NAME: "GGD2L Inhouse",
  LOBBY_PASSWORD: "ggd2l",
  LOBBY_TICKET: "Under 5K In-House League",
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
  // spot and a forming ready check's chime/title still reaches it. It must also
  // be shorter than BOTH action windows: a lobby can form just after a queued
  // player's poll, and a long keepalive could otherwise consume the entire
  // 45s accept window (and skip the 25s captain vote altogether). 10s leaves time
  // to notice and act while remaining comfortably inside the 90s away cutoff.
  POLL_KEEPALIVE_MS: 10000,
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
  // Floor between MANUAL "Auto-detect result" presses. Short enough that the
  // button still feels responsive, long enough that ten players spamming it
  // can't drain the shared OpenDota budget the league's result sync needs.
  DETECT_MANUAL_GAP_SECONDS: 20,
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
  //
  // MUST comfortably exceed POLL_KEEPALIVE_MS, and this is the binding case:
  // during a live game all ten tabs are HIDDEN (everyone is in the Dota
  // client), so they re-confirm on the keepalive — which Chrome can still clamp
  // toward once a minute. The admin's own fast poll can run maybeFormLobby's
  // prune BEFORE a player's clamped keepalive lands, so this window must leave
  // room or "Lobby cancelled — players re-queued" silently empties the queue.
  // 75s leaves room for the clamp; it still
  // backdates past QUEUE_AWAY_SECONDS (90), so a cancelled lobby can't
  // instantly re-form around ghosts, and past QUEUE_HEARTBEAT_SECONDS (30),
  // so a present player's very next poll writes the refresh.
  QUEUE_RECONFIRM_SECONDS: 75,
  // Reset the waiting queue when its membership has not changed for this long.
  // Presence heartbeats deliberately do NOT refresh this clock: an open tab
  // can prove a player is still online, but it must not keep one static queue
  // on the fast poll/automation cadence forever. A join, leave, lobby
  // formation, or requeue starts a fresh window for everyone still waiting.
  QUEUE_IDLE_HOURS: 4,
  // A lobby that reaches READY or IN_PROGRESS has no clock — nothing expires
  // it, and no resolver can move it — so an abandoned one holds the single
  // active-lobby slot indefinitely: no new lobby can form, and its own ten
  // players are refused the queue ("You're already in a live inhouse"). Only
  // an admin could recover it. These are the staleness floors for the lazy
  // resolveAbandonedLobby teardown, deliberately far past any legitimate use:
  // a group may sit in READY for a long time hosting the in-client lobby and
  // waiting on a straggler (Start can be pressed late — even after the game,
  // which is how a forgotten Start is still recoverable), and IN_PROGRESS must
  // outlast the longest imaginable game plus OpenDota's indexing lag.
  ABANDON_READY_HOURS: 3,
  ABANDON_IN_PROGRESS_HOURS: 6,
  // Discord "queue is filling" ping: fires when a join crosses this many
  // PRESENT players, at most once per QUEUE_PING_MIN_MINUTES.
  //
  // This was LOBBY_SIZE-2 (eight), which is a threshold the queue can almost
  // never reach on its own: the first person to queue is invisible to anyone
  // not already on the site, so nothing pulls the count upward and the ping
  // that exists to pull people in sits downstream of the problem it solves.
  // Four is early enough to be a rally and late enough to be real — half a
  // lobby is genuinely worth interrupting someone for. Raise it if the ping
  // starts crying wolf; the throttle below is the other tuning knob.
  QUEUE_PING_AT: 4,
  QUEUE_PING_MIN_MINUTES: 15,
  // Floor between EDITS of the pinned Discord queue board (inhouse-board.ts).
  // Six edits/minute worst case, and only when the rendered state actually
  // changed — a motionless queue costs zero requests. Short enough that a
  // filling queue still shows every step, long enough to stay clear of
  // Discord's (undocumented, per-webhook) execute limits, which the board
  // shares with real announcements. The board must always be the one that
  // loses a rate-limit race, never a result or a lobby ping.
  BOARD_MIN_SECONDS: 10,
} as const;

// ---------- Inhouse betting (play money — see CLAUDE.md) -------------------
//
// THE TRIPWIRE, stated first because every safety argument below rests on it:
// Cred is WORTHLESS. It cannot be bought, sold, transferred, gifted or spent
// on anything. The moment anyone proposes making it buy something real, this
// whole feature has to be reconsidered from scratch — the anti-collusion
// reasoning is only sound while there is nothing to collude FOR.

/** Per-lobby settlement state (`InhouseLobby.betSettlement`; null = no bets). */
export const INHOUSE_BET_STATUS = {
  PENDING: "PENDING",
  SETTLED: "SETTLED",
  REFUNDED: "REFUNDED",
  REVERSED: "REVERSED",
} as const;
export type InhouseBetSettlement =
  (typeof INHOUSE_BET_STATUS)[keyof typeof INHOUSE_BET_STATUS];

/** Per-bet outcome (`InhouseBet.outcome`). */
export const INHOUSE_BET_OUTCOME = {
  WON: "WON",
  LOST: "LOST",
  /** The bettor's post-teamFixes side ≠ the side they bet on — full refund. */
  VOID_LINEUP: "VOID_LINEUP",
  /** Placed after the played game's own start_time — full refund. */
  VOID_LATE: "VOID_LATE",
  /** Lobby died before a result (cancel / abandon / void) — full refund. */
  REFUNDED: "REFUNDED",
} as const;
export type InhouseBetOutcome =
  (typeof INHOUSE_BET_OUTCOME)[keyof typeof INHOUSE_BET_OUTCOME];

/** Ledger reasons (`InhouseCreditEntry.reason`). */
export const INHOUSE_CRED_REASON = {
  GRANT: "GRANT", // opening balance, once per account
  STAKE: "STAKE", // debit when the bet is placed
  RETURN: "RETURN", // unmatched portion handed back at settlement
  WIN: "WIN",
  LOSS: "LOSS",
  REFUND: "REFUND", // voided bet / dead lobby
  REVERSAL: "REVERSAL", // admin voided an already-settled result
  FLOOR: "FLOOR", // bankruptcy top-up
  ADJUST: "ADJUST", // admin correction
} as const;
export type InhouseCredReason =
  (typeof INHOUSE_CRED_REASON)[keyof typeof INHOUSE_CRED_REASON];

/**
 * Reasons that count toward the PROFIT board. Deliberately excludes GRANT,
 * FLOOR and ADJUST: the ladder ranks what you took off other players, never
 * what the system handed you. That single choice is what makes the bankruptcy
 * floor safe — a player who parks at the floor and loses forever mints
 * liquidity, but can never mint SCORE, so there is nothing to farm.
 *
 * Never add a "total staked" board beside it. Volume is the one number a
 * behaviour like "bet max every game regardless" farms perfectly.
 */
export const INHOUSE_CRED_PROFIT_REASONS: InhouseCredReason[] = [
  INHOUSE_CRED_REASON.STAKE,
  INHOUSE_CRED_REASON.RETURN,
  INHOUSE_CRED_REASON.WIN,
  INHOUSE_CRED_REASON.LOSS,
  INHOUSE_CRED_REASON.REFUND,
  INHOUSE_CRED_REASON.REVERSAL,
];

export const INHOUSE_BETS = {
  /** Opening balance — five max bets. A column default, so an existing
   *  account is funded by the schema push itself, with no backfill script. */
  START_BALANCE: 500,
  /** Stakes are chips, never a text input: a bet that needs typing doesn't
   *  happen inside a 45-second window with Dota already open. */
  MIN_STAKE: 10,
  STEP: 10,
  /**
   * FLAT, and never a fraction of balance. Two reasons, both load-bearing:
   * a newcomer and the ladder leader max out at the same number on night one
   * (so the economy can't compound into a rich-get-richer spiral), and a
   * throw conspiracy's take is bounded at five stakes — 500 Cred — per game.
   */
  MAX_STAKE: 100,
  /** The betting window, opened on the DRAFTING→READY transition. Matched to
   *  ACCEPT_SECONDS so the room keeps one rhythm; longer is a real toll on the
   *  one phase where ten people are trying to leave the browser. */
  WINDOW_SECONDS: 45,
  /** Bankruptcy net: a participant below this is topped up TO this, at most
   *  once per UTC day (enforced by the ledger's @@unique([reason, refId])). */
  FLOOR: 100,
  /** …and only after a game that looks like a game. Without this the floor
   *  pays out on 4-minute feed-fests, which is a faucet with a crank on it. */
  REAL_GAME_SECONDS: 600,
  /** Pot tiers, for the room's label and the pinned board's LIVE line. */
  TIER_CONTESTED: 200,
  TIER_HIGH: 500,
  TIER_MARQUEE: 800,
} as const;

// Match-night Discord reminder: announced by the leased maintenance worker for
// the next week whose matches kick off inside the window. Sent at most once per
// season+week (atomic Setting-row claim).
export const WEEK_REMINDER = {
  AHEAD_HOURS: 24, // announce once kickoff is within a day
  BEHIND_HOURS: 3, // still worth announcing shortly after kickoff
} as const;

// A player declaring OUT pings their captain. The "was it already OUT?" check
// alone doesn't cover a player flipping OUT→IN→OUT while they decide, and that
// used to be a harmless duplicate channel post — now it's a repeat phone buzz
// for the one person who has to find cover. Long enough to absorb the
// deciding, short enough that a genuine second withdrawal still gets through.
export const RSVP_OUT_PING_THROTTLE_SECONDS = 6 * 60 * 60;

// Automatic result sync: league games are pulled from OpenDota without anyone
// pressing a button. The bearer-authenticated maintenance worker owns writes;
// the sitewide <ResultSyncPing> only observes its cursor/watch snapshot. A
// match is scannable from shortly after kickoff (a Dota game can't be over
// sooner) until the window closes (after that it's captain/admin territory —
// no point burning API budget on a fixture nobody played).
export const AUTO_SYNC = {
  MIN_MINUTES_AFTER_KICKOFF: 25,
  WINDOW_HOURS: 48,
  // A configured Valve league id remains the cheap, authoritative first
  // result path. If a whole fixture is still missing three hours after its
  // scheduled time, roster scanning becomes the automatic recovery path for a
  // lobby that used an old/wrong ticket. A LIVE series is eligible immediately
  // so game two of a Bo2 does not wait three hours when only one lobby carried
  // the right ticket.
  LEAGUE_FALLBACK_MINUTES_AFTER_KICKOFF: 180,
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
  // …but only once the match has had a fair chance to be played. League nights
  // routinely start late, and empty scans from before anyone queued used to
  // buy hours of silence — a 2h-late start had its first result land 1-4h
  // after the games finished. For this long after the window opens, doublings
  // are capped at BACKOFF_GRACE_DOUBLINGS (240s → at most 16 min between
  // scans), so a late night is still picked up promptly.
  BACKOFF_GRACE_MINUTES: 180,
  BACKOFF_GRACE_DOUBLINGS: 2,
  // Global floor between roster scans (Setting claim): N concurrent pollers
  // can otherwise each claim a DIFFERENT due match in the same instant and
  // burst past OpenDota's per-minute cap on league nights.
  SCAN_GAP_SECONDS: 45,
  // The league-id path (one /leagues/{id}/matchIds call) is cheap; its global
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

export const LEGACY_SESSION_COOKIE = "ld2l_session";
export const SESSION_COOKIE = deploymentCookieName(LEGACY_SESSION_COOKIE);

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
