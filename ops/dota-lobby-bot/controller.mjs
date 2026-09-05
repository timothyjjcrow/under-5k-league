import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

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
    /^(?:eu:)?(season|inhouse):[a-zA-Z0-9_-]{1,128}:[1-9]\d?$/.test(s.key) &&
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

export function rosterMatches(lobby, spec) {
  // These are GC team enums (0/1), distinct from match-data Radiant/Dire 2/3.
  // Only memberIndices refer to current members; allMembers can retain slots.
  const members = (lobby.memberIndices ?? [])
    .map((i) => lobby.allMembers[i])
    .filter(Boolean);
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

function safeToLeave(lobby, job) {
  return (
    [2, 3].includes(lobby.state) ||
    (lobby.state === 0 && !job.launchRequested && job.state !== "starting")
  );
}

/** Single account, single active lobby. Persist intent BEFORE any GC command.
 * No replay of ambiguous create/start after timeouts or process restarts.
 * Reconcile only the unique name/password on the account's actual GC snapshot.
 */
export class LobbyController {
  constructor({ file, transport, now = Date.now, serverRegion = 2, serverRegions = [serverRegion] }) {
    if (!validRegions(serverRegions)) throw new Error("Unsupported bot server regions");
    this.file = file;
    this.transport = transport;
    this.now = now;
    this.serverRegions = Object.freeze([...serverRegions]);
    this.lobby = null;
    this.online = false;
    this.absenceConfirmed = false;
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
  status(key) {
    const job = this.data.jobs[key];
    if (!job) return { state: "idle" };
    if (
      ["creating", "starting"].includes(job.state) &&
      this.now() - job.changedAt > 30_000
    ) {
      job.state = "blocked";
      this.save();
    }
    return {
      state:
        ((!this.online || !this.lobby) && job.state === "ready") ||
        (!this.online && ["creating", "starting"].includes(job.state))
          ? "blocked"
          : job.state,
      lobbyId: job.lobbyId,
      matchId: job.matchId,
    };
  }
  request(action, spec) {
    if (!validSpec(spec, this.serverRegions)) throw new BotError("INVALID");
    if (action === "status") return this.status(spec.key);
    if (!this.online) throw new BotError("OFFLINE");
    let job = this.data.jobs[spec.key];
    if (action === "create") {
      if (job && job.state !== "released") return this.status(spec.key);
      if (this.data.active || this.lobby) throw new BotError("BUSY");
      // A GC welcome can omit an up-to-date cache. Online alone does not
      // establish that the account has no existing lobby.
      if (!this.absenceConfirmed) throw new BotError("STATE");
      job = { spec, state: "creating", changedAt: this.now() };
      this.data.jobs[spec.key] = job;
      this.data.active = spec.key;
      this.absenceConfirmed = false;
      this.save();
      this.transport.create(spec);
    } else {
      if (!job || this.data.active !== spec.key) throw new BotError("STATE");
      // The payload's fresh roster may include an approved stand-in, but the
      // ticket and other creation settings cannot drift during the game.
      if (action === "start") {
        if (job.releasing) throw new BotError("STATE");
        if (job.state === "started" || job.state === "starting")
          return this.status(spec.key);
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
        job.state = "starting";
        job.launchRequested = true;
        job.changedAt = this.now();
        this.save();
        this.transport.start();
      } else if (action === "release") {
        // Never touch an unrelated lobby, nor interrupt server allocation.
        if (
          this.lobby &&
          (this.lobby.gameName !== job.spec.name ||
            this.lobby.passKey !== job.spec.password)
        )
          throw new BotError("STATE");
        // Immediately after Launch, the last snapshot can still say UI.
        // Its stale state cannot authorize Leave during server allocation.
        if (this.lobby && !safeToLeave(this.lobby, job))
          throw new BotError("STATE");
        if (!this.lobby && !this.absenceConfirmed) throw new BotError("STATE");
        // Retain the active claim until the GC confirms departure. A second
        // click cannot allocate another lobby while Leave is still in flight.
        job.releasing = true;
        this.save();
        if (this.lobby) this.transport.leave();
        else this.departed();
      } else throw new BotError("INVALID");
    }
    return this.status(spec.key);
  }
  snapshot(lobby) {
    this.lobby = lobby;
    this.absenceConfirmed = false;
    const job = this.data.jobs[this.data.active];
    if (!job) return;
    if (
      lobby.gameName !== job.spec.name ||
      lobby.passKey !== job.spec.password
    ) {
      job.state = "blocked";
      this.save();
      return;
    }
    job.lobbyId = lobby.lobbyId;
    if (lobby.matchId && lobby.matchId !== "0") job.matchId = lobby.matchId;
    if (lobby.state === 2 || lobby.state === 3) job.state = "started";
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
    }
    this.save();
    if (lobby.state === 3 || (job.releasing && safeToLeave(lobby, job)))
      this.transport.leave();
  }
  departed() {
    const job = this.data.jobs[this.data.active];
    if (job) {
      if (job.state !== "started")
        job.state = job.releasing ? "released" : "blocked";
      // An unexplained missing lobby never authorizes a replay. Keep the
      // claim until a captain deliberately releases the ambiguous operation.
      if (job.releasing || job.state === "started") this.data.active = null;
      this.save();
    }
    this.lobby = null;
    this.absenceConfirmed = true;
  }
}
