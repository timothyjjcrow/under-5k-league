import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { eventLog } from "./event-log.mjs";

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

const KEY_PATTERN = /^(?:eu:)?(season|inhouse):[a-zA-Z0-9_-]{1,128}:[1-9]\d?$/;

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
    s.gameMode === 2 &&
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
  const members = currentMembers(lobby);
  return (
    [spec.radiant, spec.dire].every((expected, side) => {
      const actual = members.filter((m) => m.team === side).map((m) => m.id);
      return (
        expected.length === 5 &&
        actual.length === 5 &&
        new Set(expected).size === 5 &&
        expected.every((id) => actual.includes(id))
      );
    }) && new Set([...spec.radiant, ...spec.dire]).size === 10
  );
}

// EMatchOutcome: 2 to 13 name a winner; 64 to 69 are Dota's "not scored"
// (poor network, a leaver, a server crash, never started, cancelled).
const won = (outcome) => outcome >= 2 && outcome <= 13;
const notScored = (outcome) => outcome >= 64 && outcome <= 69;
// DOTA_GameState's DOTA_GAMERULES_STATE_POST_GAME.
const POST_GAME = 6;

/** Dota shows the game's end: its postgame (lobby state 3), or a lobby still
 * reading RUN whose outcome or game state already says the game ended. */
const atPostgame = (lobby) =>
  lobby.state === 3 ||
  (lobby.state === 2 && (won(lobby.matchOutcome) || lobby.gameState === POST_GAME));

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

/** The site's `over`: this job's game was played and Dota showed its end.
 * Never a failed launch, never a not-scored end. */
function gameOver(job) {
  return (
    job.state === "started" &&
    !job.launchFailed &&
    job.postgameSeen === true &&
    !notScored(job.postgameOutcome)
  );
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

const sameLobby = (lobby, job) =>
  lobby.gameName === job.spec.name && lobby.passKey === job.spec.password;

/** Single account, single active lobby. Persist intent BEFORE any GC command.
 * No replay of ambiguous create/start after timeouts or process restarts.
 * Reconcile only the unique name/password on the account's actual GC snapshot.
 * A Leave Dota doesn't confirm ends in a resync, whose complete welcome is the
 * truth; nothing else ever frees a claim on a guess.
 */
export class LobbyController {
  constructor({ file, transport, now = Date.now, serverRegion = 2, serverRegions = [serverRegion], log = eventLog() }) {
    if (!validRegions(serverRegions)) throw new Error("Unsupported bot server regions");
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
      if (this.data.active || this.lobby) throw new BotError("BUSY");
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
          (this.lobby
            ? this.lobby.state === 2 && !atPostgame(this.lobby)
            : !this.absenceConfirmed)
        ) {
          job.releasing = true;
          job.resyncWanted = "release";
          this.save();
          this.log("release-pending", { key: spec.key, lobbyState: this.lobby?.state ?? null });
          this.resync(job, "release");
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
  /** Send a Leave, saved first with its reason. The first unconfirmed one
   * starts the confirmation clock (LEAVE_CONFIRM_MS); a repeat doesn't push
   * it back. */
  leave(job, reason) {
    const now = this.now();
    job.leaveSentAt = now;
    job.leaveReason = reason;
    job.leavePendingAt ??= now;
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
      if (!(done.launchFailed && showsGame(lobby))) {
        // Never during RUN, when Dota ignores it: the postgame brings it.
        if (!(lobby.state === 2 && !atPostgame(lobby))) this.leave(done, "orphan");
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
    // The game's end as Dota shows it: its postgame, a RUN lobby whose
    // outcome or game state says it ended, or a winner however it arrives.
    if (atPostgame(lobby) || won(lobby.matchOutcome)) {
      job.postgameSeen = true;
      job.postgameOutcome = lobby.matchOutcome;
      job.postgameAt ??= now;
    }
    // Given up too soon (a Dota update late past the settle clock): a game
    // Dota now shows running, or played, is a game after all, back on the
    // normal path (the bot stays with a running game until it ends).
    if (job.launchFailed && showsGame(lobby)) {
      delete job.launchFailed;
      delete job.releasing;
      delete job.leavePendingAt;
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
    return failed;
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
   * lobby is being set up or its server allocated, at most one a minute, and
   * at most three per job; then the bot logs that the leave went unconfirmed
   * and waits for the next postgame or welcome. True when it started one. */
  resync(job, reason) {
    const now = this.now();
    if (
      !this.online ||
      this.resyncing ||
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
   * three hours after Start. */
  resyncClock(now) {
    const job = this.leavingJob();
    if (!job) return false;
    const reason =
      job.resyncWanted ??
      (job.leavePendingAt !== undefined && now - job.leavePendingAt >= LEAVE_CONFIRM_MS
        ? "leave-unconfirmed"
        : job.state === "started" &&
            this.data.active === job.spec.key &&
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
      now - Math.max(job.changedAt, job.activeAt ?? 0) >= IDLE_RELEASE_MS
    ) {
      job.releasing = true;
      reason = "idle";
    } else return false;
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
        ? { key: job.spec.key, at: job.leavePendingAt }
        : null;
    if (job) delete job.leavePendingAt;
    this.lobby = null;
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
      if (leaving && !this.lobby && !this.absenceConfirmed)
        leaving.leavePendingAt ??= pending.at;
      // The lobby a Leave was out for, with no claim, is provably gone.
      if (leaving && leaving !== job && this.absenceConfirmed) {
        leaving.departedAt = now;
        leaving.departedBy = "welcome";
      }
    }
    // This welcome is the check a Release asked for.
    if (job && (this.lobby || this.absenceConfirmed)) delete job.resyncWanted;
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
      // A launch Dota showed, whose lobby then went away before it ran, is
      // over: it reads released, like any failed launch.
      if (job.state !== "started" && job.launchSeen && !job.releasing)
        this.failLaunch(job);
      if (job.state !== "started")
        job.state = job.releasing ? "released" : "blocked";
      job.departedAt = now;
      job.departedBy = source;
      delete job.leavePendingAt;
      delete job.resyncWanted;
      // An unexplained missing lobby never authorizes a replay. Keep the
      // claim until a captain deliberately releases the ambiguous operation.
      const free = !!job.releasing || job.state === "started";
      if (free) {
        this.data.active = null;
        job.freedAt = now;
        job.freedBy = source;
      }
      this.save();
      this.log("departed", { key: job.spec.key, source, lobbyId: job.lobbyId ?? null });
      this.logJob(job, was, source);
      if (free) this.log("claim-freed", { key: job.spec.key, reason: source });
    } else {
      const done = this.lobby ? finishedJob(this.data.jobs, this.lobby) : undefined;
      if (done) {
        done.departedAt = now;
        done.departedBy = source;
        delete done.leavePendingAt;
        this.save();
      }
      this.log("departed", { key: done?.spec.key ?? null, source });
    }
    this.lobby = null;
    this.absenceConfirmed = true;
  }
}
