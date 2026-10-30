import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { eventLog } from "./event-log.mjs";
import { LOBBY_CHANNEL_TYPE, lobbyChannelName } from "./lobby-wire.mjs";
import { KEY_PATTERN, gameModeFor, keyKind, sideSize } from "./lobby-kind.mjs";
import {
  CHAT_JOIN_TIMEOUT_MS,
  CHAT_LINE_GAP_MS,
  CHAT_MAX_JOINS,
  CHAT_QUEUE_MAX,
  CHAT_STALE_MS,
  greeting,
  greetLine,
  moveLine,
  rosterNames,
  seatHelpKey,
  seatPlan,
} from "./seat-help.mjs";

export class BotError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function validRegions(regions) {
  return Array.isArray(regions) && regions.length >= 1 && regions.length <= 2 &&
    regions.every((region) => [2, 3].includes(region)) && new Set(regions).size === regions.length;
}

export function validSpec(s, serverRegion = 2) {
  const regions = Array.isArray(serverRegion) ? serverRegion : [serverRegion];
  const ids = [...(s?.radiant ?? []), ...(s?.dire ?? [])];
  const europeanKey = typeof s?.key === "string" && s.key.startsWith("eu:");
  return (
    typeof s?.key === "string" &&
    KEY_PATTERN.test(s.key) &&
    typeof s.name === "string" &&
    s.name.length > 0 &&
    s.name.length <= 128 &&
    typeof s.password === "string" &&
    s.password.length >= 5 &&
    s.password.length <= 64 &&
    Number.isInteger(s.leagueId) &&
    s.leagueId > 0 &&
    s.leagueId <= 0xffffffff &&
    // Captains Mode for season and inhouse games, 1v1 Solo Mid for a duel.
    s.gameMode === gameModeFor(s.key) &&
    validRegions(regions) &&
    regions.includes(s.serverRegion) &&
    // Shared workers reserve legacy keys for the US. EU always carries its
    // namespace, so equal IDs in the two databases cannot claim the same job.
    (!europeanKey || s.serverRegion === 3) &&
    (regions.length === 1 || s.serverRegion === (europeanKey ? 3 : 2)) &&
    Array.isArray(s.radiant) &&
    Array.isArray(s.dire) &&
    s.radiant.length <= 10 &&
    s.dire.length <= 10 &&
    // A duel is exactly one player a side, two different players.
    (keyKind(s.key) !== "duel" ||
      (s.radiant.length === 1 && s.dire.length === 1 && s.radiant[0] !== s.dire[0])) &&
    ids.every(
      (id) =>
        typeof id === "string" &&
        /^\d{17}$/.test(id) &&
        BigInt(id) > 76561197960265728n &&
        BigInt(id) <= 76561202255233023n,
    )
  );
}

export function settingsMatch(lobby, spec) {
  return (
    lobby &&
    lobby.gameName === spec.name &&
    lobby.passKey === spec.password &&
    lobby.leagueid === spec.leagueId &&
    lobby.gameMode === spec.gameMode &&
    lobby.serverRegion === spec.serverRegion &&
    !lobby.allowCheats &&
    !lobby.fillWithBots &&
    lobby.seriesType === 0
  );
}

// Only memberIndices refer to current members; allMembers can retain slots.
function currentMembers(lobby) {
  return (lobby?.memberIndices ?? [])
    .map((i) => lobby.allMembers?.[i])
    .filter(Boolean);
}

function roster(spec) {
  return [...new Set([...spec.radiant, ...spec.dire])];
}

// A resend inside this window, or past this many per player, sends nothing,
// so a repeated or retried press can't flood a player with invites.
export const INVITE_RESEND_MS = 30_000;
export const INVITE_MAX_PER_PLAYER = 5;
// Dota shows a Launch it accepted within seconds: the lobby leaves the lobby
// screen. A launched lobby still on the lobby screen this long after Start
// never launched, so it is over and may be released.
export const LAUNCH_SETTLE_MS = 2 * 60_000;
// A lobby nobody starts is released once it has sat this long on the lobby
// screen with nobody joining, leaving or changing sides, so a game given up
// during setup (or cancelled on the site) can't hold the one bot for good.
export const IDLE_RELEASE_MS = 30 * 60_000;
// A duel lobby nobody starts frees the bot sooner: two players either show
// up within minutes or not at all, and the bot is wanted for the next game.
export const DUEL_IDLE_RELEASE_MS = 10 * 60_000;
const idleReleaseMs = (key) => (keyKind(key) === "duel" ? DUEL_IDLE_RELEASE_MS : IDLE_RELEASE_MS);
// A launch still assigning or setting up a server this long after Start is
// dead: Dota does either in seconds. Leaving then can't cost a real game.
export const LAUNCH_STALL_MS = 10 * 60_000;
// A create or launch Dota hasn't confirmed this long reads blocked ("Lobby
// needs attention"). status() shows it at once; tick() saves it.
export const UNCONFIRMED_MS = 30_000;
// Dota confirms a Leave it acted on within seconds (Destroy, a removal, an
// unsubscribe, or a complete welcome with no lobby). Past this, the bot asks
// the Game Coordinator again where it is: a resync.
export const LEAVE_CONFIRM_MS = 20_000;
// At least this long between two resyncs, and at most this many for one job,
// so a lobby the Game Coordinator keeps replaying can never make the bot
// cycle its session in a loop. Saved, so a restart doesn't reset them.
export const RESYNC_MIN_INTERVAL_MS = 60_000;
export const MAX_RESYNCS_PER_JOB = 3;
// A started game with no end seen this long after Start gets one resync: no
// in-house game runs that long, so the bot's picture of it is likely stale.
export const STARTED_BACKSTOP_MS = 3 * 60 * 60_000;
// A check that found a game's lobby still running stands for this long. A
// later Release or BUSY Create may then ask again (within resync()'s limits),
// so an end Dota showed and the bot never got (2026-10-18) holds the bot
// about this long past the check, not until the backstop.
export const RECHECK_AFTER_MS = 15 * 60_000;
// Early leave (DOTA_BOT_EARLY_LEAVE, off unless a kind is listed): once a
// launched game is under way (its hero draft on) the bot sends AbandonCurrentGame and a Leave,
// so it is free for the next game instead of sitting in this one's lobby
// until its postgame. At most this many tries a job, this far apart; a try
// Dota doesn't confirm within LEAVE_CONFIRM_MS is no resync, the bot simply
// stays to the postgame as before.
export const EARLY_LEAVE_MAX_TRIES = 2;
export const EARLY_LEAVE_GAP_MS = 60_000;
// The DOTA_GameState values an early leave may go out at (Tim's call,
// 2026-10-30: leave at picks, so a second game's lobby waits minutes, not the
// whole draft): HERO_SELECTION (2), STRATEGY_TIME (3), PRE_GAME (4),
// GAME_IN_PROGRESS (5) and TEAM_SHOWCASE (8). Every player has loaded by
// then, so a failed load (WAIT_FOR_PLAYERS_TO_LOAD, 1) or a server that never
// started (no game state, 0) is past. Never POST_GAME (6) or the custom-game
// states.
export const EARLY_LEAVE_GAME_STATES = [2, 3, 4, 5, 8];
// A game the bot left early can't show it its postgame, so it asks the Game
// Coordinator for the match's details instead (k_EMsgGCMatchDetailsRequest):
// first this long after the leave, then once a minute, one request in flight
// (dropped after DETAILS_TIMEOUT_MS), until an outcome or DETAILS_FOR_MS.
export const DETAILS_AFTER_MS = 8 * 60_000;
export const DETAILS_EVERY_MS = 60_000;
export const DETAILS_TIMEOUT_MS = 30_000;
export const DETAILS_FOR_MS = 3 * 60 * 60_000;

/** Named invite targets must be on the request's own roster. */
export function validInviteTargets(spec) {
  if (spec.invite === undefined) return true;
  const players = roster(spec);
  return (
    Array.isArray(spec.invite) &&
    spec.invite.length >= 1 &&
    spec.invite.length <= 20 &&
    new Set(spec.invite).size === spec.invite.length &&
    spec.invite.every((id) => players.includes(id))
  );
}

export function rosterMatches(lobby, spec) {
  // These are GC team enums (0/1), distinct from match-data Radiant/Dire 2/3.
  // Five a side, or one in a duel (lobby-kind.mjs).
  const members = currentMembers(lobby);
  const size = sideSize(spec.key);
  return (
    [spec.radiant, spec.dire].every((expected, side) => {
      const actual = members.filter((m) => m.team === side).map((m) => m.id);
      return (
        expected.length === size &&
        actual.length === size &&
        new Set(expected).size === size &&
        expected.every((id) => actual.includes(id))
      );
    }) && new Set([...spec.radiant, ...spec.dire]).size === size * 2
  );
}

// EMatchOutcome: 2 to 13 name a winner; 64 to 69 are Dota's "not scored"
// (poor network, a leaver, a server crash, never started, cancelled).
const won = (outcome) => outcome >= 2 && outcome <= 13;
const notScored = (outcome) => outcome >= 64 && outcome <= 69;
// DOTA_GameState's DOTA_GAMERULES_STATE_POST_GAME.
const POST_GAME = 6;

/** Dota shows the game's end, so the bot may leave: its postgame (lobby state
 * 3), or a lobby still reading RUN whose outcome or game state already says
 * the game ended. Leaving only: a RUN lobby at the post-game game state with
 * no outcome yet says nothing about the result (recordEnd). */
const atPostgame = (lobby) =>
  lobby.state === 3 ||
  (lobby.state === 2 && (won(lobby.matchOutcome) || lobby.gameState === POST_GAME));

/** Record the game's end on its job: its postgame (lobby state 3), or a
 * winner however it arrives. Never the post-game game state alone, at RUN with
 * no outcome yet: a launch Dota then calls not scored, or sends back to the
 * lobby screen, must still read as failed, never as played or `over`. Any
 * later snapshot's outcome replaces an unknown (none yet, or 0) or not-scored
 * one; a winner is never replaced, so a played game stays played. True when
 * it changed the job. */
function recordEnd(job, lobby, now) {
  const before = [job.postgameSeen, job.postgameOutcome, job.postgameAt];
  if (lobby.state === 3 || won(lobby.matchOutcome)) {
    job.postgameSeen = true;
    job.postgameAt ??= now;
  }
  if (job.postgameSeen === true && !won(job.postgameOutcome) && lobby.matchOutcome)
    job.postgameOutcome = lobby.matchOutcome;
  return [job.postgameSeen, job.postgameOutcome, job.postgameAt].some((value, i) => value !== before[i]);
}

/** Leave now? Never during RUN: the Game Coordinator ignores a Leave while
 * the game runs (every played game through 2026-10-18 kept the bot until its
 * postgame). Never during server allocation, unless that launch stalled. */
function safeToLeave(lobby, job, now) {
  return (
    atPostgame(lobby) ||
    (lobby.state === 0 && !job.launchRequested && job.state !== "starting") ||
    launchOver(lobby, job, now) ||
    launchStalled(lobby, job, now)
  );
}

/** A game Dota still shows running, with no sign of its end. */
/** Whether a game's lobby may be checked (resync) again: never checked, or
 * its last check is RECHECK_AFTER_MS old. resync() keeps its own limits. */
function checkDue(job, now) {
  return job.verifiedAt === undefined || now - job.verifiedAt >= RECHECK_AFTER_MS;
}

const stillRunning = (lobby) => lobby.state === 2 && !atPostgame(lobby);

const hasMatchId = (lobby) => !!lobby.matchId && lobby.matchId !== "0";

/** A launched job's lobby back on Dota's lobby screen, its launch over: Dota
 * showed it (the lobby ran, set a server up, or carries the launch's match
 * id), or Start was long enough ago that it never launched at all. Never the
 * stale UI snapshot right after Launch, which shows none of those. Only the
 * bot, its leader, could launch it again, so holding it would answer BUSY to
 * every next Create. */
function launchOver(lobby, job, now) {
  return (
    lobby.state === 0 &&
    (job.state === "started" ||
      (!!job.launchRequested &&
        (job.launchSeen === true ||
          hasMatchId(lobby) ||
          now - job.changedAt >= LAUNCH_SETTLE_MS)))
  );
}

/** A launch stuck assigning or setting up a server long after it began:
 * the bot's Start, or the moment the lobby left the lobby screen when a
 * player who took the lead launched it. */
function launchStalled(lobby, job, now) {
  const since = job.launchRequested ? job.changedAt : job.leftLobbyAt;
  return (
    [1, 4, 5, 6].includes(lobby.state) &&
    since != null &&
    now - since >= LAUNCH_STALL_MS
  );
}

/** The game was played: Dota names a winner, or showed its postgame without
 * calling it not scored. Anything else that comes back failed to load, or
 * never started. */
function played(lobby, job) {
  return (
    won(lobby.matchOutcome) ||
    (job.postgameSeen === true && !notScored(job.postgameOutcome))
  );
}

/** The site's `over`: this job's game was played and Dota showed its end
 * with a winner (recordEnd keeps an outcome only once the end was seen).
 * Never a not-scored end, or an end whose outcome Dota hasn't named yet,
 * which a not-scored one can still replace: the site ends the game on it, so
 * it must never be wrong. Never a failed launch either: that never reads
 * started (failLaunch), and a winner undoes the failure (showsGame). */
function gameOver(job) {
  return job.state === "started" && won(job.postgameOutcome);
}

/** The launch is over without a game: back on the lobby screen, stuck before
 * the game runs, or ended by Dota as not scored. */
function launchFailedNow(lobby, job, now) {
  return (
    !played(lobby, job) &&
    (launchOver(lobby, job, now) ||
      launchStalled(lobby, job, now) ||
      (atPostgame(lobby) && notScored(lobby.matchOutcome)))
  );
}

/** The job the bot is done with (launched, or released) that this lobby is. */
function finishedJob(jobs, lobby) {
  return Object.values(jobs).find(
    (job) =>
      ["started", "released"].includes(job.state) &&
      lobby.gameName === job.spec.name &&
      lobby.passKey === job.spec.password,
  );
}

/** Dota shows a game: running, at a postgame it didn't call not scored, or
 * with a winner. */
const showsGame = (lobby) =>
  won(lobby.matchOutcome) ||
  ([2, 3].includes(lobby.state) &&
    !(atPostgame(lobby) && notScored(lobby.matchOutcome)));

/** The players' display names serve only the seat help's lobby chat: a job
 * whose claim is freed keeps none in lobbies.json, which keeps every job. */
function forgetNames(job) {
  for (const field of ["names", "radiantNames", "direNames"]) delete job.spec[field];
}

/** No Leave is waiting on Dota's confirmation. */
function clearLeaveClock(job) {
  delete job.leavePendingAt;
  delete job.leavePendingState;
}

const sameLobby = (lobby, job) =>
  lobby.gameName === job.spec.name && lobby.passKey === job.spec.password;

/** Single account, single active lobby. Persist intent BEFORE any GC command.
 * No replay of ambiguous create/start after timeouts or process restarts.
 * Reconcile only the unique name/password on the account's actual GC snapshot.
 * A Leave Dota doesn't confirm ends in a resync, whose complete welcome is the
 * truth; nothing else ever frees a claim on a guess.
 */
export class LobbyController {
  constructor({
    file,
    transport,
    now = Date.now,
    serverRegion = 2,
    serverRegions = [serverRegion],
    log = eventLog(),
    // The kinds early leave is on for (lobby-kind.mjs earlyLeaveKinds):
    // none unless DOTA_BOT_EARLY_LEAVE lists them.
    earlyLeaveKinds = [],
  }) {
    if (!validRegions(serverRegions)) throw new Error("Unsupported bot server regions");
    if (!Array.isArray(earlyLeaveKinds) || earlyLeaveKinds.some((kind) => !["season", "inhouse", "duel"].includes(kind)))
      throw new Error("Unsupported early leave kinds");
    this.earlyLeaveKinds = Object.freeze([...earlyLeaveKinds]);
    // The one match-details request out for a game the bot left early.
    this.detailsInFlight = null;
    this.file = file;
    this.transport = transport;
    this.now = now;
    this.log = log;
    this.serverRegions = Object.freeze([...serverRegions]);
    this.lobby = null;
    this.online = false;
    this.absenceConfirmed = false;
    // An in-flight resync ({key, reason, at}); its welcome ends it.
    this.resyncing = null;
    this.welcomeLeave = null;
    this.lastLobbyLog = null;
    this.lastAnswers = new Map();
    // The lobby chat of the job being set up: its channel once Dota answered
    // the join, and the lines waiting their turn. In memory only: a GC
    // session that restarts has left the channel.
    this.chat = null;
    this.seatUnknown = new Map();
    this.data = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { active: null, jobs: {} };
    if (!this.data.jobs || !Object.hasOwn(this.data, "active"))
      throw new Error("Invalid bot state file");
  }
  save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), {
      mode: 0o600,
    });
    renameSync(`${this.file}.tmp`, this.file);
  }
  /**
   * Who of the request's roster is where, for the site's lobby list: their
   * seat now (GC team 0 Radiant, 1 Dire, anything else in the lobby but on no
   * side) and what became of their invite. Only while this job's own lobby is
   * set up; the caller leaves it out otherwise.
   */
  players(job, spec) {
    const seats = new Map(
      currentMembers(this.lobby).map((m) => [
        m.id,
        m.team === 0 ? "radiant" : m.team === 1 ? "dire" : "unassigned",
      ]),
    );
    return roster(spec).map((id) => ({
      id,
      seat: seats.get(id) ?? "absent",
      invite: job.invites?.[id]?.result ?? "none",
    }));
  }
  /** A read: it never writes. A create or launch unconfirmed past 30 s reads
   * blocked here at once; tick() saves that. */
  status(key, spec) {
    const job = this.data.jobs[key];
    if (!job) return { state: "idle" };
    const saved =
      ["creating", "starting"].includes(job.state) &&
      this.now() - job.changedAt > UNCONFIRMED_MS
        ? "blocked"
        : job.state;
    const state =
      ((!this.online || !this.lobby) && saved === "ready") ||
      (!this.online && ["creating", "starting"].includes(saved))
        ? "blocked"
        : saved;
    const body = { state, lobbyId: job.lobbyId, matchId: job.matchId };
    // Only a request that asks for it gets the list: older relays refuse any
    // reply field they don't know.
    // A foreign lobby has already marked the job blocked (snapshot).
    if (
      spec?.withPlayers === true &&
      ["ready", "starting"].includes(state) &&
      this.lobby?.state === 0
    )
      body.players = this.players(job, spec);
    // The same for the lifecycle flags: a release still under way on the
    // bot's active claim, and a played game whose end Dota showed.
    if (spec?.withLifecycle === true) {
      if (this.data.active === key && job.releasing) body.releasing = true;
      if (gameOver(job)) body.over = true;
      // The bot left this running game early: it is free, the game goes on.
      if (job.left === true && job.state === "started") body.left = true;
    }
    return body;
  }
  /**
   * Record an invite for each target not already in the lobby, unless one went
   * out in the last 30 s or they've had five. The caller saves, then sends:
   * the record comes first, so a reconnect or restart never repeats a round.
   */
  dueInvites(job, targets) {
    const present = new Set(currentMembers(this.lobby).map((m) => m.id));
    const bot = this.transport.steamId();
    const now = this.now();
    job.invites ??= {};
    const due = targets.filter((id) => {
      const last = job.invites[id];
      return (
        id !== bot &&
        !present.has(id) &&
        !(last && (now - last.at < INVITE_RESEND_MS || last.count >= INVITE_MAX_PER_PLAYER))
      );
    });
    for (const id of due)
      job.invites[id] = {
        at: now,
        count: (job.invites[id]?.count ?? 0) + 1,
        result: "sent",
      };
    return due;
  }
  sendInvites(job, due) {
    let failed = 0;
    for (const id of due) {
      try {
        this.transport.invite(id);
      } catch {
        // Steam dropped between the record and the send. Never retried on its
        // own: the site's re-invite sends it again.
        job.invites[id].result = "failed";
        failed += 1;
      }
    }
    if (failed) this.save();
    // Counts only: never who was invited.
    if (due.length)
      this.log("invites-sent", { key: job.spec.key, count: due.length - failed, n: failed });
  }
  /** The GC's answer to an invite: it reached Dota, or the player is offline. */
  inviteCreated(steamId, userOffline) {
    const entry = this.data.jobs[this.data.active]?.invites?.[steamId];
    if (!entry) return;
    const result = userOffline ? "offline" : "sent";
    if (entry.result === result) return;
    entry.result = result;
    this.save();
  }
  /** Seat help runs only for an inhouse job while its lobby is set up:
   * online, on Dota's lobby screen, `ready` (which every lobby-screen
   * snapshot decides: this job's own lobby, led by the bot with the job's
   * settings, no launch asked for) and not being released. */
  seatHelpOpen(job, lobby) {
    return (
      this.online &&
      !!job &&
      !!lobby &&
      seatHelpKey(job.spec.key) &&
      lobby.state === 0 &&
      job.state === "ready" &&
      !job.releasing
    );
  }
  /**
   * Help the ten onto their sides (Tim's call, 2026-10-18; seat-help.mjs):
   * swap the sides when the whole roster sits mirrored, otherwise send each
   * roster player on the wrong side, and any stranger on a side, back to the
   * unassigned pool, and say so in the lobby's chat, where each drafted
   * player is also greeted with their side once they arrive. Each move and
   * swap is recorded and saved before it goes out, like an invite, so a
   * reconnect or restart never repeats one inside its limits. Runs on every
   * lobby snapshot and on the 30 s clock.
   */
  seatHelp(job, lobby) {
    if (!this.seatHelpOpen(job, lobby)) return;
    const now = this.now();
    this.chatJoin(job, lobby, now);
    this.noteArrivals(job, lobby, now);
    this.fixSeats(job, lobby, now);
    // Greetings are worked out when a line can go: this may be one's turn.
    this.pumpChat();
  }
  /** When each member now in the lobby was first seen there, for greeting()
   * (in memory: a new GC session, or a player who left and came back,
   * starts again). */
  noteArrivals(job, lobby, now) {
    const chat = this.chat;
    if (!chat || chat.key !== job.spec.key) return;
    chat.seen = new Map(currentMembers(lobby).map((m) => [m.id, chat.seen.get(m.id) ?? now]));
  }
  fixSeats(job, lobby, now) {
    const key = job.spec.key;
    const flips = job.seatFlips ?? {};
    // The swap shows in the lobby: everyone where they belong.
    if (flips.at !== undefined && flips.confirmedAt === undefined && rosterMatches(lobby, job.spec)) {
      flips.confirmedAt = now;
      this.save();
      this.log("seat-flip", { key, result: "confirmed", n: flips.count });
    }
    const plan = seatPlan({
      members: currentMembers(lobby),
      spec: job.spec,
      bot: this.transport.steamId(),
      now,
      flips,
      kicks: job.seatKicks ?? {},
    });
    this.logSeatUnknown(key, plan.unknown);
    if (plan.flip) {
      job.seatFlips = { count: (flips.count ?? 0) + 1, at: now };
      this.save();
      let result = "sent";
      try {
        this.transport.flipTeams();
      } catch {
        // Steam dropped: the 30 s clock may try the one swap left.
        result = "failed";
      }
      this.log("seat-flip", { key, result, n: job.seatFlips.count });
      if (result === "sent") this.say(job, moveLine("flip", undefined, undefined, job.spec), "flip");
      return;
    }
    if (!plan.kicks.length) return;
    job.seatKicks ??= {};
    for (const { id } of plan.kicks)
      job.seatKicks[id] = { at: now, count: (job.seatKicks[id]?.count ?? 0) + 1 };
    this.save();
    const names = rosterNames(job.spec);
    const sent = { side: 0, stranger: 0 };
    const failed = { side: 0, stranger: 0 };
    for (const { id, why, side } of plan.kicks) {
      try {
        this.transport.kickFromTeam(id);
      } catch {
        // Counted against the player's limits all the same: never retried
        // inside 30 s.
        failed[why] += 1;
        continue;
      }
      sent[why] += 1;
      // One line a move: so at most one about a player every 30 s. It tells
      // a drafted player their side, so it is their greeting too.
      this.say(job, moveLine(why, side, names.get(id), job.spec), why, why === "side" ? [id] : []);
    }
    // Counts only: never who was moved.
    for (const why of ["side", "stranger"])
      if (sent[why] || failed[why])
        this.log("seat-kick", { key, reason: why, count: sent[why], n: failed[why] });
  }
  /** Members whose team the decoder filled in are never moved; the count is
   * logged when it changes (a live check that Dota sends every team). */
  logSeatUnknown(key, count) {
    if ((this.seatUnknown.get(key) ?? 0) === count) return;
    if (this.seatUnknown.size >= 500) this.seatUnknown.clear();
    this.seatUnknown.set(key, count);
    this.log("seat-unknown", { key, count });
  }
  /** Join the lobby's chat channel, at most CHAT_MAX_JOINS times a job and
   * 30 s apart, recorded and saved before the join goes out. One Dota
   * refuses, or never answers twice, leaves the job's chat unavailable: the
   * seat help goes on without it. */
  chatJoin(job, lobby, now) {
    if (job.chat?.unavailable) return;
    let chat = this.chat;
    if (!chat || chat.key !== job.spec.key || chat.lobbyId !== lobby.lobbyId) {
      chat = this.chat = {
        key: job.spec.key,
        lobbyId: lobby.lobbyId,
        channelId: null,
        pendingAt: undefined,
        lastLineAt: undefined,
        queue: [],
        timer: false,
        echoed: false,
        seen: new Map(),
      };
    }
    if (chat.channelId) return;
    const record = job.chat ?? { joins: 0 };
    if (chat.pendingAt !== undefined) {
      if (now - chat.pendingAt < CHAT_JOIN_TIMEOUT_MS) return;
      chat.pendingAt = undefined;
      if ((record.joins ?? 0) >= CHAT_MAX_JOINS) return this.chatUnavailable(job, "no-answer");
    }
    if ((record.joins ?? 0) >= CHAT_MAX_JOINS || now - (record.at ?? -Infinity) < CHAT_JOIN_TIMEOUT_MS)
      return;
    record.joins = (record.joins ?? 0) + 1;
    record.at = now;
    job.chat = record;
    chat.pendingAt = now;
    this.save();
    try {
      this.transport.joinChat(lobby.lobbyId);
    } catch {
      return this.chatUnavailable(job, "send-failed");
    }
    this.log("chat", { key: job.spec.key, result: "joining", n: record.joins });
  }
  /** Dota's answer to a chat join (server.mjs decodes 7010). Only the active
   * job's own lobby channel counts: "Lobby_<lobby id>", or, with a join of
   * ours waiting, a lobby channel Dota names some other way. Once joined,
   * the bot greets the drafted players already in the lobby (pumpChat).
   * True when it joined. */
  chatJoined({ channelName, channelType, channelId, result } = {}) {
    const chat = this.chat;
    const job = this.data.jobs[this.data.active];
    if (!chat || !job || chat.key !== job.spec.key || job.chat?.unavailable) return false;
    if (channelType !== undefined && channelType !== LOBBY_CHANNEL_TYPE) return false;
    const name = typeof channelName === "string" ? channelName : "";
    const ours =
      name === lobbyChannelName(chat.lobbyId) ||
      (chat.pendingAt !== undefined && channelType === LOBBY_CHANNEL_TYPE && !/^Lobby_\d+$/.test(name));
    if (!ours) return false;
    chat.pendingAt = undefined;
    if ((result ?? 0) !== 0 || typeof channelId !== "string" || !/^[1-9]\d{0,19}$/.test(channelId)) {
      this.chatUnavailable(job, "refused", result);
      return false;
    }
    if (chat.channelId === channelId) return true;
    chat.channelId = channelId;
    job.chat ??= { joins: 0 };
    this.log("chat", { key: job.spec.key, result: "joined", n: job.chat.joins });
    this.pumpChat();
    return true;
  }
  /** The bot's own line came back on its channel: chat works for this
   * account (logged once a job, for the live check). */
  chatSeen(channelId) {
    const chat = this.chat;
    if (!chat?.channelId || chat.channelId !== channelId || chat.echoed) return false;
    chat.echoed = true;
    this.log("chat", { key: chat.key, result: "echoed" });
    return true;
  }
  /** No more chat for this job: saved, so a restart doesn't try again. */
  chatUnavailable(job, reason, code) {
    job.chat = { ...(job.chat ?? { joins: 0 }), unavailable: reason };
    if (Number.isInteger(code)) job.chat.code = code;
    if (this.chat?.key === job.spec.key) {
      this.chat.queue = [];
      this.chat.channelId = null;
      this.chat.pendingAt = undefined;
    }
    this.save();
    this.log("chat", {
      key: job.spec.key,
      result: "unavailable",
      reason,
      n: Number.isInteger(code) ? code : undefined,
    });
  }
  /** Queue a chat line, never more than CHAT_QUEUE_MAX waiting. `about`:
   * the drafted players it tells their side, who count as greeted once it
   * goes. A no-op once the job's chat is unavailable. */
  say(job, text, reason, about = []) {
    const chat = this.chat;
    if (!chat || chat.key !== job.spec.key || job.chat?.unavailable) return false;
    if (chat.queue.length >= CHAT_QUEUE_MAX) return false;
    chat.queue.push({ text, reason, about, at: this.now() });
    this.pumpChat();
    return true;
  }
  /** Who to greet now (seat-help.mjs greeting): due, or settling for `wait`
   * more ms. */
  greetingNow(job, now) {
    return greeting({
      members: currentMembers(this.lobby),
      spec: job.spec,
      now,
      seen: this.chat.seen,
      greeted: job.chat?.greeted,
    });
  }
  /**
   * Send the next chat line once the channel is joined, at most one every
   * 5 s (transport.later wakes it for the next): a move's or swap's line
   * first, then a greeting, worked out now so players who arrived together
   * share it. A move's line older than 30 s is dropped, and so is the whole
   * queue once the lobby is no longer being set up. Whoever a line tells
   * their side is recorded as greeted and saved before it goes out, so a
   * reconnect or restart never greets them again. A send that throws makes
   * the job's chat unavailable.
   */
  pumpChat(fromTimer = false) {
    const chat = this.chat;
    if (!chat) return false;
    if (fromTimer) chat.timer = false;
    const job = this.data.jobs[this.data.active];
    if (!job || job.spec.key !== chat.key || job.chat?.unavailable || !this.seatHelpOpen(job, this.lobby)) {
      chat.queue = [];
      return false;
    }
    if (!chat.channelId) return false;
    const now = this.now();
    chat.queue = chat.queue.filter((line) => now - line.at < CHAT_STALE_MS);
    const greet = chat.queue.length ? null : this.greetingNow(job, now);
    if (!chat.queue.length && !greet.due) {
      if (greet.wait !== undefined) this.scheduleChat(greet.wait);
      return false;
    }
    const wait = CHAT_LINE_GAP_MS - (now - (chat.lastLineAt ?? -Infinity));
    if (wait > 0) {
      this.scheduleChat(wait);
      return false;
    }
    const line =
      chat.queue.shift() ??
      {
        text: greetLine(greet.due.side, greet.due.ids, rosterNames(job.spec), job.spec),
        reason: "greet",
        about: greet.due.ids,
      };
    chat.lastLineAt = now;
    if (line.about.length) {
      job.chat = { ...(job.chat ?? { joins: 0 }) };
      job.chat.greeted = { ...job.chat.greeted };
      for (const id of line.about) job.chat.greeted[id] ??= now;
      this.save();
    }
    try {
      this.transport.chat(chat.channelId, line.text);
    } catch {
      this.chatUnavailable(job, "send-failed");
      return false;
    }
    this.log("chat-line", { key: job.spec.key, reason: line.reason });
    const next = chat.queue.length ? CHAT_LINE_GAP_MS : this.greetingNow(job, now);
    if (typeof next === "number") this.scheduleChat(next);
    else if (next.due) this.scheduleChat(CHAT_LINE_GAP_MS);
    else if (next.wait !== undefined) this.scheduleChat(Math.max(next.wait, CHAT_LINE_GAP_MS));
    return true;
  }
  scheduleChat(ms) {
    const chat = this.chat;
    if (!chat || chat.timer) return;
    chat.timer = true;
    try {
      this.transport.later(ms);
    } catch {
      chat.timer = false;
    }
  }
  /** request() with one log line per answer: every write, and a read only
   * when its answer changed. A BUSY names the claim that holds the bot. */
  handle(action, spec) {
    const at = this.now();
    const key = typeof spec?.key === "string" && KEY_PATTERN.test(spec.key) ? spec.key : null;
    try {
      const body = this.request(action, spec);
      this.logAnswer(action, key, {
        result: body.state,
        releasing: body.releasing,
        over: body.over,
        players: body.players?.length,
        invited: body.invited,
      }, at);
      return body;
    } catch (error) {
      const code = error instanceof BotError ? error.code : "INVALID";
      const active = this.data.jobs[this.data.active];
      this.logAnswer(action, key, code === "BUSY" ? {
        code,
        activeKey: this.data.active ?? null,
        activeState: active?.state ?? null,
        releasing: active?.releasing === true,
        lobbyState: this.lobby?.state ?? null,
      } : { code }, at);
      throw error;
    }
  }
  logAnswer(action, key, fields, at) {
    const answer = JSON.stringify(fields);
    const seen = `${action}|${key}`;
    if (["status", "health", "active"].includes(action)) {
      if (this.lastAnswers.get(seen) === answer) return;
      if (this.lastAnswers.size >= 500) this.lastAnswers.clear();
      this.lastAnswers.set(seen, answer);
    }
    this.log("request", { action, key, ...fields, ms: this.now() - at });
  }
  request(action, spec) {
    if (!validSpec(spec, this.serverRegions)) throw new BotError("INVALID");
    if (action === "status") return this.status(spec.key, spec);
    if (!this.online) throw new BotError("OFFLINE");
    let job = this.data.jobs[spec.key];
    if (action === "create") {
      if (job && job.state !== "released") return this.status(spec.key, spec);
      if (this.data.active || this.lobby) {
        if (!this.data.active) this.checkLeftover();
        throw new BotError("BUSY");
      }
      // A GC welcome can omit an up-to-date cache. Online alone does not
      // establish that the account has no existing lobby.
      if (!this.absenceConfirmed) throw new BotError("STATE");
      job = { spec, state: "creating", changedAt: this.now() };
      this.data.jobs[spec.key] = job;
      this.data.active = spec.key;
      this.absenceConfirmed = false;
      this.save();
      this.log("create-sent", { key: spec.key });
      this.transport.create(spec);
    } else {
      if (!job || this.data.active !== spec.key) throw new BotError("STATE");
      // The payload's fresh roster may include an approved stand-in, but the
      // ticket and other creation settings cannot drift during the game.
      if (action === "start") {
        if (job.releasing) throw new BotError("STATE");
        if (job.state === "started" || job.state === "starting")
          return this.status(spec.key, spec);
        if (job.launchRequested) throw new BotError("STATE");
        if (job.state !== "ready" || this.lobby?.state !== 0)
          throw new BotError("STATE");
        if (
          !settingsMatch(this.lobby, spec) ||
          !settingsMatch(this.lobby, job.spec) ||
          this.lobby.leaderId !== this.transport.steamId()
        )
          throw new BotError("SETTINGS");
        if (!rosterMatches(this.lobby, spec)) throw new BotError("ROSTER");
        const was = job.state;
        job.state = "starting";
        job.launchRequested = true;
        job.changedAt = this.now();
        this.save();
        this.logJob(job, was, "start");
        this.log("start-sent", { key: spec.key });
        this.transport.start();
      } else if (action === "release") {
        // Never touch an unrelated lobby, nor interrupt server allocation.
        if (this.lobby && !sameLobby(this.lobby, job)) throw new BotError("STATE");
        // A running game ignores Leave, and the bot's picture of it may be
        // stale (2026-10-18: a game long over that the bot still saw
        // running). Release it the moment Dota shows the end, and ask the
        // Game Coordinator now whether the lobby still exists at all: a
        // complete welcome with no lobby frees the bot at once.
        if (
          job.state === "started" &&
          (this.lobby ? stillRunning(this.lobby) : !this.absenceConfirmed)
        ) {
          job.releasing = true;
          // One check per RECHECK_AFTER_MS: once a resync's welcome has shown
          // this lobby still there, a later Release (the site sends one on
          // every close, and on a BUSY) only waits for the game's end, the
          // next check or the backstop, never cycling a live game's session
          // more often. A lobby the bot can't see is always checked.
          const check = !this.lobby || checkDue(job, this.now());
          if (check) job.resyncWanted = "release";
          this.save();
          this.log("release-pending", { key: spec.key, lobbyState: this.lobby?.state ?? null });
          if (check) this.resync(job, "release");
          return this.status(spec.key, spec);
        }
        // Immediately after Launch, the last snapshot can still say UI.
        // Its stale state cannot authorize Leave during server allocation.
        if (this.lobby && !safeToLeave(this.lobby, job, this.now()))
          throw new BotError("STATE");
        if (!this.lobby && !this.absenceConfirmed) throw new BotError("STATE");
        // Retain the active claim until the GC confirms departure. A second
        // click cannot allocate another lobby while Leave is still in flight.
        job.releasing = true;
        this.save();
        if (this.lobby) this.leave(job, "release");
        else this.departed("release-no-lobby");
      } else if (action === "invite") {
        // Inviting while the account has no lobby makes Dota create a default
        // one, so only this job's own set-up lobby, led by the bot, qualifies
        // ("ready": snapshot marks a foreign lobby blocked).
        if (!validInviteTargets(spec)) throw new BotError("INVALID");
        if (
          job.releasing ||
          job.launchRequested ||
          job.state !== "ready" ||
          this.lobby?.state !== 0
        )
          throw new BotError("STATE");
        if (
          !settingsMatch(this.lobby, spec) ||
          !settingsMatch(this.lobby, job.spec) ||
          this.lobby.leaderId !== this.transport.steamId()
        )
          throw new BotError("SETTINGS");
        // The fresh roster, so a stand-in booked after create can be invited.
        const due = this.dueInvites(job, spec.invite ?? roster(spec));
        this.save();
        this.sendInvites(job, due);
        return { ...this.status(spec.key, spec), invited: due.length };
      } else throw new BotError("INVALID");
    }
    return this.status(spec.key, spec);
  }
  /** A Create found the bot with no claim but still in a finished job's
   * lobby that reads running. Dota ignores a Leave there and only the game's
   * postgame brings one, so a lobby whose end never reached the bot would
   * answer BUSY to every Create until a restart (2026-10-18, claimless). Ask
   * the Game Coordinator once whether it still exists; resync() keeps its
   * limits. */
  checkLeftover() {
    const done = finishedJob(this.data.jobs, this.lobby);
    if (done && stillRunning(this.lobby) && checkDue(done, this.now()))
      this.resync(done, "busy");
  }
  /** Send a Leave, saved first with its reason. The first unconfirmed one
   * starts the confirmation clock (LEAVE_CONFIRM_MS), and so does one sent in
   * another lobby state than the Leave that started it: Dota ignores a Leave
   * at RUN, so the postgame's Leave after a RUN one gets its own 20 s. A
   * repeat in the same state doesn't push the clock back. */
  leave(job, reason) {
    const now = this.now();
    const lobbyState = this.lobby?.state ?? null;
    job.leaveSentAt = now;
    job.leaveReason = reason;
    if (job.leavePendingAt === undefined || job.leavePendingState !== lobbyState) {
      job.leavePendingAt = now;
      job.leavePendingState = lobbyState;
    }
    this.save();
    this.log("leave-sent", { key: job.spec.key, reason, lobbyState: this.lobby?.state ?? null });
    this.transport.leave();
  }
  logJob(job, was, reason) {
    if (job.state !== was)
      this.log("job", { key: job.spec.key, from: was, to: job.state, reason });
  }
  logLobby(lobby, job) {
    const view = {
      lobbyId: lobby.lobbyId,
      lobbyState: lobby.state,
      gameState: lobby.gameState,
      outcome: lobby.matchOutcome,
      matchId: hasMatchId(lobby) ? lobby.matchId : null,
      members: currentMembers(lobby).length,
    };
    const mine = !!job && sameLobby(lobby, job);
    const seen = JSON.stringify({ ...view, mine, key: job?.spec.key });
    if (seen === this.lastLobbyLog) return;
    this.lastLobbyLog = seen;
    this.log("lobby", { key: job?.spec.key ?? null, mine, ...view });
  }
  snapshot(lobby) {
    const now = this.now();
    let job = this.data.jobs[this.data.active];
    this.logLobby(lobby, job ?? finishedJob(this.data.jobs, lobby));
    this.lobby = lobby;
    this.absenceConfirmed = false;
    if (!job) {
      // No claim, yet the bot is in a lobby: a finished job's, whose cache
      // turned up after a reconnect had already settled its departure. Leave
      // it, or it answers BUSY to every Create with nothing left to release.
      // Any other lobby stays untouched.
      const done = finishedJob(this.data.jobs, lobby);
      if (!done) return;
      // A game the bot left early is never claimed back, even one Dota later
      // called not scored (launchFailed): the bot already went, so its old
      // lobby is a leftover like any finished game's.
      if (done.left === true || !(done.launchFailed && showsGame(lobby))) {
        // A played game's end, seen after its claim was freed, still reaches
        // the site as `over`.
        const recorded = done.state === "started" && recordEnd(done, lobby, now);
        // Never during RUN, when Dota ignores it (the postgame brings it),
        // nor during server allocation: only on the lobby screen or at the
        // game's end.
        if (lobby.state === 0 || atPostgame(lobby)) this.leave(done, "orphan");
        else if (recorded) this.save();
        return;
      }
      // That reconnect gave up on a launch Dota now shows as a game: claim it
      // back and follow it as usual, so its match id reaches the site.
      this.data.active = done.spec.key;
      this.log("claim-back", { key: done.spec.key });
      job = done;
    }
    const was = job.state;
    if (!sameLobby(lobby, job)) {
      // The old lobby of a game the bot left early, replayed while a new
      // claim holds the bot: its end still counts (`over`), but the bot never
      // leaves it from here, since a Leave would leave whatever lobby the bot
      // is really in. The new job reads blocked, as with any foreign lobby.
      const left = finishedJob(this.data.jobs, lobby);
      if (left?.left === true && left.state === "started") recordEnd(left, lobby, now);
      job.state = "blocked";
      this.save();
      this.logJob(job, was, "foreign-lobby");
      return;
    }
    job.lobbyId = lobby.lobbyId;
    // What Dota has shown of the launch, so a later lobby-screen snapshot can
    // be told from the stale one right after Start (launchOver, played).
    if (job.launchRequested && lobby.state !== 0) job.launchSeen = true;
    // When this time off the lobby screen began, for a launch the bot didn't
    // start (launchStalled).
    if (lobby.state === 0) delete job.leftLobbyAt;
    else job.leftLobbyAt ??= now;
    recordEnd(job, lobby, now);
    // Given up too soon (a Dota update late past the settle clock): a game
    // Dota now shows running, or played, is a game after all, back on the
    // normal path (the bot stays with a running game until it ends).
    if (job.launchFailed && showsGame(lobby)) {
      delete job.launchFailed;
      delete job.releasing;
      clearLeaveClock(job);
      if (job.failedMatchId) job.matchId = job.failedMatchId;
      this.log("launch-undone", { key: job.spec.key, lobbyState: lobby.state });
    }
    // Anyone joining, leaving or changing sides restarts the idle clock.
    const members = currentMembers(lobby)
      .map((m) => `${m.id}:${m.team}`)
      .sort()
      .join(",");
    if (members !== job.members) {
      job.members = members;
      job.activeAt = now;
    }
    // A failed launch's match id never becomes a game: the site must not
    // wait on it, and a retry brings its own.
    if (hasMatchId(lobby) && !job.launchFailed) job.matchId = lobby.matchId;
    let due = [];
    if ((lobby.state === 2 || lobby.state === 3) && !job.launchFailed)
      job.state = "started";
    else if (
      lobby.state === 0 &&
      !["starting", "started"].includes(job.state)
    ) {
      job.state =
        !job.launchRequested &&
        settingsMatch(lobby, job.spec) &&
        lobby.leaderId === this.transport.steamId()
          ? "ready"
          : "blocked";
      const bot = lobby.allMembers.find(
        (m) => m.id === this.transport.steamId(),
      );
      if (bot && [0, 1].includes(bot.team)) this.transport.removeBotFromTeam();
      // The lobby's first ready moment: invite the ten, once per job, so they
      // needn't search for it. The name and password still work for anyone
      // whose Dota hides invites from non-friends.
      if (job.state === "ready" && !job.releasing && !job.autoInvitedAt) {
        job.autoInvitedAt = now;
        due = this.dueInvites(job, roster(job.spec));
      }
    }
    // A launch that is over without a game (someone failed to load, the
    // server never started): release the bot so captains can create the
    // lobby again, and nothing holds Game over back. One that was played is
    // started even if a drop hid its running and postgame snapshots, so its
    // departure frees the claim and the site reads its match id.
    const failed = !job.releasing && launchFailedNow(lobby, job, now);
    if (failed) this.failLaunch(job);
    else if (launchOver(lobby, job, now) && played(lobby, job))
      job.state = "started";
    if (job.state === "started") job.startedAt ??= now;
    this.save();
    this.logJob(job, was, failed ? "launch-failed" : undefined);
    if (due.length) this.sendInvites(job, due);
    // Inhouse only, and only while the lobby is set up (seatHelpOpen).
    if (!failed) this.seatHelp(job, lobby);
    // The bot leaves at the game's end (its postgame), once a launch is back
    // on the lobby screen, and for a release once leaving is safe. Never
    // while the game runs: Dota ignores that Leave, so a release pending on a
    // running game waits for its postgame.
    const reason = failed
      ? "failed-launch"
      : atPostgame(lobby)
        ? "postgame"
        : launchOver(lobby, job, now)
          ? "back-on-lobby-screen"
          : job.releasing && safeToLeave(lobby, job, now)
            ? "release"
            : null;
    if (reason) this.leave(job, reason);
    else if (this.earlyLeaveDue(job, lobby, now)) this.leaveEarly(job);
    return failed;
  }
  /** Leave this launched game now, while it runs? Only for a kind listed in
   * DOTA_BOT_EARLY_LEAVE, only the active claim's own lobby, only once the
   * game is under way (RUN at a game state in EARLY_LEAVE_GAME_STATES, from
   * the hero draft on, so a failed load or a server that never started is
   * past; a snapshot without a game state never qualifies) with its match id
   * known, only while the bot sits on neither side, never at the game's
   * end, and within the tries. */
  earlyLeaveDue(job, lobby, now) {
    const bot = this.transport.steamId();
    return (
      this.earlyLeaveKinds.includes(keyKind(job?.spec?.key)) &&
      this.online &&
      !!lobby &&
      this.data.active === job.spec.key &&
      job.state === "started" &&
      !job.launchFailed &&
      sameLobby(lobby, job) &&
      lobby.state === 2 &&
      EARLY_LEAVE_GAME_STATES.includes(lobby.gameState) &&
      !atPostgame(lobby) &&
      hasMatchId(lobby) &&
      job.matchId === lobby.matchId &&
      !currentMembers(lobby).some((m) => m.id === bot && (m.team === 0 || m.team === 1)) &&
      job.earlyLeavePendingAt === undefined &&
      job.leavePendingAt === undefined &&
      (job.earlyLeaves ?? 0) < EARLY_LEAVE_MAX_TRIES &&
      now - (job.earlyLeaveSentAt ?? -Infinity) >= EARLY_LEAVE_GAP_MS
    );
  }
  /** AbandonCurrentGame, then a Leave, recorded and saved first. Dota's
   * departure (Destroy, a removal, an unsubscribe, a welcome with no lobby)
   * confirms it and frees the claim (departed); none within LEAVE_CONFIRM_MS
   * just ends the try (tick): no resync, the bot stays to the postgame. */
  leaveEarly(job) {
    const now = this.now();
    job.earlyLeaves = (job.earlyLeaves ?? 0) + 1;
    job.earlyLeaveSentAt = now;
    job.earlyLeavePendingAt = now;
    this.save();
    this.log("leave-sent", { key: job.spec.key, reason: "early", lobbyState: this.lobby?.state ?? null, n: job.earlyLeaves });
    try {
      this.transport.abandon();
      this.transport.leave();
    } catch {
      // Steam dropped: the try counts, and the next one waits its minute.
      delete job.earlyLeavePendingAt;
      this.save();
      this.log("early-leave", { key: job.spec.key, result: "send-failed", n: job.earlyLeaves });
    }
  }
  /** An early leave Dota hasn't confirmed in LEAVE_CONFIRM_MS ends its try,
   * and a try still due (the second, a minute after the first) goes out from
   * the clock when no lobby update brings it. */
  earlyLeaveClock(job, now) {
    if (!job) return;
    if (job.earlyLeavePendingAt !== undefined && now - job.earlyLeavePendingAt >= LEAVE_CONFIRM_MS) {
      delete job.earlyLeavePendingAt;
      job.earlyLeaveUnconfirmedAt = now;
      this.save();
      this.log("early-leave", { key: job.spec.key, result: "unconfirmed", n: job.earlyLeaves });
    }
    if (this.lobby && this.earlyLeaveDue(job, this.lobby, now)) this.leaveEarly(job);
  }
  /** Ask the Game Coordinator for the details of one game the bot left early,
   * whose end it can no longer see: DETAILS_AFTER_MS after the leave, then at
   * most once a DETAILS_EVERY_MS per game, the longest-unasked first, one
   * request in flight, only online, until an outcome or DETAILS_FOR_MS. True
   * when it sent one. */
  detailsClock(now) {
    if (this.detailsInFlight && now - this.detailsInFlight.at < DETAILS_TIMEOUT_MS) return false;
    this.detailsInFlight = null;
    if (!this.online) return false;
    let pick;
    for (const job of Object.values(this.data.jobs)) {
      if (job.left !== true || job.state !== "started" || !job.matchId || won(job.postgameOutcome)) continue;
      if (job.detailsGaveUpAt !== undefined) continue;
      const since = job.leftAt ?? job.departedAt ?? now;
      if (now - since >= DETAILS_FOR_MS) {
        job.detailsGaveUpAt = now;
        this.save();
        this.log("match-details", { key: job.spec.key, result: "gave-up", n: job.detailsAsks ?? 0 });
        continue;
      }
      if (now - since < DETAILS_AFTER_MS || now - (job.detailsAskedAt ?? -Infinity) < DETAILS_EVERY_MS) continue;
      if (!pick || (job.detailsAskedAt ?? -Infinity) < (pick.detailsAskedAt ?? -Infinity)) pick = job;
    }
    if (!pick) return false;
    pick.detailsAskedAt = now;
    pick.detailsAsks = (pick.detailsAsks ?? 0) + 1;
    this.save();
    this.detailsInFlight = { key: pick.spec.key, matchId: pick.matchId, at: now };
    try {
      this.transport.matchDetails(pick.matchId);
    } catch {
      this.detailsInFlight = null;
      this.log("match-details", { key: pick.spec.key, result: "send-failed", n: pick.detailsAsks });
      return false;
    }
    this.log("match-details", { key: pick.spec.key, result: "asked", matchId: pick.matchId, n: pick.detailsAsks });
    return true;
  }
  /** The Game Coordinator's match details (server.mjs routes 7096). For a
   * game the bot left early, a winner (2 to 13) is recorded exactly as its
   * postgame would have been, so status() reads `over`; a not-scored outcome
   * (64 to 69) is a failed launch, released as one is today; anything else
   * (the game still running, or not found) waits for the next ask. True when
   * it recorded an end. */
  matchDetails({ result, match } = {}) {
    const matchId = match?.matchId !== undefined && match?.matchId !== null ? String(match.matchId) : null;
    if (this.detailsInFlight && (!matchId || this.detailsInFlight.matchId === matchId)) this.detailsInFlight = null;
    if (!matchId || result !== 1) return false;
    const job = Object.values(this.data.jobs).find(
      (j) => j.left === true && j.state === "started" && j.matchId === matchId,
    );
    if (!job) return false;
    const outcome = match.matchOutcome;
    const now = this.now();
    if (won(outcome) && !won(job.postgameOutcome)) {
      job.postgameSeen = true;
      job.postgameAt ??= now;
      job.postgameOutcome = outcome;
      job.endBy = "match-details";
      this.save();
      this.log("match-details", { key: job.spec.key, result: "over", outcome });
      return true;
    }
    if (notScored(outcome)) {
      const was = job.state;
      job.postgameSeen = true;
      job.postgameAt ??= now;
      job.postgameOutcome = outcome;
      job.endBy = "match-details";
      this.failLaunch(job);
      job.state = "released";
      this.save();
      this.log("match-details", { key: job.spec.key, result: "not-scored", outcome });
      this.logJob(job, was, "not-scored");
      return true;
    }
    return false;
  }
  /** Release a launch that is over without a game. Its claim holds until Dota
   * confirms the departure, which then reads released: Create works again for
   * this game (a retry, with fresh invites) and for every other. */
  failLaunch(job) {
    job.launchFailed = true;
    if (job.matchId) job.failedMatchId = job.matchId;
    delete job.matchId;
    job.state = "blocked";
    job.releasing = true;
  }
  /** The job a Leave is out for: the active claim, or with none, the
   * finished job whose lobby the bot is still in. */
  leavingJob() {
    return (
      this.data.jobs[this.data.active] ??
      (this.lobby ? finishedJob(this.data.jobs, this.lobby) : undefined)
    );
  }
  /** Ask the Game Coordinator again which lobby the bot is in: transport
   * .resync() cycles the GC session and its welcome replays every cache
   * (welcoming/welcomed). It sends no create, start or leave. Never while a
   * lobby is being set up (creating, ready or starting, unless it is being
   * released: then its Leave on the lobby screen should already have worked)
   * or its server allocated, at most one a minute, and at most three per job;
   * then the bot logs that the leave went unconfirmed and waits for the next
   * postgame or welcome. True when it started one. A resync in flight is
   * offline until its welcome, so it never starts a second. */
  resync(job, reason) {
    const now = this.now();
    if (
      !this.online ||
      (["creating", "ready", "starting"].includes(job.state) && !job.releasing) ||
      (this.lobby && [1, 4, 5, 6].includes(this.lobby.state))
    )
      return false;
    if ((job.resyncs ?? 0) >= MAX_RESYNCS_PER_JOB) {
      const first = job.resyncGaveUpAt === undefined;
      if (first || job.resyncWanted !== undefined) {
        job.resyncGaveUpAt ??= now;
        delete job.resyncWanted;
        this.save();
      }
      if (first)
        this.log("leave-not-confirmed", { key: job.spec.key, reason, n: job.resyncs });
      return false;
    }
    if (now - (this.data.lastResyncAt ?? -Infinity) < RESYNC_MIN_INTERVAL_MS)
      return false;
    job.resyncs = (job.resyncs ?? 0) + 1;
    job.lastResyncAt = now;
    this.data.lastResyncAt = now;
    delete job.resyncWanted;
    if (reason === "backstop") job.backstopAt = now;
    this.save();
    this.online = false;
    this.resyncing = { key: job.spec.key, reason, at: now };
    this.log("resync", { key: job.spec.key, reason, n: job.resyncs });
    try {
      this.transport.resync();
    } catch {
      // The transport's own exit timer restarts the worker if no welcome
      // follows; nothing here may throw into a request or the clock.
      this.log("resync-failed", { key: job.spec.key, reason });
    }
    return true;
  }
  /** The resyncs no GC message drives: a Release waiting on one, a Leave
   * unconfirmed past LEAVE_CONFIRM_MS, and a started game with no end seen
   * three hours after Start, whether it still holds the claim or is a
   * finished job's leftover lobby. */
  resyncClock(now) {
    const job = this.leavingJob();
    if (!job) return false;
    const reason =
      job.resyncWanted ??
      (job.leavePendingAt !== undefined && now - job.leavePendingAt >= LEAVE_CONFIRM_MS
        ? "leave-unconfirmed"
        : job.state === "started" &&
            !job.postgameSeen &&
            job.backstopAt === undefined &&
            now - (job.startedAt ?? job.changedAt) >= STARTED_BACKSTOP_MS
          ? "backstop"
          : null);
    return reason ? this.resync(job, reason) : false;
  }
  /** The clocks no GC message drives: a Launch Dota never showed or that
   * stalls, a lobby nobody starts, an unconfirmed create or launch, and the
   * resync clocks. Only ever this job's own lobby; server.mjs calls it every
   * 30 s, and again just after a Leave's confirmation deadline. True when it
   * released a lobby. */
  tick() {
    const now = this.now();
    const job = this.data.jobs[this.data.active];
    if (
      job &&
      ["creating", "starting"].includes(job.state) &&
      now - job.changedAt > UNCONFIRMED_MS
    ) {
      const was = job.state;
      job.state = "blocked";
      this.save();
      this.logJob(job, was, "unconfirmed");
    }
    this.earlyLeaveClock(job, now);
    this.detailsClock(now);
    this.resyncClock(now);
    const lobby = this.lobby;
    if (!this.online || !job || job.releasing) return false;
    if (!lobby) {
      // Nothing to leave. A job whose lobby is gone (a complete welcome or
      // Dota's departure found the bot in none), or never came (Dota never
      // answered the Create), is over once it has settled: free the claim so
      // the next Create works. A started game is never in this state.
      const neverCame = !job.launchRequested && job.lobbyId === undefined;
      if (
        job.state === "started" ||
        now - job.changedAt < LAUNCH_SETTLE_MS ||
        !(this.absenceConfirmed || neverCame)
      )
        return false;
      if (job.launchRequested) this.failLaunch(job);
      else job.releasing = true;
      this.departed(neverCame ? "never-came" : "gone");
      return true;
    }
    if (!sameLobby(lobby, job)) return false;
    let reason;
    if (launchFailedNow(lobby, job, now)) {
      this.failLaunch(job);
      reason = "failed-launch";
    } else if (
      lobby.state === 0 &&
      !job.launchRequested &&
      ["ready", "blocked"].includes(job.state) &&
      now - Math.max(job.changedAt, job.activeAt ?? 0) >= idleReleaseMs(job.spec.key)
    ) {
      job.releasing = true;
      reason = "idle";
    } else {
      // A player moved back to the pool who sat down on the wrong side again
      // inside 30 s, with nothing changing since: the clock catches them.
      this.seatHelp(job, lobby);
      this.pumpChat();
      return false;
    }
    this.leave(job, reason);
    return true;
  }
  /** A GC welcome is starting: forget the lobby. Its replay sends the lobby
   * again if the bot is still in it, and with it any Leave still needed,
   * with a fresh confirmation clock. */
  welcoming() {
    const job = this.leavingJob();
    this.welcomeLeave =
      job?.leavePendingAt !== undefined
        ? { key: job.spec.key, at: job.leavePendingAt, state: job.leavePendingState }
        : null;
    if (job) clearLeaveClock(job);
    this.lobby = null;
    // A new GC session has left the lobby's chat channel.
    this.chat = null;
  }
  /** Settle a GC welcome once its out-of-date caches have replayed as
   * snapshots. Only a welcome that resent every cache (`complete`) and held
   * no lobby proves the account is in none. True when that freed a claim. */
  welcomed(complete) {
    const now = this.now();
    this.absenceConfirmed = complete && !this.lobby;
    const job = this.data.jobs[this.data.active];
    const pending = this.welcomeLeave;
    const resync = this.resyncing;
    this.welcomeLeave = null;
    this.resyncing = null;
    if (pending) {
      const leaving = this.data.jobs[pending.key];
      // Neither proof (an incomplete welcome that replayed no lobby): the
      // Leave is still unconfirmed, on its old clock.
      if (leaving && !this.lobby && !this.absenceConfirmed && leaving.leavePendingAt === undefined) {
        leaving.leavePendingAt = pending.at;
        leaving.leavePendingState = pending.state;
      }
      // The lobby a Leave was out for, with no claim, is provably gone.
      if (leaving && leaving !== job && this.absenceConfirmed) {
        leaving.departedAt = now;
        leaving.departedBy = "welcome";
      }
    }
    // This welcome is the check a Release asked for.
    if (job && (this.lobby || this.absenceConfirmed)) delete job.resyncWanted;
    // A resync's welcome that shows the job's lobby still there: the one
    // check a later Release or BUSY needn't repeat for this game.
    const checked = resync && this.lobby ? this.data.jobs[resync.key] : undefined;
    if (checked && sameLobby(this.lobby, checked)) checked.verifiedAt = now;
    // A drop can swallow the departure from a launched game or a released
    // lobby, and its claim then answers BUSY to every next Create. Neither
    // has anything to replay, so proven absence is that departure: the one a
    // second Release would record. Every other job keeps its claim for a
    // deliberate release.
    const free =
      this.absenceConfirmed &&
      !!job &&
      (job.state === "started" || !!job.releasing || !!job.launchSeen);
    this.log("welcome", { complete, lobby: !!this.lobby, key: this.data.active ?? null });
    if (free) this.departed("welcome");
    else this.save();
    if (resync)
      this.log("resync-done", {
        key: resync.key,
        reason: resync.reason,
        result: free ? "freed" : this.lobby ? "lobby-present" : this.absenceConfirmed ? "no-lobby" : "unproven",
        ms: now - resync.at,
      });
    return free;
  }
  /** The bot is in no lobby: Dota confirmed the departure (`source` says
   * how), or the bot proved it had none. */
  departed(source = "unknown") {
    const now = this.now();
    const job = this.data.jobs[this.data.active];
    if (job) {
      const was = job.state;
      // A game the bot left early (or tried to), gone before its end: the
      // game goes on without the bot, which is free for the next one.
      const left = job.state === "started" && (job.earlyLeaves ?? 0) > 0 && !job.postgameSeen;
      const confirmed = job.earlyLeavePendingAt !== undefined;
      delete job.earlyLeavePendingAt;
      if (left) {
        job.left = true;
        job.leftAt ??= now;
      }
      // A launch Dota showed, whose lobby then went away before it ran, is
      // over: it reads released, like any failed launch.
      if (job.state !== "started" && job.launchSeen && !job.releasing)
        this.failLaunch(job);
      if (job.state !== "started")
        job.state = job.releasing ? "released" : "blocked";
      job.departedAt = now;
      job.departedBy = source;
      clearLeaveClock(job);
      delete job.resyncWanted;
      // An unexplained missing lobby never authorizes a replay. Keep the
      // claim until a captain deliberately releases the ambiguous operation.
      const free = !!job.releasing || job.state === "started";
      if (free) {
        this.data.active = null;
        job.freedAt = now;
        job.freedBy = source;
        forgetNames(job);
      }
      this.save();
      this.log("departed", { key: job.spec.key, source, lobbyId: job.lobbyId ?? null });
      this.logJob(job, was, source);
      if (free) this.log("claim-freed", { key: job.spec.key, reason: source });
      if (left)
        this.log("early-leave", { key: job.spec.key, result: confirmed ? "confirmed" : "left", n: job.earlyLeaves });
    } else {
      const done = this.lobby ? finishedJob(this.data.jobs, this.lobby) : undefined;
      if (done) {
        done.departedAt = now;
        done.departedBy = source;
        clearLeaveClock(done);
        this.save();
      }
      this.log("departed", { key: done?.spec.key ?? null, source });
    }
    this.lobby = null;
    this.chat = null;
    this.absenceConfirmed = true;
  }
}
