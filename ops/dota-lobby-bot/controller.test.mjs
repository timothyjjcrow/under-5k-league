import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDLE_RELEASE_MS,
  LAUNCH_SETTLE_MS,
  LAUNCH_STALL_MS,
  LEAVE_CONFIRM_MS,
  LobbyController,
  MAX_RESYNCS_PER_JOB,
  RESYNC_MIN_INTERVAL_MS,
  STARTED_BACKSTOP_MS,
  rosterMatches,
  validSpec,
} from "./controller.mjs";
import { formatEvent } from "./event-log.mjs";
import { validReply } from "../dota-lobby-relay/src/protocol.mjs";

const bot = "76561198000000099";
const ids = Array.from({ length: 10 }, (_, i) => `765611980000000${10 + i}`);
const spec = {
  key: "season:fixture:1",
  name: "LD2L fixture G1",
  password: "private123",
  leagueId: 12345,
  gameMode: 2,
  serverRegion: 2,
  radiant: ids.slice(0, 5),
  dire: ids.slice(5),
};

test("player identities support the full uint32 Dota account range", () => {
  assert.equal(validSpec({ ...spec, radiant: ["76561202255233023"] }), true);
  assert.equal(validSpec({ ...spec, radiant: ["76561202255233024"] }), false);
  assert.equal(validSpec({ ...spec, radiant: ["76561197960265728"] }), false);
});
const snapshot = (overrides = {}) => ({
  lobbyId: "123456789012345678",
  gameName: spec.name,
  passKey: spec.password,
  leaderId: bot,
  gameMode: 2,
  leagueid: 12345,
  serverRegion: 2,
  allowCheats: false,
  fillWithBots: false,
  seriesType: 0,
  state: 0,
  // What CSODOTALobby.decode always sets when Dota leaves them out.
  matchId: "0",
  matchOutcome: 0,
  memberIndices: ids.map((_, i) => i),
  allMembers: ids.map((id, i) => ({ id, team: i < 5 ? 0 : 1 })),
  ...overrides,
});
function setup(t, configuration = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ld2l-bot-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  // Invites are their own list, so the command sequences below stay exact.
  const invites = [];
  const transport = {
    steamId: () => bot,
    create: () => calls.push("create"),
    start: () => calls.push("start"),
    leave: () => calls.push("leave"),
    resync: () => calls.push("resync"),
    removeBotFromTeam: () => calls.push("kick"),
    invite: (id) => invites.push(id),
  };
  // Every event line exactly as the bot writes it.
  const logs = [];
  let now = 100;
  const options = {
    file: join(dir, "state.json"),
    transport,
    now: () => now,
    log: (event, fields) => logs.push(formatEvent(event, fields, new Date(now))),
    ...configuration,
  };
  const controller = new LobbyController(options);
  controller.online = true;
  // Equivalent to a full GC welcome confirming an empty account cache.
  controller.absenceConfirmed = true;
  return {
    controller,
    calls,
    invites,
    logs,
    transport,
    options,
    later: () => {
      now += 31_000;
    },
  };
}
// What server.mjs does with a GC welcome: forget the lobby, replay the caches
// it resent in full, settle, then count the bot online. `complete` is false
// when it left some unsent.
function welcome(c, lobbies = [], complete = true) {
  c.welcoming();
  for (const lobby of lobbies) c.snapshot(lobby);
  const freed = c.welcomed(complete);
  c.online = true;
  return freed;
}
test("US and EU bots accept only their configured server region", (t) => {
  const eu = { ...spec, serverRegion: 3 };
  assert.equal(validSpec(eu), false);
  assert.equal(validSpec(eu, 3), true);
  assert.equal(validSpec(spec, 3), false);
  const { controller: c, calls } = setup(t, { serverRegion: 3 });
  assert.throws(() => c.request("create", spec), /INVALID/);
  assert.deepEqual(calls, []);
  assert.equal(c.request("create", eu).state, "creating");
  c.snapshot(snapshot({ serverRegion: 3 }));
  assert.equal(c.status(eu.key).state, "ready");
  assert.equal(c.request("start", eu).state, "starting");
  assert.deepEqual(calls, ["create", "start"]);
});

test("an EU bot cannot start a lobby moved to the US region", (t) => {
  const { controller: c, calls } = setup(t, { serverRegion: 3 });
  const eu = { ...spec, serverRegion: 3 };
  c.request("create", eu);
  c.snapshot(snapshot({ serverRegion: 2 }));
  assert.equal(c.status(eu.key).state, "blocked");
  assert.throws(() => c.request("start", eu), /STATE/);
  assert.deepEqual(calls, ["create"]);
});

test("shared bot binds each namespace to its region and retains one global lobby claim", (t) => {
  const eu = { ...spec, key: `eu:${spec.key}`, name: "GGD2L Europe fixture", leagueId: 54321, serverRegion: 3 };
  const { controller: c, calls, options } = setup(t, { serverRegions: [2, 3] });
  assert.equal(validSpec(eu, [2, 3]), true);
  for (const invalid of [{ ...eu, serverRegion: 2 }, { ...spec, serverRegion: 3 },
    { ...eu, serverRegion: 1 }, { ...eu, key: `other:${spec.key}` }])
    assert.throws(() => c.request("create", invalid), /INVALID/);
  c.request("create", spec);
  assert.deepEqual(c.request("status", eu), { state: "idle" });
  assert.throws(() => c.request("create", eu), /BUSY/);
  assert.throws(() => c.request("release", eu), /STATE/);
  assert.throws(() => c.request("start", eu), /STATE/);
  // Equal database IDs remain separate even after a worker restart.
  const resumed = new LobbyController(options);
  resumed.online = true;
  resumed.snapshot(snapshot());
  assert.throws(() => resumed.request("create", eu), /BUSY/);
  resumed.request("release", spec);
  assert.throws(() => resumed.request("create", eu), /BUSY/);
  resumed.departed();
  resumed.request("create", eu);
  assert.equal(resumed.data.jobs[eu.key].spec.leagueId, 54321);
  assert.equal(resumed.data.jobs[spec.key].spec.leagueId, 12345);
  resumed.snapshot(snapshot({ gameName: eu.name, leagueid: eu.leagueId, serverRegion: 3 }));
  assert.equal(resumed.request("status", eu).state, "ready");
  assert.throws(() => resumed.request("start", { ...eu, leagueId: 12345 }), /SETTINGS/);
  assert.throws(() => resumed.request("release", spec), /STATE/);
  assert.throws(() => resumed.request("create", { ...spec, key: "inhouse:next:1" }), /BUSY/);
  resumed.request("start", eu);
  assert.deepEqual(calls, ["create", "leave", "create", "start"]);
});

test("shared worker constructor rejects unknown, duplicate, empty, or mutable allowlists", (t) => {
  const { options } = setup(t);
  for (const serverRegions of [[], [2, 2], [1, 2, 3], ["2"], "2,3"])
    assert.throws(() => new LobbyController({ ...options, serverRegions }), /Unsupported/);
  const serverRegions = [2, 3];
  const controller = new LobbyController({ ...options, serverRegions });
  serverRegions.push(1);
  assert.deepEqual(controller.serverRegions, [2, 3]);
  assert.ok(Object.isFrozen(controller.serverRegions));
});
test("an online session needs confirmed lobby absence before creating", (t) => {
  const { calls, options } = setup(t);
  const c = new LobbyController(options);
  c.online = true;
  // A welcome containing only up-to-date cache references has no snapshot.
  assert.throws(() => c.request("create", spec), /STATE/);
  assert.equal(c.data.active, null);
  assert.deepEqual(calls, []);
  // A subsequent full, empty GC cache makes the first create safe.
  c.absenceConfirmed = true;
  assert.equal(c.request("create", spec).state, "creating");
  assert.deepEqual(calls, ["create"]);
});
test("duplicate create and restart never send a second create", (t) => {
  const { controller: c, calls, options } = setup(t);
  assert.equal(c.request("create", spec).state, "creating");
  c.request("create", spec);
  const resumed = new LobbyController(options);
  resumed.online = true;
  resumed.request("create", spec);
  resumed.snapshot(snapshot());
  assert.equal(resumed.status(spec.key).state, "ready");
  assert.deepEqual(calls, ["create"]);
});
test("one account cannot host two fixtures, including ambiguous creates", (t) => {
  const { controller: c, later, calls } = setup(t);
  c.request("create", spec);
  later();
  assert.equal(c.status(spec.key).state, "blocked");
  assert.throws(
    () => c.request("create", { ...spec, key: "inhouse:other:1" }),
    /BUSY/,
  );
  assert.throws(() => c.request("release", spec), /STATE/);
  assert.deepEqual(calls, ["create"]);
});
test("wrong ticket, mode, region, cheats, or host cannot become ready", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  for (const override of [
    { leagueid: 0 },
    { gameMode: 1 },
    { serverRegion: 1 },
    { allowCheats: true },
    { fillWithBots: true },
    { leaderId: ids[0] },
  ]) {
    c.snapshot(snapshot(override));
    assert.equal(c.status(spec.key).state, "blocked");
    assert.throws(() => c.request("start", spec));
  }
  assert.deepEqual(calls, ["create"]);
});
test("start requires exactly the ten current players on their assigned sides", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot({ memberIndices: [0, 1, 2, 3, 5, 6, 7, 8, 9] }));
  assert.throws(() => c.request("start", spec), /ROSTER/);
  const swapped = snapshot();
  swapped.allMembers[0].team = 1;
  c.snapshot(swapped);
  assert.throws(() => c.request("start", spec), /ROSTER/);
  c.snapshot(snapshot());
  assert.equal(c.request("start", spec).state, "starting");
  c.request("start", spec);
  c.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  assert.equal(c.status(spec.key).matchId, "8123456789");
  assert.deepEqual(calls, ["create", "start"]);
});
test("a running game keeps the bot until its postgame, which frees it", (t) => {
  const { controller: c, calls } = setup(t);
  const next = { ...spec, key: "inhouse:next:1", name: "GGD2L Inhouse next" };
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(snapshot({ state: 2 }));
  c.snapshot(snapshot({ state: 2, matchId: "0" }));
  // Dota ignores a Leave while the game runs, so none goes out, match id or not.
  c.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  c.snapshot(snapshot({ state: 2, matchId: "8123456789", gameState: 5 }));
  assert.deepEqual(calls, ["create", "start"]);
  assert.equal(c.status(spec.key).matchId, "8123456789");
  assert.throws(() => c.request("create", next), /BUSY/);
  // Its postgame: leave, and hold the claim until Dota confirms the departure.
  c.snapshot(snapshot({ state: 3, matchId: "8123456789", matchOutcome: 2 }));
  assert.deepEqual(calls, ["create", "start", "leave"]);
  assert.throws(() => c.request("create", next), /BUSY/);
  c.departed("destroy");
  // The site still reads the game's match id after the bot has gone.
  assert.deepEqual(c.status(spec.key), {
    state: "started",
    lobbyId: "123456789012345678",
    matchId: "8123456789",
  });
  const job = c.data.jobs[spec.key];
  assert.equal(job.leaveReason, "postgame");
  assert.equal(job.departedBy, "destroy");
  assert.equal(job.freedBy, "destroy");
  assert.equal(job.leavePendingAt, undefined);
  assert.equal(c.request("create", next).state, "creating");
  assert.deepEqual(calls, ["create", "start", "leave", "create"]);
});
test("a reconnect outside the launched game's lobby frees its claim", (t) => {
  const { controller: c, calls } = setup(t);
  const next = { ...spec, key: "inhouse:next:1", name: "GGD2L Inhouse next" };
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  assert.deepEqual(calls, ["create", "start"]);
  // The GC drops before the game ends. A welcome that left a cache unsent
  // proves nothing, so the claim holds.
  c.online = false;
  assert.equal(welcome(c, [], false), false);
  c.online = true;
  assert.throws(() => c.request("create", next), /BUSY/);
  // A full welcome holding no lobby: the game is gone, and so is the claim.
  assert.equal(welcome(c), true);
  assert.equal(c.data.active, null);
  assert.deepEqual(c.status(spec.key), {
    state: "started",
    lobbyId: "123456789012345678",
    matchId: "8123456789",
  });
  assert.equal(c.request("create", next).state, "creating");
  assert.deepEqual(calls, ["create", "start", "create"]);
});
test("a restarted worker frees a launched game's claim on its first full welcome", (t) => {
  const { controller: c, calls, options } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  // The watchdog restarts the process before any departure arrives.
  const resumed = new LobbyController(options);
  assert.equal(resumed.data.active, spec.key);
  assert.equal(welcome(resumed), true);
  resumed.online = true;
  assert.equal(new LobbyController(options).data.active, null);
  resumed.request("create", { ...spec, key: "inhouse:next:1" });
  assert.deepEqual(calls, ["create", "start", "create"]);
});
test("a reconnect still inside the running game's lobby keeps the claim and sends no Leave", (t) => {
  const { controller: c, calls } = setup(t);
  const running = snapshot({ state: 2, matchId: "8123456789" });
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(running);
  assert.equal(welcome(c, [running]), false);
  assert.deepEqual(calls, ["create", "start"]);
  assert.equal(c.data.active, spec.key);
  assert.throws(() => c.request("create", { ...spec, key: "inhouse:next:1" }), /BUSY/);
});
test("a launch that fails to load comes back to the lobby screen and releases the bot for a retry", (t) => {
  const { controller: c, calls, options } = setup(t);
  const next = { ...spec, key: "inhouse:next:1", name: "GGD2L Inhouse next" };
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  // Running, no match id yet; then someone fails to load and Dota puts the
  // lobby back on the lobby screen with the dead attempt's match id.
  assert.equal(c.snapshot(snapshot({ state: 2 })), false);
  assert.deepEqual(calls, ["create", "start"]);
  assert.equal(c.snapshot(snapshot({ state: 0, matchId: "8123456789", matchOutcome: 67 })), true);
  assert.deepEqual(calls, ["create", "start", "leave"]);
  assert.equal(new LobbyController(options).data.jobs[spec.key].releasing, true);
  // Until Dota confirms the departure the claim holds, Game over isn't held
  // back (blocked is not "unlaunched"), and the dead id is nobody's result.
  assert.deepEqual(c.status(spec.key), { state: "blocked", lobbyId: "123456789012345678", matchId: undefined });
  assert.throws(() => c.request("create", next), /BUSY/);
  assert.throws(() => c.request("start", spec), /STATE/);
  // Later snapshots repeat the Leave, never the release or the dead id.
  assert.equal(c.snapshot(snapshot({ state: 0, matchId: "8123456789" })), false);
  assert.deepEqual(calls, ["create", "start", "leave", "leave"]);
  assert.equal(c.data.jobs[spec.key].matchId, undefined);
  assert.equal(c.data.jobs[spec.key].failedMatchId, "8123456789");
  c.departed();
  assert.equal(c.data.active, null);
  assert.deepEqual(c.status(spec.key), { state: "released", lobbyId: "123456789012345678", matchId: undefined });
  // The captains can create this game's lobby again: a retry, invited afresh.
  assert.equal(c.request("create", spec).state, "creating");
  assert.deepEqual(calls, ["create", "start", "leave", "leave", "create"]);
});
test("a launch that falls back before the game runs releases the bot", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  // Server assignment and setup, then back to the lobby screen with no match.
  c.snapshot(snapshot({ state: 6 }));
  c.snapshot(snapshot({ state: 1 }));
  assert.deepEqual(calls, ["create", "start"]);
  assert.equal(c.snapshot(snapshot({ state: 0 })), true);
  assert.deepEqual(calls, ["create", "start", "leave"]);
  c.departed();
  assert.equal(c.status(spec.key).state, "released");
  assert.equal(c.request("create", { ...spec, key: "inhouse:next:1" }).state, "creating");
});
test("a reconnect that finds a failed launch back on the lobby screen releases it", (t) => {
  const { controller: c, calls, options } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  // The worker restarts during the load; Dota sends the lobby back meanwhile.
  const resumed = new LobbyController(options);
  assert.equal(welcome(resumed, [snapshot({ state: 0, matchId: "8123456789" })]), false);
  resumed.online = true;
  assert.deepEqual(calls, ["create", "start", "leave"]);
  resumed.departed();
  assert.equal(new LobbyController(options).data.active, null);
  assert.equal(resumed.status(spec.key).state, "released");
});
test("a launch Dota never shows is released two minutes after Start", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  // The stale lobby-screen snapshot right after Start authorizes nothing.
  c.snapshot(snapshot());
  assert.equal(c.tick(), false);
  assert.throws(() => c.request("release", spec), /STATE/);
  const at = c.data.jobs[spec.key].changedAt;
  c.now = () => at + LAUNCH_SETTLE_MS - 1;
  assert.equal(c.tick(), false);
  assert.throws(() => c.request("release", spec), /STATE/);
  c.now = () => at + LAUNCH_SETTLE_MS;
  assert.equal(c.tick(), true);
  assert.deepEqual(calls, ["create", "start", "leave"]);
  assert.equal(c.tick(), false);
  c.departed();
  assert.equal(c.status(spec.key).state, "released");
  // Never while offline, nor in someone else's lobby.
  for (const blocker of ["offline", "foreign"]) {
    const { controller: d, calls: dc } = setup(t);
    d.request("create", spec);
    d.snapshot(snapshot());
    d.request("start", spec);
    const start = d.data.jobs[spec.key].changedAt;
    d.now = () => start + LAUNCH_SETTLE_MS;
    if (blocker === "offline") d.online = false;
    else d.lobby = snapshot({ gameName: "Someone else's lobby" });
    assert.equal(d.tick(), false);
    assert.deepEqual(dc, ["create", "start"]);
  }
});
test("a captain or admin can release a launch that never showed, once it has settled", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(snapshot());
  const at = c.data.jobs[spec.key].changedAt;
  c.now = () => at + LAUNCH_SETTLE_MS;
  assert.equal(c.request("release", spec).state, "blocked");
  assert.deepEqual(calls, ["create", "start", "leave"]);
  c.departed();
  assert.equal(c.status(spec.key).state, "released");
});
test("a played game's lobby back on the lobby screen keeps its match id", (t) => {
  // Seen through its postgame, or replayed after a drop with a winner.
  for (const path of ["postgame", "winner"]) {
    const { controller: c, calls } = setup(t);
    c.request("create", spec);
    c.snapshot(snapshot());
    c.request("start", spec);
    c.snapshot(snapshot({ state: 2 }));
    if (path === "postgame") {
      c.snapshot(snapshot({ state: 3, matchId: "8123456789" }));
      assert.deepEqual(calls, ["create", "start", "leave"]);
      // That Leave went unanswered and the lobby came back: leave again.
      assert.equal(c.snapshot(snapshot({ state: 0, matchId: "8123456789" })), false);
      assert.deepEqual(calls, ["create", "start", "leave", "leave"]);
      // Nor does the clock ever count it as a failed launch. The Leave still
      // unconfirmed by then gets a resync, whose complete welcome frees it.
      c.now = () => c.data.jobs[spec.key].changedAt + LAUNCH_STALL_MS;
      assert.equal(c.tick(), false);
      assert.deepEqual(calls, ["create", "start", "leave", "leave", "resync"]);
      assert.equal(c.data.jobs[spec.key].matchId, "8123456789");
      assert.equal(c.data.jobs[spec.key].releasing, undefined);
      assert.equal(welcome(c), true);
    } else {
      assert.equal(welcome(c, [snapshot({ state: 0, matchId: "8123456789", matchOutcome: 2 })]), false);
      assert.deepEqual(calls, ["create", "start", "leave"]);
      assert.equal(c.data.jobs[spec.key].releasing, undefined);
      c.departed();
    }
    assert.deepEqual(c.status(spec.key), {
      state: "started",
      lobbyId: "123456789012345678",
      matchId: "8123456789",
    });
    // A played game is never re-created.
    assert.equal(c.request("create", spec).state, "started");
  }
});
test("a lobby nobody starts is released 30 minutes after Create", (t) => {
  const { controller: c, calls, options } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  const at = c.data.jobs[spec.key].changedAt;
  c.now = () => at + IDLE_RELEASE_MS - 1;
  assert.equal(c.tick(), false);
  c.now = () => at + IDLE_RELEASE_MS;
  assert.equal(c.tick(), true);
  assert.deepEqual(calls, ["create", "leave"]);
  // Saved before the Leave: a restart now still finishes the release.
  assert.equal(new LobbyController(options).data.jobs[spec.key].releasing, true);
  c.departed();
  assert.equal(c.status(spec.key).state, "released");
  // A running game never counts as idle, even once status() has run.
  const { controller: d, calls: dc } = setup(t);
  d.request("create", spec);
  d.snapshot(snapshot());
  d.request("start", spec);
  d.snapshot(snapshot({ state: 2 }));
  const start = d.data.jobs[spec.key].changedAt;
  d.now = () => start + IDLE_RELEASE_MS;
  assert.equal(d.status(spec.key).state, "started");
  assert.equal(d.tick(), false);
  assert.deepEqual(dc, ["create", "start"]);
});
test("a lobby blocked before any launch is released 30 minutes after Create", (t) => {
  const { controller: c, calls, options } = setup(t);
  c.request("create", spec);
  // Dota never confirmed the ticket: the bot's own lobby, blocked.
  c.snapshot(snapshot({ leagueid: 0 }));
  assert.equal(c.status(spec.key).state, "blocked");
  const at = c.data.jobs[spec.key].changedAt;
  c.now = () => at + IDLE_RELEASE_MS;
  assert.equal(c.tick(), true);
  assert.deepEqual(calls, ["create", "leave"]);
  // Saved before the Leave: a restart now still finishes the release.
  assert.equal(new LobbyController(options).data.jobs[spec.key].releasing, true);
  c.departed();
  assert.equal(c.status(spec.key).state, "released");
});
test("players joining, leaving or changing sides restart the idle clock", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot({ memberIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8] }));
  const at = c.data.jobs[spec.key].changedAt;
  // The tenth sits down at 29 minutes: seated, about to start.
  c.now = () => at + IDLE_RELEASE_MS - 60_000;
  c.snapshot(snapshot());
  // An update that changes nobody's seat doesn't count as activity.
  c.now = () => at + IDLE_RELEASE_MS;
  c.snapshot(snapshot());
  assert.equal(c.tick(), false);
  c.now = () => at + 2 * IDLE_RELEASE_MS - 60_000;
  assert.equal(c.tick(), true);
  assert.deepEqual(calls, ["create", "leave"]);
});
test("the idle clock never acts off the lobby screen, as when a player relaunches it", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  // The bot lost leadership after a reconnect, so its job reads blocked, and
  // the new leader launches the lobby themselves.
  c.snapshot(snapshot({ leaderId: ids[0] }));
  assert.equal(c.status(spec.key).state, "blocked");
  const at = c.data.jobs[spec.key].changedAt;
  // Long past the idle clock, a minute into the player's server setup.
  c.now = () => at + 2 * IDLE_RELEASE_MS;
  c.snapshot(snapshot({ leaderId: ids[0], state: 6 }));
  c.now = () => at + 2 * IDLE_RELEASE_MS + 60_000;
  assert.equal(c.tick(), false);
  assert.deepEqual(calls, ["create"]);
});
test("a launch given up too soon that Dota then shows running is a game after all", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  // No update reaches the bot for two minutes, so the clock gives up on it.
  const at = c.data.jobs[spec.key].changedAt;
  c.now = () => at + LAUNCH_SETTLE_MS;
  assert.equal(c.tick(), true);
  assert.deepEqual(calls, ["create", "start", "leave"]);
  // Then Dota's late update: the game is running, with its match id.
  c.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  assert.equal(c.data.jobs[spec.key].state, "started");
  c.departed();
  assert.equal(c.data.active, null);
  assert.deepEqual(c.status(spec.key), { state: "started", lobbyId: "123456789012345678", matchId: "8123456789" });
});
test("a launch given up too soon is undone by a winner on the lobby screen, keeping its match id", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(snapshot({ state: 6 }));
  const at = c.data.jobs[spec.key].changedAt;
  c.now = () => at + LAUNCH_STALL_MS;
  assert.equal(c.tick(), true);
  // Dota ignored that Leave, the game was played, and a drop hid it all.
  assert.equal(welcome(c, [snapshot({ state: 0, matchId: "8123456789", matchOutcome: 2 })]), false);
  assert.equal(c.data.jobs[spec.key].state, "started");
  assert.equal(c.data.jobs[spec.key].launchFailed, undefined);
  c.departed();
  assert.deepEqual(c.status(spec.key), { state: "started", lobbyId: "123456789012345678", matchId: "8123456789" });
  assert.deepEqual(calls, ["create", "start", "leave", "leave"]);
});
test("an undone launch goes back to the normal path, so a real failure after it is still caught", (t) => {
  const { controller: c } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  // A failed load gives up on it with the attempt's match id...
  c.snapshot(snapshot({ state: 0, matchId: "8123456789" }));
  assert.equal(c.data.jobs[spec.key].failedMatchId, "8123456789");
  // ...then Dota shows it running after all, before any match id: undone,
  // with the launch's id restored and no release pending.
  c.snapshot(snapshot({ state: 2 }));
  assert.equal(c.data.jobs[spec.key].matchId, "8123456789");
  assert.equal(c.data.jobs[spec.key].releasing, undefined);
  assert.equal(c.data.jobs[spec.key].state, "started");
  // And when it then really fails, that is released for a retry.
  assert.equal(c.snapshot(snapshot({ state: 0, matchId: "8123456789", matchOutcome: 67 })), true);
  c.departed();
  assert.equal(c.status(spec.key).state, "released");
});
test("a launch a player started after taking the lead is released if it stalls", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  // A reconnect hands the lead to a player, who launches from Dota.
  c.snapshot(snapshot({ leaderId: ids[0] }));
  const at = c.data.jobs[spec.key].changedAt + IDLE_RELEASE_MS;
  c.now = () => at;
  c.snapshot(snapshot({ leaderId: ids[0], state: 6 }));
  c.now = () => at + LAUNCH_STALL_MS - 1;
  assert.equal(c.tick(), false);
  assert.throws(() => c.request("release", spec), /STATE/);
  c.now = () => at + LAUNCH_STALL_MS;
  assert.equal(c.request("release", spec).state, "blocked");
  assert.deepEqual(calls, ["create", "leave"]);
  c.departed();
  assert.equal(c.status(spec.key).state, "released");
  // Back on the lobby screen, its next launch gets its own ten minutes.
  const { controller: d } = setup(t);
  d.request("create", spec);
  d.snapshot(snapshot({ leaderId: ids[0] }));
  d.snapshot(snapshot({ leaderId: ids[0], state: 6 }));
  d.now = () => 100 + LAUNCH_STALL_MS;
  d.snapshot(snapshot({ leaderId: ids[0] }));
  assert.equal(d.snapshot(snapshot({ leaderId: ids[0], state: 6 })), false);
  assert.equal(d.tick(), false);
  assert.equal(d.data.jobs[spec.key].releasing, undefined);
});
test("a launch a reconnect gave up on is claimed back when its lobby then shows the game", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(snapshot({ state: 6 }));
  c.snapshot(snapshot({ state: 1 }));
  // A full welcome with no lobby in it: the launch Dota showed is over...
  assert.equal(welcome(c), true);
  assert.equal(c.status(spec.key).state, "released");
  // ...until the lobby's own cache arrives with the game loading.
  c.snapshot(snapshot({ state: 2 }));
  assert.equal(c.data.active, spec.key);
  assert.equal(c.data.jobs[spec.key].state, "started");
  assert.deepEqual(calls, ["create", "start"]);
  // Followed as usual: the bot stays while it runs, and leaves at its postgame.
  c.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  assert.deepEqual(calls, ["create", "start"]);
  c.snapshot(snapshot({ state: 3, matchId: "8123456789", matchOutcome: 3 }));
  assert.deepEqual(calls, ["create", "start", "leave"]);
  c.departed();
  assert.equal(c.data.active, null);
  assert.deepEqual(c.status(spec.key), { state: "started", lobbyId: "123456789012345678", matchId: "8123456789" });
});
test("a launch whose lobby is provably gone is freed once it has settled", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  // Dota drops the lobby before showing the launch: the claim stays...
  c.departed();
  assert.equal(c.data.active, spec.key);
  const at = c.data.jobs[spec.key].changedAt;
  c.now = () => at + LAUNCH_SETTLE_MS - 1;
  assert.equal(c.tick(), false);
  // ...until the launch has had time to show, then it frees with no Leave.
  c.now = () => at + LAUNCH_SETTLE_MS;
  assert.equal(c.tick(), true);
  assert.equal(c.data.active, null);
  assert.equal(c.status(spec.key).state, "released");
  assert.deepEqual(calls, ["create", "start"]);
  // Not while the bot's absence is unproven (a create with no answer yet).
  const { controller: d } = setup(t);
  d.request("create", spec);
  d.snapshot(snapshot());
  d.request("start", spec);
  d.lobby = null;
  d.absenceConfirmed = false;
  d.now = () => d.data.jobs[spec.key].changedAt + LAUNCH_SETTLE_MS;
  assert.equal(d.tick(), false);
  assert.equal(d.data.active, spec.key);
});
test("a Create Dota never answers is freed two minutes later, so the next Create works", (t) => {
  const { controller: c, calls, options } = setup(t);
  c.request("create", spec);
  const at = c.data.jobs[spec.key].changedAt;
  // No lobby ever arrives: "Lobby needs attention" after 30 s...
  c.now = () => at + 31_000;
  assert.equal(c.status(spec.key).state, "blocked");
  assert.equal(c.tick(), false);
  assert.throws(() => c.request("create", { ...spec, key: "inhouse:next:1" }), /BUSY/);
  c.now = () => at + LAUNCH_SETTLE_MS - 1;
  assert.equal(c.tick(), false);
  // ...and freed at two minutes, with nothing to leave and the state saved.
  c.now = () => at + LAUNCH_SETTLE_MS;
  assert.equal(c.tick(), true);
  assert.deepEqual(calls, ["create"]);
  assert.equal(c.data.active, null);
  assert.equal(new LobbyController(options).data.active, null);
  assert.equal(c.status(spec.key).state, "released");
  // The same game, or any other, can create again.
  assert.equal(c.request("create", spec).state, "creating");
  assert.deepEqual(calls, ["create", "create"]);
});
test("a lobby that vanishes before any launch is freed, but never while it might exist", (t) => {
  // Dota removed it: the bot's absence is proven, so the claim frees.
  const { controller: c } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.departed();
  assert.equal(c.data.active, spec.key);
  c.now = () => c.data.jobs[spec.key].changedAt + LAUNCH_SETTLE_MS;
  assert.equal(c.tick(), true);
  assert.equal(c.data.active, null);
  assert.equal(c.status(spec.key).state, "released");
  // A lobby the bot was in but whose absence is unproven (dropped mid-cache)
  // is never freed by the clock.
  const { controller: d } = setup(t);
  d.request("create", spec);
  d.snapshot(snapshot());
  d.lobby = null;
  d.absenceConfirmed = false;
  d.now = () => d.data.jobs[spec.key].changedAt + IDLE_RELEASE_MS;
  assert.equal(d.tick(), false);
  assert.equal(d.data.active, spec.key);
});
test("a launch stuck setting up a server is released ten minutes after Start", (t) => {
  for (const state of [1, 4, 5, 6]) {
    const { controller: c, calls, options } = setup(t);
    c.request("create", spec);
    c.snapshot(snapshot());
    c.request("start", spec);
    c.snapshot(snapshot({ state }));
    const at = c.data.jobs[spec.key].changedAt;
    c.now = () => at + 31_000;
    assert.equal(c.status(spec.key).state, "blocked");
    c.now = () => at + LAUNCH_STALL_MS - 1;
    assert.equal(c.tick(), false);
    assert.throws(() => c.request("release", spec), /STATE/);
    c.now = () => at + LAUNCH_STALL_MS;
    assert.equal(c.tick(), true);
    assert.deepEqual(calls, ["create", "start", "leave"]);
    assert.equal(new LobbyController(options).data.jobs[spec.key].releasing, true);
    c.departed();
    assert.equal(c.status(spec.key).state, "released");
  }
  // And a captain's Release is accepted from then on.
  const { controller: d, calls: dc } = setup(t);
  d.request("create", spec);
  d.snapshot(snapshot());
  d.request("start", spec);
  d.snapshot(snapshot({ state: 6 }));
  const at = d.data.jobs[spec.key].changedAt;
  d.now = () => at + LAUNCH_STALL_MS;
  assert.equal(d.request("release", spec).state, "blocked");
  assert.deepEqual(dc, ["create", "start", "leave"]);
});
test("a launch whose lobby goes away before it runs is over, and frees the bot", (t) => {
  for (const path of ["departed", "welcome"]) {
    const { controller: c } = setup(t);
    c.request("create", spec);
    c.snapshot(snapshot());
    c.request("start", spec);
    c.snapshot(snapshot({ state: 1, matchId: "8123456789" }));
    if (path === "departed") c.departed();
    else assert.equal(welcome(c), true);
    assert.equal(c.data.active, null);
    assert.deepEqual(c.status(spec.key), { state: "released", lobbyId: "123456789012345678", matchId: undefined });
    assert.equal(c.request("create", spec).state, "creating");
  }
  // A Start Dota never showed still keeps its claim for a deliberate release.
  const { controller: d } = setup(t);
  d.request("create", spec);
  d.snapshot(snapshot());
  d.request("start", spec);
  d.departed();
  assert.equal(d.data.active, spec.key);
});
test("Dota's not-scored postgame is a failed launch, not a played game", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(snapshot({ state: 2 }));
  assert.equal(c.snapshot(snapshot({ state: 3, matchId: "8123456789", matchOutcome: 67 })), true);
  assert.deepEqual(calls, ["create", "start", "leave"]);
  // Later postgame snapshots never turn it back into a started game.
  c.snapshot(snapshot({ state: 3, matchId: "8123456789", matchOutcome: 67 }));
  assert.equal(c.data.jobs[spec.key].state, "blocked");
  c.departed();
  assert.deepEqual(c.status(spec.key), { state: "released", lobbyId: "123456789012345678", matchId: undefined });
  assert.equal(c.data.jobs[spec.key].failedMatchId, "8123456789");
});
test("a played game a drop hid until it was back on the lobby screen frees its claim", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  // No server-setup, running or postgame snapshot ever arrived.
  assert.equal(welcome(c, [snapshot({ state: 0, matchId: "8123456789", matchOutcome: 3 })]), false);
  assert.deepEqual(calls, ["create", "start", "leave"]);
  assert.equal(c.data.jobs[spec.key].state, "started");
  c.departed();
  assert.equal(c.data.active, null);
  assert.deepEqual(c.status(spec.key), { state: "started", lobbyId: "123456789012345678", matchId: "8123456789" });
});
test("a finished job's lobby that turns up after its claim was freed is left", (t) => {
  const { controller: c, calls } = setup(t);
  const next = { ...spec, key: "inhouse:next:1", name: "GGD2L Inhouse next" };
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  // A full welcome with no lobby in it frees the launched game's claim...
  assert.equal(welcome(c), true);
  assert.equal(c.data.active, null);
  // ...and then the lobby's own cache arrives, back on the lobby screen.
  c.snapshot(snapshot({ state: 0, matchId: "8123456789" }));
  assert.deepEqual(calls, ["create", "start", "leave"]);
  assert.equal(c.data.jobs[spec.key].leaveReason, "orphan");
  assert.throws(() => c.request("create", next), /BUSY/);
  c.departed("destroy");
  assert.equal(c.data.jobs[spec.key].leavePendingAt, undefined);
  assert.equal(c.request("create", next).state, "creating");
  assert.equal(c.status(spec.key).state, "started");
  assert.deepEqual(calls, ["create", "start", "leave", "create"]);
});
test("with no claim, the bot never leaves a lobby that isn't a finished job's", (t) => {
  const { controller: c, calls } = setup(t);
  // An unlaunched job's lobby that no claim covers (blocked jobs keep their
  // claim, so this is only a guard), and a stranger's lobby.
  c.request("create", spec);
  c.snapshot(snapshot());
  c.data.active = null;
  c.data.jobs[spec.key].state = "blocked";
  c.snapshot(snapshot());
  c.snapshot(snapshot({ gameName: "Someone else's lobby" }));
  assert.deepEqual(calls, ["create"]);
});
test("a reconnect outside a released lobby finishes the release", (t) => {
  const next = { ...spec, key: "inhouse:next:1", name: "GGD2L Inhouse next" };
  // A ready lobby, and one Dota left blocked (here a wrong ticket).
  for (const lobby of [snapshot(), snapshot({ leagueid: 0 })]) {
    const { controller: c, calls } = setup(t);
    c.request("create", spec);
    c.snapshot(lobby);
    c.request("release", spec);
    assert.deepEqual(calls, ["create", "leave"]);
    // The GC drops before it confirms the departure. A welcome that left a
    // cache unsent proves nothing, so the claim holds.
    c.online = false;
    assert.equal(welcome(c, [], false), false);
    c.online = true;
    assert.throws(() => c.request("create", next), /BUSY/);
    // A full welcome holding no lobby is the departure the drop swallowed.
    assert.equal(welcome(c), true);
    assert.equal(c.data.active, null);
    assert.equal(c.status(spec.key).state, "released");
    assert.equal(c.request("create", next).state, "creating");
    assert.deepEqual(calls, ["create", "leave", "create"]);
  }
});
test("a restarted worker finishes a release on its first full welcome", (t) => {
  const { controller: c, calls, options } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("release", spec);
  // The watchdog restarts the process before any departure arrives.
  const resumed = new LobbyController(options);
  assert.equal(welcome(resumed), true);
  resumed.online = true;
  assert.equal(new LobbyController(options).data.active, null);
  assert.equal(resumed.status(spec.key).state, "released");
  resumed.request("create", { ...spec, key: "inhouse:next:1" });
  assert.deepEqual(calls, ["create", "leave", "create"]);
});
test("a reconnect still inside a released lobby leaves it again", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("release", spec);
  // The Leave itself was lost: the welcome replays the lobby.
  assert.equal(welcome(c, [snapshot()]), false);
  assert.deepEqual(calls, ["create", "leave", "leave"]);
  assert.equal(c.data.active, spec.key);
  assert.throws(() => c.request("create", { ...spec, key: "inhouse:next:1" }), /BUSY/);
});
test("a reconnect never frees an unlaunched or ambiguous claim nobody released", (t) => {
  const reach = {
    // An ambiguous create: Dota may still make the lobby.
    creating: () => {},
    ready: (c) => c.snapshot(snapshot()),
    // An unconfirmed launch: Dota may still be allocating a server.
    starting: (c) => {
      c.snapshot(snapshot());
      c.request("start", spec);
    },
    blocked: (c) => c.snapshot(snapshot({ leagueid: 0 })),
  };
  for (const [state, to] of Object.entries(reach)) {
    const { controller: c } = setup(t);
    c.request("create", spec);
    to(c);
    assert.equal(c.data.jobs[spec.key].state, state);
    assert.equal(welcome(c), false, state);
    assert.equal(c.data.active, spec.key, state);
    assert.throws(() => c.request("create", { ...spec, key: "inhouse:next:1" }), /BUSY/);
  }
});
test("server.mjs runs the controller's clock every 30 s and after each Leave's deadline, and a throw never kills it", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /function runClock\(\) \{\s*try \{\s*if \(controller\.tick\(\)\)[\s\S]*?\} catch \{[\s\S]*?\}\s*\}/,
  );
  assert.match(source, /setInterval\(runClock, 30_000\)/);
  // Every Leave the transport sends schedules a check just past its deadline.
  assert.match(
    source,
    /leave: \(\) => \{\s*send\(7040, "Empty"\);\s*setTimeout\(runClock, LEAVE_CONFIRM_MS \+ 1000\)/,
  );
});
test("server.mjs settles every GC welcome through the controller, forgetting the lobby first", () => {
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const start = server.indexOf("k_EMsgGCClientWelcome,");
  assert.ok(start > 0);
  const handler = server.slice(start, server.indexOf("\n});", start));
  const forget = handler.indexOf("controller.welcoming()");
  const replay = handler.indexOf("subscribed(cache)");
  const settle = handler.indexOf("controller.welcomed(");
  assert.ok(forget > 0 && forget < replay && replay < settle);
  // A welcome ends a resync's countdown to a restart.
  const ended = handler.indexOf("resync.welcomed()");
  assert.ok(ended > 0 && ended < forget);
  assert.doesNotMatch(handler, /absenceConfirmed\s*=|controller\.lobby\s*=/);
});
test("server.mjs resyncs through gc-resync.mjs, and restarts when no welcome follows", () => {
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const start = server.indexOf("const resync = gcResync({");
  assert.ok(start > 0);
  const setup = server.slice(start, server.indexOf("\n});", start));
  assert.match(setup, /noWelcome: \(\) => \{[\s\S]*?exitForRestart\(\)/);
  assert.match(setup, /stopped: \(\) => steamStopped/);
  assert.match(server, /resync: \(\) => resync\.start\(\),/);
  assert.match(server, /function exitForRestart\(\) \{[\s\S]*?process\.exit\(1\)/);
  // The cycle itself never sends a lobby command.
  const cycle = readFileSync(new URL("./gc-resync.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(cycle, /\bsend(?:ToGC|RawBuffer|Partial)?\(|\b70(?:38|40|41)\b/);
  assert.match(cycle, /user\.gamesPlayed\(\[\]\)/);
});
test("server.mjs names the source of every departure it reports", () => {
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(server, /controller\.departed\(\)/);
  for (const source of ["destroy", "removed", "unsubscribed"])
    assert.match(server, new RegExp(`"${source}"`));
});
test("stale allMembers entries do not count as connected players", () => {
  assert.equal(rosterMatches(snapshot({ memberIndices: [] }), spec), false);
});
test("remove the bot from a playing slot, keeping ten human seats", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(
    snapshot({ allMembers: [{ id: bot, team: 0 }], memberIndices: [0] }),
  );
  assert.deepEqual(calls, ["create", "kick"]);
});
test("release waits for departure and permits an explicit new lobby only then", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("release", spec);
  assert.throws(
    () => c.request("create", { ...spec, key: "season:next:1" }),
    /BUSY/,
  );
  c.departed();
  assert.equal(c.status(spec.key).state, "released");
  c.request("create", { ...spec, key: "season:next:1" });
  assert.deepEqual(calls, ["create", "leave", "create"]);
});
test("release prevents a competing captain from launching, including after restart", (t) => {
  const { controller: c, calls, options } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("release", spec);
  assert.throws(() => c.request("start", spec), /STATE/);
  const resumed = new LobbyController(options);
  resumed.online = true;
  resumed.snapshot(snapshot());
  assert.throws(() => resumed.request("start", spec), /STATE/);
  assert.deepEqual(calls, ["create", "leave", "leave"]);
});
test("an unconfirmed launch cannot be released using a stale UI snapshot", (t) => {
  const { controller: c, calls, options, later } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  assert.throws(() => c.request("release", spec), /STATE/);
  later();
  assert.equal(c.status(spec.key).state, "blocked");
  const resumed = new LobbyController(options);
  resumed.online = true;
  resumed.snapshot(snapshot());
  assert.throws(() => resumed.request("release", spec), /STATE/);
  for (const state of [1, 4, 5, 6]) {
    resumed.snapshot(snapshot({ state }));
    assert.throws(() => resumed.request("release", spec), /STATE/);
  }
  assert.deepEqual(calls, ["create", "start"]);
  // Once the game runs, a Release sends no Leave (Dota ignores it then): it
  // waits for the postgame, and asks the Game Coordinator where the bot is.
  resumed.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  assert.deepEqual(calls, ["create", "start"]);
  assert.equal(resumed.request("release", spec).state, "started");
  assert.deepEqual(calls, ["create", "start", "resync"]);
});
test("pending release retries wait through GC allocation states, then the game", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("release", spec);
  for (const state of [1, 4, 5, 6]) c.snapshot(snapshot({ state }));
  assert.deepEqual(calls, ["create", "leave"]);
  c.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  assert.deepEqual(calls, ["create", "leave"]);
  c.snapshot(snapshot({ state: 3, matchId: "8123456789", matchOutcome: 2 }));
  assert.deepEqual(calls, ["create", "leave", "leave"]);
});
test("confirmed departure allows an explicit release of an ambiguous launch", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.departed();
  assert.equal(c.status(spec.key).state, "blocked");
  assert.equal(c.data.active, spec.key);
  assert.equal(c.request("release", spec).state, "released");
  c.request("create", { ...spec, key: "inhouse:next:1" });
  assert.deepEqual(calls, ["create", "start", "create"]);
});
test("postgame frees the bot, but completed requests cannot be replayed", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot({ state: 3, matchId: "8123456789" }));
  c.departed();
  assert.equal(c.request("create", spec).state, "started");
  c.request("create", { ...spec, key: "season:fixture:2" });
  assert.deepEqual(calls, ["create", "leave", "create"]);
});
test("timed out starts survive restart without a second launch", (t) => {
  const { controller: c, calls, options, later } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  later();
  assert.equal(c.status(spec.key).state, "blocked");
  // The clock saves what status() showed.
  assert.equal(c.tick(), false);
  const resumed = new LobbyController(options);
  resumed.online = true;
  resumed.snapshot(snapshot());
  assert.throws(() => resumed.request("start", spec), /STATE/);
  assert.deepEqual(calls, ["create", "start"]);
});
test("unrelated lobbies and offline sessions never receive commands", (t) => {
  const { controller: c, calls } = setup(t);
  c.online = false;
  assert.throws(() => c.request("create", spec), /OFFLINE/);
  c.online = true;
  c.snapshot(snapshot({ gameName: "Someone else's lobby" }));
  assert.throws(() => c.request("create", spec), /BUSY/);
  assert.deepEqual(calls, []);
});

// A just-created lobby: only the bot, in the unassigned pool (GC team 4).
const emptyLobby = (overrides = {}) =>
  snapshot({ memberIndices: [0], allMembers: [{ id: bot, team: 4 }], ...overrides });
// The bot plus the given roster players on their sides.
const lobbyWith = (present, overrides = {}) => {
  const allMembers = [{ id: bot, team: 4 }, ...present.map((id) => ({ id, team: ids.indexOf(id) < 5 ? 0 : 1 }))];
  return snapshot({ memberIndices: allMembers.map((_, i) => i), allMembers, ...overrides });
};

test("the lobby's first ready moment invites every rostered player, once per job", (t) => {
  const { controller: c, invites, calls, options } = setup(t);
  c.request("create", spec);
  assert.deepEqual(invites, []);
  c.snapshot(lobbyWith(ids.slice(0, 2)));
  // Already in the lobby: no invite. The bot never invites itself.
  assert.deepEqual(invites, ids.slice(2));
  // Later snapshots, a GC reconnect replay, and a worker restart send nothing.
  c.snapshot(emptyLobby());
  c.snapshot(lobbyWith(ids.slice(0, 2)));
  const resumed = new LobbyController(options);
  resumed.online = true;
  resumed.snapshot(emptyLobby());
  assert.deepEqual(invites, ids.slice(2));
  assert.deepEqual(calls, ["create"]);
});

test("each invite is saved before it goes out, and a failed send is recorded, not retried", (t) => {
  const { controller: c, transport, invites, options } = setup(t);
  c.request("create", spec);
  // Read back from disk at send time: the record exists before the GC
  // command. Asserted afterwards, since the bot catches a throwing send.
  const onDisk = [];
  transport.invite = (id) => {
    onDisk.push(JSON.parse(readFileSync(options.file, "utf8")).jobs[spec.key].invites?.[id]?.result);
    if (id === ids[3]) throw new Error("Cannot send GC message, not logged into Steam Client");
    invites.push(id);
  };
  c.snapshot(emptyLobby());
  assert.deepEqual(onDisk, ids.map(() => "sent"));
  assert.equal(invites.length, 9);
  const report = c.request("status", { ...spec, withPlayers: true }).players;
  assert.equal(report.find((p) => p.id === ids[3]).invite, "failed");
  assert.equal(report.find((p) => p.id === ids[4]).invite, "sent");
  // The record survives a restart.
  const resumed = new LobbyController(options);
  assert.equal(resumed.data.jobs[spec.key].invites[ids[3]].result, "failed");
});

test("no invites from a lobby that isn't ready: foreign, wrong settings, another host, or releasing", (t) => {
  const { controller: c, invites } = setup(t);
  c.request("create", spec);
  c.snapshot(emptyLobby({ gameName: "Someone else's lobby" }));
  c.snapshot(emptyLobby({ leagueid: 0 }));
  c.snapshot(emptyLobby({ leaderId: ids[0] }));
  assert.equal(c.status(spec.key).state, "blocked");
  assert.deepEqual(invites, []);

  const second = setup(t);
  second.controller.request("create", spec);
  second.controller.data.jobs[spec.key].releasing = true;
  second.controller.snapshot(emptyLobby());
  assert.deepEqual(second.invites, []);
});

test("re-invite sends only to the missing, held back 30 s and five per player", (t) => {
  const { controller: c, invites, later } = setup(t);
  c.request("create", spec);
  c.snapshot(lobbyWith(ids.slice(0, 8)));
  assert.deepEqual(invites, ids.slice(8));
  // Straight after the automatic round: held back.
  assert.equal(c.request("invite", spec).invited, 0);
  later();
  assert.equal(c.request("invite", spec).invited, 2);
  // A press repeated (or a timed-out one resent) inside 30 s sends nothing.
  assert.equal(c.request("invite", spec).invited, 0);
  for (let i = 0; i < 5; i++) {
    later();
    c.request("invite", spec);
  }
  // 1 automatic + 4 more: the fifth is the last for each.
  assert.equal(invites.filter((id) => id === ids[9]).length, 5);
  // A player who arrived in the meantime gets none.
  later();
  c.snapshot(lobbyWith(ids));
  assert.equal(c.request("invite", spec).invited, 0);
});

test("re-invite can name players, including a stand-in booked after create", (t) => {
  const { controller: c, invites, later } = setup(t);
  c.request("create", spec);
  c.snapshot(lobbyWith(ids.slice(0, 9)));
  later();
  const standin = "76561198000000050";
  const fresh = { ...spec, dire: [...ids.slice(5, 9), standin] };
  const reply = c.request("invite", { ...fresh, invite: [standin] });
  assert.equal(reply.invited, 1);
  assert.equal(invites.at(-1), standin);
  // Only ids on the request's own roster, each once.
  for (const invite of [[], ["76561198000000077"], [standin, standin], "all", [ids[9]]])
    assert.throws(() => c.request("invite", { ...fresh, invite }), /INVALID/);
});

test("re-invite refuses outside this job's own ready lobby", (t) => {
  const { controller: c, invites, later } = setup(t);
  assert.throws(() => c.request("invite", spec), /STATE/);
  c.request("create", spec);
  // Created, not yet confirmed by the GC: inviting now would make Dota open a default lobby.
  assert.throws(() => c.request("invite", spec), /STATE/);
  c.snapshot(emptyLobby({ leaderId: ids[0] }));
  assert.throws(() => c.request("invite", spec), /STATE/);
  c.snapshot(emptyLobby());
  later();
  assert.throws(() => c.request("invite", { ...spec, leagueId: 999 }), /SETTINGS/);
  c.online = false;
  assert.throws(() => c.request("invite", spec), /OFFLINE/);
  c.online = true;
  const sent = invites.length;
  c.snapshot(lobbyWith(ids));
  c.request("start", spec);
  assert.throws(() => c.request("invite", spec), /STATE/);
  assert.equal(invites.length, sent);

  const other = setup(t);
  other.controller.request("create", spec);
  other.controller.snapshot(emptyLobby());
  other.controller.request("release", spec);
  other.later();
  assert.throws(() => other.controller.request("invite", spec), /STATE/);
});

test("the player list shows seats from current members only, and only on request", (t) => {
  const { controller: c } = setup(t);
  c.request("create", spec);
  assert.equal(c.request("status", { ...spec, withPlayers: true }).players, undefined);
  const lobby = lobbyWith([ids[0], ids[5]]);
  // ids[1] waits in the pool; ids[2] left (still in allMembers, not memberIndices).
  lobby.allMembers.push({ id: ids[1], team: 4 }, { id: ids[2], team: 0 });
  lobby.memberIndices = [0, 1, 2, 3];
  c.snapshot(lobby);
  assert.equal(c.request("status", spec).players, undefined);
  const players = c.request("status", { ...spec, withPlayers: true }).players;
  assert.deepEqual(players.slice(0, 3), [
    { id: ids[0], seat: "radiant", invite: "none" },
    { id: ids[1], seat: "unassigned", invite: "none" },
    { id: ids[2], seat: "absent", invite: "sent" },
  ]);
  assert.deepEqual(players[5], { id: ids[5], seat: "dire", invite: "none" });
  assert.equal(players.length, 10);
  // Gone once the lobby is: there is nothing to seat.
  c.request("release", spec);
  c.departed();
  assert.equal(c.request("status", { ...spec, withPlayers: true }).players, undefined);
});

test("the GC's invite answer marks an offline player, and ignores strangers", (t) => {
  const { controller: c, options } = setup(t);
  c.request("create", spec);
  c.snapshot(emptyLobby());
  c.inviteCreated(ids[0], true);
  c.inviteCreated(ids[1], false);
  c.inviteCreated("76561198000000077", true);
  const players = c.request("status", { ...spec, withPlayers: true }).players;
  assert.equal(players[0].invite, "offline");
  assert.equal(players[1].invite, "sent");
  const saved = JSON.parse(readFileSync(options.file, "utf8"));
  assert.equal(saved.jobs[spec.key].invites["76561198000000077"], undefined);
});

test("an untargeted re-invite and the seat report use the request's fresh roster", (t) => {
  const { controller: c, invites, later } = setup(t);
  c.request("create", spec);
  c.snapshot(lobbyWith(ids.slice(0, 9)));
  later();
  // A stand-in booked after create replaces ids[9] in the site's fresh spec.
  const standin = "76561198000000050";
  const fresh = { ...spec, dire: [...ids.slice(5, 9), standin], withPlayers: true };
  const reply = c.request("invite", fresh);
  assert.equal(reply.invited, 1);
  assert.equal(invites.at(-1), standin);
  assert.deepEqual(reply.players.map((p) => p.id), [...ids.slice(0, 9), standin]);
  assert.equal(reply.players.at(-1).seat, "absent");
});

test("a re-invite round is saved before its first invite goes out", (t) => {
  const { controller: c, transport, invites, options, later } = setup(t);
  c.request("create", spec);
  c.snapshot(lobbyWith(ids.slice(0, 9)));
  later();
  // Read the file at send time; assert afterwards (the bot catches a throwing send).
  const onDisk = [];
  transport.invite = (id) => {
    onDisk.push(JSON.parse(readFileSync(options.file, "utf8")).jobs[spec.key].invites[id]);
    invites.push(id);
  };
  assert.equal(c.request("invite", spec).invited, 1);
  assert.deepEqual(onDisk.map((e) => [e.count, e.result]), [[2, "sent"]]);
});

test("no seat report from a foreign lobby or once Dota is setting up the server", (t) => {
  const { controller: c } = setup(t);
  const asked = { ...spec, withPlayers: true };
  c.request("create", spec);
  c.snapshot(emptyLobby({ gameName: "Someone else's lobby" }));
  assert.equal(c.request("status", asked).players, undefined);
  c.snapshot(lobbyWith(ids));
  assert.equal(c.request("status", asked).players.length, 10);
  c.request("start", spec);
  c.snapshot(lobbyWith(ids, { state: 1 }));
  assert.equal(c.request("status", asked).state, "starting");
  assert.equal(c.request("status", asked).players, undefined);
});

// ---- Leaving at the game's end, resyncs and the lifecycle flags ----

const MATCH = "8123456789";
const LOBBY = "123456789012345678";
const nextGame = { ...spec, key: "inhouse:next:1", name: "GGD2L Inhouse next" };
const lifecycle = { ...spec, withLifecycle: true };
const resyncs = (calls) => calls.filter((call) => call === "resync").length;
// Create, start and run a game: the job is started, its lobby at RUN.
function running(c, overrides = {}) {
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(snapshot({ state: 2, matchId: MATCH, ...overrides }));
}
// A clock the test moves by hand.
function clock(c, start = 100) {
  const time = { at: start };
  c.now = () => time.at;
  return time;
}

test("2026-10-18 replayed: a Release on a game the bot still sees running resyncs, and a welcome with no lobby frees it", (t) => {
  const { controller: c, calls, options } = setup(t);
  const time = clock(c);
  running(c);
  // The game ends in Dota, but no postgame or departure reaches the bot: its
  // last snapshot still reads RUN, and every next Create gets BUSY.
  time.at += 63 * 60_000;
  assert.equal(c.tick(), false);
  assert.throws(() => c.request("create", nextGame), /BUSY/);
  assert.deepEqual(calls, ["create", "start"]);
  // Release: no Leave into a running lobby, one resync instead, and the reply
  // says the release is pending (still started, never blocked).
  assert.deepEqual(c.request("release", lifecycle), {
    state: "started",
    lobbyId: LOBBY,
    matchId: MATCH,
    releasing: true,
  });
  assert.deepEqual(calls, ["create", "start", "resync"]);
  // Saved before the GC session cycles.
  const saved = new LobbyController(options).data;
  assert.equal(saved.jobs[spec.key].releasing, true);
  assert.equal(saved.jobs[spec.key].resyncs, 1);
  assert.equal(saved.lastResyncAt, time.at);
  // Between the cycle and its welcome the bot is offline.
  assert.throws(() => c.request("create", nextGame), /OFFLINE/);
  // The welcome is complete and holds no lobby: the claim frees.
  time.at += 3000;
  assert.equal(welcome(c), true);
  assert.equal(c.data.active, null);
  const job = c.data.jobs[spec.key];
  assert.equal(job.departedBy, "welcome");
  assert.equal(job.freedBy, "welcome");
  assert.equal(job.freedAt, time.at);
  // The game keeps its match id for the result, and Create works again.
  assert.deepEqual(c.status(spec.key, lifecycle), { state: "started", lobbyId: LOBBY, matchId: MATCH });
  assert.equal(c.request("create", nextGame).state, "creating");
  assert.deepEqual(calls, ["create", "start", "resync", "create"]);
});

test("a Release on a started game whose lobby the bot can't see resyncs, and the welcome settles it", (t) => {
  const { controller: c, calls } = setup(t);
  running(c);
  // An incomplete welcome: the lobby's cache wasn't resent, absence unproven.
  assert.equal(welcome(c, [], false), false);
  assert.equal(c.lobby, null);
  assert.equal(c.request("release", lifecycle).releasing, true);
  assert.deepEqual(calls, ["create", "start", "resync"]);
  assert.equal(welcome(c), true);
  assert.equal(c.data.active, null);
});

test("a Leave Dota doesn't confirm within 20 s gets exactly one resync", (t) => {
  const { controller: c, calls } = setup(t);
  const time = clock(c);
  running(c);
  const postgame = snapshot({ state: 3, matchId: MATCH, matchOutcome: 2 });
  c.snapshot(postgame);
  assert.deepEqual(calls, ["create", "start", "leave"]);
  const sent = time.at;
  // A repeated postgame resends the Leave without moving its deadline.
  time.at = sent + 10_000;
  c.snapshot(snapshot({ state: 3, matchId: MATCH, matchOutcome: 2, memberIndices: [0, 1] }));
  assert.deepEqual(calls, ["create", "start", "leave", "leave"]);
  time.at = sent + LEAVE_CONFIRM_MS - 1;
  assert.equal(c.tick(), false);
  assert.equal(resyncs(calls), 0);
  time.at = sent + LEAVE_CONFIRM_MS;
  assert.equal(c.tick(), false);
  assert.equal(resyncs(calls), 1);
  assert.equal(c.data.jobs[spec.key].lastResyncAt, time.at);
  // Nothing more while it runs, even with the minute's limit out of the way.
  time.at += 1000;
  c.tick();
  const last = c.data.lastResyncAt;
  c.data.lastResyncAt = time.at - RESYNC_MIN_INTERVAL_MS;
  c.tick();
  c.data.lastResyncAt = last;
  assert.equal(resyncs(calls), 1);
  // Its welcome replays the postgame: the Leave goes again on a fresh clock,
  // and the minute between resyncs holds even past that deadline.
  welcome(c, [postgame]);
  assert.equal(calls.at(-1), "leave");
  time.at += LEAVE_CONFIRM_MS;
  c.tick();
  assert.equal(resyncs(calls), 1);
  // Dota confirms this time: the claim frees, and no resync follows.
  c.departed("unsubscribed");
  assert.equal(c.data.active, null);
  time.at += RESYNC_MIN_INTERVAL_MS;
  c.tick();
  assert.equal(resyncs(calls), 1);
  assert.equal(c.request("create", nextGame).state, "creating");
});

test("resyncs stay one a minute and three a job, and a welcome still showing the game starts no loop", (t) => {
  const { controller: c, calls, logs, options } = setup(t);
  const time = clock(c);
  running(c);
  const stillRunning = snapshot({ state: 2, matchId: MATCH });
  c.request("release", spec);
  assert.equal(resyncs(calls), 1);
  // The welcome replays the running game: no Leave, and no other resync
  // however long the clock runs.
  welcome(c, [stillRunning]);
  for (let i = 0; i < 10; i++) {
    time.at += 30_000;
    c.tick();
  }
  assert.equal(resyncs(calls), 1);
  assert.equal(c.data.jobs[spec.key].releasing, true);
  assert.ok(!calls.includes("leave"));
  // A Release inside the minute waits for it, then gets its resync.
  time.at = c.data.lastResyncAt + RESYNC_MIN_INTERVAL_MS - 1;
  c.data.lastResyncAt = time.at - 1000;
  c.request("release", spec);
  assert.equal(resyncs(calls), 1);
  assert.equal(new LobbyController(options).data.jobs[spec.key].resyncWanted, "release");
  time.at = c.data.lastResyncAt + RESYNC_MIN_INTERVAL_MS;
  c.tick();
  assert.equal(resyncs(calls), 2);
  welcome(c, [stillRunning]);
  time.at += RESYNC_MIN_INTERVAL_MS;
  c.request("release", spec);
  assert.equal(resyncs(calls), MAX_RESYNCS_PER_JOB);
  welcome(c, [stillRunning]);
  // Three for this job: every later Release and clock run sends none, and
  // the bot says so once.
  for (let i = 0; i < 5; i++) {
    time.at += RESYNC_MIN_INTERVAL_MS;
    c.request("release", spec);
    c.tick();
  }
  assert.equal(resyncs(calls), MAX_RESYNCS_PER_JOB);
  assert.equal(logs.filter((line) => line.includes(" leave-not-confirmed ")).length, 1);
  assert.equal(new LobbyController(options).data.jobs[spec.key].resyncs, MAX_RESYNCS_PER_JOB);
  // The game's postgame still settles it.
  c.snapshot(snapshot({ state: 3, matchId: MATCH, matchOutcome: 3 }));
  assert.deepEqual(calls.filter((call) => call === "leave"), ["leave"]);
  c.departed("destroy");
  assert.equal(c.data.active, null);
  assert.equal(c.request("create", nextGame).state, "creating");
});

test("the resync limits survive a restart", (t) => {
  const { controller: c, calls, options } = setup(t);
  const time = clock(c);
  running(c);
  c.request("release", spec);
  assert.equal(resyncs(calls), 1);
  // Restarted inside the minute: its welcome is the check, and a Release then
  // waits out the minute the file remembers.
  const resumed = new LobbyController(options);
  resumed.now = () => time.at;
  welcome(resumed, [snapshot({ state: 2, matchId: MATCH })]);
  time.at += 10_000;
  resumed.request("release", spec);
  assert.equal(resyncs(calls), 1);
  // A job already at three gets none after a restart either.
  resumed.data.jobs[spec.key].resyncs = MAX_RESYNCS_PER_JOB;
  resumed.save();
  const again = new LobbyController(options);
  again.now = () => time.at + RESYNC_MIN_INTERVAL_MS;
  welcome(again, [snapshot({ state: 2, matchId: MATCH })]);
  again.request("release", spec);
  again.tick();
  assert.equal(resyncs(calls), 1);
});

test("no resync while a lobby is set up, its server allocated, or the bot is offline", (t) => {
  // Creating, ready and starting, even with a resync asked for and a Leave
  // deadline long past (a guard: no path sets either there).
  const reach = {
    creating: () => {},
    ready: (c) => c.snapshot(snapshot()),
    starting: (c) => {
      c.snapshot(snapshot());
      c.request("start", spec);
    },
  };
  for (const [state, to] of Object.entries(reach)) {
    const { controller: c, calls } = setup(t);
    const time = clock(c);
    c.request("create", spec);
    to(c);
    const job = c.data.jobs[spec.key];
    assert.equal(job.state, state);
    job.leavePendingAt = 0;
    job.resyncWanted = "release";
    time.at += LEAVE_CONFIRM_MS;
    c.tick();
    assert.equal(c.resync(job, "test"), false, state);
    assert.equal(resyncs(calls), 0, state);
  }
  // A ready lobby being released, its Leave unanswered, whose server Dota
  // then allocates (a player launched it first): no resync until it's back.
  for (const state of [1, 4, 5, 6]) {
    const { controller: c, calls } = setup(t);
    const time = clock(c);
    c.request("create", spec);
    c.snapshot(snapshot());
    c.request("release", spec);
    c.snapshot(snapshot({ state }));
    time.at += 3 * LEAVE_CONFIRM_MS;
    c.tick();
    assert.deepEqual(calls, ["create", "leave"], String(state));
    // Back on the lobby screen it leaves again, and may resync.
    c.snapshot(snapshot());
    c.tick();
    assert.deepEqual(calls, ["create", "leave", "leave", "resync"], String(state));
  }
  // Offline: the reconnect's welcome is the check.
  const { controller: c, calls } = setup(t);
  const time = clock(c);
  running(c);
  c.online = false;
  c.data.jobs[spec.key].releasing = true;
  c.data.jobs[spec.key].resyncWanted = "release";
  time.at += RESYNC_MIN_INTERVAL_MS;
  c.tick();
  assert.equal(resyncs(calls), 0);
  welcome(c, [snapshot({ state: 2, matchId: MATCH })]);
  assert.equal(c.data.jobs[spec.key].resyncWanted, undefined);
  c.tick();
  assert.equal(resyncs(calls), 0);
});

test("a resync and its welcome never send a create or a start", (t) => {
  const { controller: c, calls, options } = setup(t);
  const time = clock(c);
  running(c);
  c.request("release", spec);
  // The welcome finds the game over and back on the lobby screen, its winner
  // named: a played game, left, never relaunched or re-created.
  welcome(c, [snapshot({ state: 0, matchId: MATCH, matchOutcome: 2 })]);
  assert.deepEqual(calls, ["create", "start", "resync", "leave"]);
  assert.equal(c.data.jobs[spec.key].state, "started");
  assert.equal(c.request("create", spec).state, "started");
  assert.throws(() => c.request("start", spec), /STATE/);
  // A restart in the middle of it all sends neither either.
  const resumed = new LobbyController(options);
  resumed.now = () => time.at + RESYNC_MIN_INTERVAL_MS;
  welcome(resumed, [snapshot({ state: 0, matchId: MATCH, matchOutcome: 2 })]);
  assert.deepEqual(calls.filter((call) => ["create", "start"].includes(call)), ["create", "start"]);
});

test("a RUN snapshot never sends a Leave, however the bot came to be in it", (t) => {
  const run = snapshot({ state: 2, matchId: MATCH });
  // Launched by the bot, with or without a release pending.
  for (const releasing of [false, true]) {
    const { controller: c, calls } = setup(t);
    running(c);
    if (releasing) c.request("release", spec);
    c.snapshot(run);
    c.snapshot(snapshot({ state: 2, matchId: MATCH, gameState: 5, matchOutcome: 0 }));
    assert.ok(!calls.includes("leave"), `releasing ${releasing}`);
  }
  // Launched by a player who took the lead after a reconnect.
  {
    const { controller: c, calls } = setup(t);
    c.request("create", spec);
    c.snapshot(snapshot({ leaderId: ids[0] }));
    c.snapshot(snapshot({ leaderId: ids[0], state: 6 }));
    c.snapshot(snapshot({ leaderId: ids[0], state: 2, matchId: MATCH }));
    assert.equal(c.data.jobs[spec.key].state, "started");
    assert.deepEqual(calls, ["create"]);
  }
  // A launch given up too soon that Dota then shows running: the earlier
  // Leave stands, no new one, and its deadline is dropped.
  {
    const { controller: c, calls } = setup(t);
    const time = clock(c);
    c.request("create", spec);
    c.snapshot(snapshot());
    c.request("start", spec);
    time.at += LAUNCH_SETTLE_MS;
    assert.equal(c.tick(), true);
    assert.deepEqual(calls, ["create", "start", "leave"]);
    c.snapshot(run);
    assert.equal(c.data.jobs[spec.key].leavePendingAt, undefined);
    time.at += 10 * LEAVE_CONFIRM_MS;
    c.tick();
    assert.deepEqual(calls, ["create", "start", "leave"]);
  }
  // A finished job's lobby, with no claim, found running.
  {
    const { controller: c, calls } = setup(t);
    running(c);
    assert.equal(welcome(c), true);
    c.snapshot(run);
    assert.deepEqual(calls, ["create", "start"]);
    // ...left at its postgame.
    c.snapshot(snapshot({ state: 3, matchId: MATCH, matchOutcome: 2 }));
    assert.deepEqual(calls, ["create", "start", "leave"]);
  }
});

test("Dota's end of a played game, whichever way it shows, leaves, frees the bot and reads over", (t) => {
  const ends = {
    postgame: { state: 3, matchOutcome: 2 },
    "RUN with a winner": { state: 2, matchOutcome: 3 },
    "RUN at the post-game state": { state: 2, gameState: 6 },
  };
  for (const [path, end] of Object.entries(ends)) {
    const { controller: c, calls } = setup(t);
    running(c);
    assert.equal(c.status(spec.key, lifecycle).over, undefined, path);
    c.snapshot(snapshot({ matchId: MATCH, ...end }));
    assert.deepEqual(calls, ["create", "start", "leave"], path);
    const job = c.data.jobs[spec.key];
    assert.equal(job.leaveReason, "postgame", path);
    assert.equal(job.postgameAt, c.now(), path);
    assert.deepEqual(c.status(spec.key, lifecycle), { state: "started", lobbyId: LOBBY, matchId: MATCH, over: true }, path);
    c.departed("removed");
    assert.equal(c.data.active, null, path);
    // Still over once the bot has gone, so the site can end the game late.
    assert.equal(c.status(spec.key, lifecycle).over, true, path);
    assert.equal(c.request("create", nextGame).state, "creating", path);
  }
});

test("a not-scored end is a failed launch, even at RUN, and never reads over", (t) => {
  for (const end of [{ state: 3, matchOutcome: 67 }, { state: 2, gameState: 6, matchOutcome: 66 }]) {
    const { controller: c, calls } = setup(t);
    running(c);
    assert.equal(c.snapshot(snapshot({ matchId: MATCH, ...end })), true);
    // Its repeat neither undoes the failure nor counts it twice.
    assert.equal(c.snapshot(snapshot({ matchId: MATCH, ...end })), false);
    assert.equal(c.data.jobs[spec.key].launchFailed, true);
    assert.deepEqual(calls, ["create", "start", "leave", "leave"]);
    assert.deepEqual(c.status(spec.key, lifecycle), { state: "blocked", lobbyId: LOBBY, matchId: undefined, releasing: true });
    c.departed("destroy");
    assert.deepEqual(c.status(spec.key, lifecycle), { state: "released", lobbyId: LOBBY, matchId: undefined });
  }
});

test("releasing and over appear only for a request with withLifecycle", (t) => {
  const { controller: c } = setup(t);
  running(c);
  c.request("release", spec);
  assert.deepEqual(c.status(spec.key, spec), { state: "started", lobbyId: LOBBY, matchId: MATCH });
  assert.deepEqual(c.request("status", { ...spec, withLifecycle: "yes" }), { state: "started", lobbyId: LOBBY, matchId: MATCH });
  assert.equal(c.request("status", lifecycle).releasing, true);
  welcome(c, [snapshot({ state: 2, matchId: MATCH })]);
  c.snapshot(snapshot({ state: 3, matchId: MATCH, matchOutcome: 2 }));
  assert.deepEqual(c.request("status", spec), { state: "started", lobbyId: LOBBY, matchId: MATCH });
  assert.deepEqual(c.request("status", lifecycle), { state: "started", lobbyId: LOBBY, matchId: MATCH, releasing: true, over: true });
  // releasing belongs to the bot's active claim: gone with the departure.
  c.departed("destroy");
  assert.deepEqual(c.request("status", lifecycle), { state: "started", lobbyId: LOBBY, matchId: MATCH, over: true });
  // Another key never reads this job's flags.
  assert.deepEqual(c.request("status", { ...nextGame, withLifecycle: true }), { state: "idle" });
  // A ready lobby's release is pending too, and a lobby nobody launched is
  // never over.
  const other = setup(t).controller;
  other.request("create", spec);
  other.snapshot(snapshot());
  other.request("release", spec);
  assert.deepEqual(other.request("status", lifecycle), { state: "ready", lobbyId: LOBBY, matchId: undefined, releasing: true });
});

test("every lifecycle reply passes the relay's reply check", (t) => {
  const { controller: c } = setup(t);
  const asked = { ...lifecycle, withPlayers: true };
  const check = (body, action = "status") =>
    validReply({ id: "00000000-0000-4000-8000-000000000000", status: 200, body: JSON.parse(JSON.stringify(body)) }, action);
  c.request("create", spec);
  c.snapshot(snapshot());
  assert.equal(check(c.request("status", asked)), true);
  c.request("start", spec);
  c.snapshot(snapshot({ state: 2, matchId: MATCH }));
  assert.equal(check(c.request("release", asked), "release"), true);
  welcome(c, [snapshot({ state: 2, matchId: MATCH })]);
  c.snapshot(snapshot({ state: 3, matchId: MATCH, matchOutcome: 2 }));
  const body = c.request("status", asked);
  assert.equal(body.releasing && body.over, true);
  assert.equal(check(body), true);
  assert.equal(check(c.request("create", asked), "create"), true);
});

test("a started game with no end seen three hours after Start gets one resync", (t) => {
  const { controller: c, calls, options } = setup(t);
  const time = clock(c);
  running(c);
  const start = c.data.jobs[spec.key].changedAt;
  time.at = start + STARTED_BACKSTOP_MS - 1;
  c.tick();
  assert.equal(resyncs(calls), 0);
  time.at = start + STARTED_BACKSTOP_MS;
  c.tick();
  assert.equal(resyncs(calls), 1);
  assert.equal(new LobbyController(options).data.jobs[spec.key].backstopAt, time.at);
  // Its welcome still shows the game running: never again for this job.
  welcome(c, [snapshot({ state: 2, matchId: MATCH })]);
  for (let i = 0; i < 4; i++) {
    time.at += 60 * 60_000;
    c.tick();
  }
  assert.equal(resyncs(calls), 1);
  assert.equal(c.data.active, spec.key);
  // One whose welcome finds no lobby frees the bot.
  const other = setup(t);
  const otherTime = clock(other.controller);
  running(other.controller);
  otherTime.at += STARTED_BACKSTOP_MS;
  other.controller.tick();
  assert.equal(resyncs(other.calls), 1);
  assert.equal(welcome(other.controller), true);
  assert.equal(other.controller.data.active, null);
  // A game whose end the bot saw has the Leave's clock instead.
  const ended = setup(t);
  const endedTime = clock(ended.controller);
  running(ended.controller);
  ended.controller.snapshot(snapshot({ state: 3, matchId: MATCH, matchOutcome: 2 }));
  endedTime.at += STARTED_BACKSTOP_MS;
  ended.controller.tick();
  assert.equal(ended.controller.resyncing.reason, "leave-unconfirmed");
});

test("an orphan Leave Dota doesn't confirm resyncs too", (t) => {
  const { controller: c, calls } = setup(t);
  const time = clock(c);
  running(c);
  assert.equal(welcome(c), true);
  // The freed game's lobby turns up at its postgame: left, and unconfirmed.
  c.snapshot(snapshot({ state: 3, matchId: MATCH, matchOutcome: 2 }));
  assert.deepEqual(calls, ["create", "start", "leave"]);
  assert.throws(() => c.request("create", nextGame), /BUSY/);
  time.at += LEAVE_CONFIRM_MS;
  c.tick();
  assert.deepEqual(calls, ["create", "start", "leave", "resync"]);
  // The welcome finds no lobby: the orphan's departure, and Create works.
  welcome(c);
  assert.equal(c.data.jobs[spec.key].departedBy, "welcome");
  assert.equal(c.data.jobs[spec.key].leavePendingAt, undefined);
  assert.equal(c.request("create", nextGame).state, "creating");
});

test("a welcome that replays the lobby restarts the Leave's deadline from the Leave it sends again", (t) => {
  const { controller: c, calls } = setup(t);
  const time = clock(c);
  running(c);
  const postgame = snapshot({ state: 3, matchId: MATCH, matchOutcome: 2 });
  c.snapshot(postgame);
  const sent = time.at;
  // A reconnect 15 s later still shows the postgame: the bot leaves again,
  // and that Leave gets its own 20 s.
  time.at = sent + 15_000;
  c.online = false;
  welcome(c, [postgame]);
  assert.deepEqual(calls, ["create", "start", "leave", "leave"]);
  time.at = sent + LEAVE_CONFIRM_MS;
  c.tick();
  assert.equal(resyncs(calls), 0);
  time.at = sent + 15_000 + LEAVE_CONFIRM_MS;
  c.tick();
  assert.equal(resyncs(calls), 1);
});

test("an incomplete welcome keeps an unconfirmed Leave on its old deadline", (t) => {
  const { controller: c, calls } = setup(t);
  const time = clock(c);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("release", spec);
  const sent = c.data.jobs[spec.key].leavePendingAt;
  time.at += 5000;
  assert.equal(welcome(c, [], false), false);
  assert.equal(c.data.jobs[spec.key].leavePendingAt, sent);
  time.at = sent + LEAVE_CONFIRM_MS;
  c.tick();
  assert.deepEqual(calls, ["create", "leave", "resync"]);
  // The resync's welcome is complete: the released lobby is gone.
  assert.equal(welcome(c), true);
  assert.equal(c.status(spec.key).state, "released");
});

test("status() never writes; the clock saves an unconfirmed create or launch as blocked", (t) => {
  const { controller: c, options } = setup(t);
  const time = clock(c);
  c.request("create", spec);
  let saves = 0;
  const save = c.save.bind(c);
  c.save = () => {
    saves += 1;
    save();
  };
  time.at += 31_000;
  assert.equal(c.status(spec.key).state, "blocked");
  assert.equal(c.request("status", { ...spec, withPlayers: true, withLifecycle: true }).state, "blocked");
  assert.equal(saves, 0);
  assert.equal(new LobbyController(options).data.jobs[spec.key].state, "creating");
  assert.equal(c.tick(), false);
  assert.equal(new LobbyController(options).data.jobs[spec.key].state, "blocked");
});

test("each answer is logged, a read only when it changes, a BUSY with the claim that holds the bot", (t) => {
  const { controller: c, logs } = setup(t);
  running(c);
  const requests = () => logs.filter((line) => line.includes(" request "));
  const before = requests().length;
  c.handle("status", spec);
  c.handle("status", spec);
  c.handle("status", spec);
  assert.equal(requests().length, before + 1);
  assert.throws(() => c.handle("create", nextGame), /BUSY/);
  assert.match(requests().at(-1), / request action=create key=inhouse:next:1 code=BUSY activeKey=season:fixture:1 activeState=started releasing=false lobbyState=2 ms=0$/);
  assert.throws(() => c.handle("start", { ...spec, key: "not a key" }), /INVALID/);
  assert.match(requests().at(-1), / request action=start key=none code=INVALID ms=0$/);
  c.handle("release", lifecycle);
  assert.match(requests().at(-1), / request action=release key=season:fixture:1 result=started releasing=true ms=0$/);
  // A status read whose answer changed is logged again.
  c.handle("status", lifecycle);
  assert.match(requests().at(-1), /action=status key=season:fixture:1 result=started releasing=true/);
  // Health reads (server.mjs) are logged the same way: once per answer.
  const count = requests().length;
  for (let i = 0; i < 3; i++) c.logAnswer("health", null, { result: "online", activeKey: spec.key, lobbyId: LOBBY }, c.now());
  assert.equal(requests().length, count + 1);
  assert.match(requests().at(-1), / request action=health key=none result=online activeKey=season:fixture:1 lobbyId=123456789012345678 ms=0$/);
});

test("the log carries timestamps and never a lobby's name, password or anyone's Steam ID", (t) => {
  const { controller: c, logs, later } = setup(t);
  // A whole night: invites, a failed launch, a retry, a game, a stuck end, a
  // release and its resync, a BUSY, a refused invite.
  c.handle("create", spec);
  c.snapshot(lobbyWith(ids.slice(0, 2)));
  later();
  c.handle("invite", { ...spec, withPlayers: true });
  c.inviteCreated(ids[3], true);
  c.snapshot(snapshot());
  c.handle("start", spec);
  c.snapshot(snapshot({ state: 6 }));
  c.snapshot(snapshot({ state: 0, matchId: MATCH, matchOutcome: 67 }));
  c.departed("destroy");
  c.handle("create", spec);
  c.snapshot(snapshot());
  c.handle("start", spec);
  c.snapshot(snapshot({ state: 2, matchId: "8123456790" }));
  assert.throws(() => c.handle("create", nextGame), /BUSY/);
  assert.throws(() => c.handle("invite", { ...spec, invite: [ids[0]] }), /STATE/);
  c.handle("release", lifecycle);
  welcome(c, [snapshot({ state: 3, matchId: "8123456790", matchOutcome: 2 })]);
  c.snapshot(snapshot({ state: 3, matchId: "8123456790", matchOutcome: 2, gameName: "Someone else's lobby" }));
  c.departed("unsubscribed");
  c.handle("status", lifecycle);
  assert.ok(logs.length > 20);
  const text = logs.join("\n");
  for (const secret of [spec.password, spec.name, nextGame.name, "Someone else", bot, ...ids])
    assert.ok(!text.includes(secret), secret);
  for (const line of logs)
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[dota-bot\] [a-z-]+( [a-zA-Z]+=[^ ]+)*$/);
  for (const event of ["create-sent", "start-sent", "lobby", "job", "leave-sent", "departed", "claim-freed", "resync", "resync-done", "welcome", "release-pending", "invites-sent", "request"])
    assert.ok(logs.some((line) => line.includes(` [dota-bot] ${event} `) || line.endsWith(` [dota-bot] ${event}`)), event);
});
