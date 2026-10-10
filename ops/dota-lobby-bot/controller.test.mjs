import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobbyController, rosterMatches, validSpec } from "./controller.mjs";

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
    removeBotFromTeam: () => calls.push("kick"),
    invite: (id) => invites.push(id),
  };
  let now = 100;
  const options = { file: join(dir, "state.json"), transport, now: () => now, ...configuration };
  const controller = new LobbyController(options);
  controller.online = true;
  // Equivalent to a full GC welcome confirming an empty account cache.
  controller.absenceConfirmed = true;
  return {
    controller,
    calls,
    invites,
    transport,
    options,
    later: () => {
      now += 31_000;
    },
  };
}
// What server.mjs does with a GC welcome: forget the lobby, replay the caches
// it resent in full, then settle. `complete` is false when it left some unsent.
function welcome(c, lobbies = [], complete = true) {
  c.lobby = null;
  for (const lobby of lobbies) c.snapshot(lobby);
  return c.welcomed(complete);
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
  assert.deepEqual(calls, ["create", "start", "leave"]);
});
test("a launched game sheds the bot once Dota gives it a match id", (t) => {
  const { controller: c, calls } = setup(t);
  const next = { ...spec, key: "inhouse:next:1", name: "GGD2L Inhouse next" };
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  // Running with no match id yet: stay until there is one to report.
  c.snapshot(snapshot({ state: 2 }));
  c.snapshot(snapshot({ state: 2, matchId: "0" }));
  assert.deepEqual(calls, ["create", "start"]);
  c.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  assert.deepEqual(calls, ["create", "start", "leave"]);
  // The claim holds until Dota confirms the departure.
  assert.throws(() => c.request("create", next), /BUSY/);
  c.departed();
  // The site still reads the game's match id after the bot has gone.
  assert.deepEqual(c.status(spec.key), {
    state: "started",
    lobbyId: "123456789012345678",
    matchId: "8123456789",
  });
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
  assert.deepEqual(calls, ["create", "start", "leave"]);
  // The GC drops before it confirms the departure. A welcome that left a
  // cache unsent proves nothing, so the claim holds.
  c.online = false;
  assert.equal(welcome(c, [], false), false);
  c.online = true;
  assert.throws(() => c.request("create", next), /BUSY/);
  // A full welcome holding no lobby is the departure the drop swallowed.
  assert.equal(welcome(c), true);
  assert.equal(c.data.active, null);
  assert.deepEqual(c.status(spec.key), {
    state: "started",
    lobbyId: "123456789012345678",
    matchId: "8123456789",
  });
  assert.equal(c.request("create", next).state, "creating");
  assert.deepEqual(calls, ["create", "start", "leave", "create"]);
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
  assert.deepEqual(calls, ["create", "start", "leave", "create"]);
});
test("a reconnect still inside the launched game's lobby leaves it again", (t) => {
  const { controller: c, calls } = setup(t);
  const running = snapshot({ state: 2, matchId: "8123456789" });
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("start", spec);
  c.snapshot(running);
  // The Leave itself was lost: the welcome replays the running lobby.
  assert.equal(welcome(c, [running]), false);
  assert.deepEqual(calls, ["create", "start", "leave", "leave"]);
  assert.equal(c.data.active, spec.key);
  assert.throws(() => c.request("create", { ...spec, key: "inhouse:next:1" }), /BUSY/);
});
test("a reconnect never frees an unlaunched or ambiguous claim", (t) => {
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
test("server.mjs settles every GC welcome through the controller", () => {
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const start = server.indexOf("k_EMsgGCClientWelcome,");
  assert.ok(start > 0);
  const handler = server.slice(start, server.indexOf("\n});", start));
  assert.match(handler, /controller\.welcomed\(/);
  assert.doesNotMatch(handler, /absenceConfirmed\s*=/);
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
  // Confirmed running games shed their nonplaying lobby bot on their own, and
  // a captain's release then is a harmless repeat.
  resumed.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  assert.deepEqual(calls, ["create", "start", "leave"]);
  resumed.request("release", spec);
  assert.deepEqual(calls, ["create", "start", "leave", "leave"]);
});
test("pending release retries wait through GC allocation states", (t) => {
  const { controller: c, calls } = setup(t);
  c.request("create", spec);
  c.snapshot(snapshot());
  c.request("release", spec);
  for (const state of [1, 4, 5, 6]) c.snapshot(snapshot({ state }));
  assert.deepEqual(calls, ["create", "leave"]);
  c.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
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
