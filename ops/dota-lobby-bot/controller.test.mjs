import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "ld2l-bot-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const transport = {
    steamId: () => bot,
    create: () => calls.push("create"),
    start: () => calls.push("start"),
    leave: () => calls.push("leave"),
    removeBotFromTeam: () => calls.push("kick"),
  };
  let now = 100;
  const options = { file: join(dir, "state.json"), transport, now: () => now };
  const controller = new LobbyController(options);
  controller.online = true;
  // Equivalent to a full GC welcome confirming an empty account cache.
  controller.absenceConfirmed = true;
  return {
    controller,
    calls,
    options,
    later: () => {
      now += 31_000;
    },
  };
}
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
  // Confirmed running games can safely shed their nonplaying lobby bot.
  resumed.snapshot(snapshot({ state: 2, matchId: "8123456789" }));
  resumed.request("release", spec);
  assert.deepEqual(calls, ["create", "start", "leave"]);
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
