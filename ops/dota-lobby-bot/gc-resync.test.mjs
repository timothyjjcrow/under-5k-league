import { test } from "node:test";
import assert from "node:assert/strict";
import SteamUser from "steam-user";
import { Dota2User } from "dota2-user";
import { gcResync, RESYNC_RELAUNCH_MS, RESYNC_WELCOME_MS } from "./gc-resync.mjs";

function fakeUser() {
  const played = [];
  return { played, gamesPlayed: (apps, force) => played.push([apps, force]) };
}

test("a resync quits Dota, launches it again two seconds later, and waits 30 s for a welcome", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const user = fakeUser();
  let exits = 0;
  const resync = gcResync({ user, noWelcome: () => (exits += 1) });
  resync.start();
  assert.deepEqual(user.played, [[[], undefined]]);
  t.mock.timers.tick(RESYNC_RELAUNCH_MS - 1);
  assert.equal(user.played.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(user.played, [[[], undefined], [[570], false]]);
  // Its welcome ends the countdown.
  resync.welcomed();
  t.mock.timers.tick(RESYNC_WELCOME_MS);
  assert.equal(exits, 0);
});

test("no welcome within 30 s of a resync asks for a restart, once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const user = fakeUser();
  let exits = 0;
  const resync = gcResync({ user, noWelcome: () => (exits += 1) });
  resync.start();
  t.mock.timers.tick(RESYNC_WELCOME_MS - 1);
  assert.equal(exits, 0);
  t.mock.timers.tick(1);
  assert.equal(exits, 1);
  t.mock.timers.tick(10 * RESYNC_WELCOME_MS);
  assert.equal(exits, 1);
  // A second resync restarts the countdown rather than stacking one.
  resync.start();
  t.mock.timers.tick(RESYNC_WELCOME_MS / 2);
  resync.start();
  t.mock.timers.tick(RESYNC_WELCOME_MS - 1);
  assert.equal(exits, 1);
  t.mock.timers.tick(1);
  assert.equal(exits, 2);
});

test("a throwing quit still leaves the restart countdown armed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let exits = 0;
  const resync = gcResync({
    user: { gamesPlayed: () => { throw new Error("not logged on"); } },
    noWelcome: () => (exits += 1),
  });
  assert.throws(() => resync.start());
  t.mock.timers.tick(RESYNC_WELCOME_MS);
  assert.equal(exits, 1);
});

test("a deliberate Steam stop keeps Dota closed and never asks for a restart", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const user = fakeUser();
  let stopped = false;
  let exits = 0;
  const resync = gcResync({ user, stopped: () => stopped, noWelcome: () => (exits += 1) });
  resync.start();
  stopped = true;
  t.mock.timers.tick(RESYNC_RELAUNCH_MS);
  assert.deepEqual(user.played, [[[], undefined]]);
  // The stop's own welcome never comes (server.mjs ignores one once
  // stopped): the deadline passes without an exit, which needs an operator.
  t.mock.timers.tick(RESYNC_WELCOME_MS);
  assert.equal(exits, 0);
  // Stopped after the relaunch, too.
  stopped = false;
  resync.start();
  t.mock.timers.tick(RESYNC_RELAUNCH_MS);
  stopped = true;
  t.mock.timers.tick(RESYNC_WELCOME_MS);
  assert.equal(exits, 0);
});

test("the installed adapters drop the GC session on the quit and say hello again on the launch", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const user = new SteamUser({ dataDirectory: null });
  const dota = new Dota2User(user);
  user.steamID = { getSteamID64: () => "76561198000000099" };
  const sent = [];
  user.sendToGC = (appid, type) => sent.push([appid, type]);
  // steam-user's own Steam message: nothing goes out unconnected in a test.
  user._send = () => {};
  const resync = gcResync({ user, noWelcome: () => {} });
  // As connected: Dota "launched", with a GC session.
  user.gamesPlayed([570], false);
  dota._haveGCSession = true;
  dota._clearHelloTimer();
  let disconnects = 0;
  dota.on("disconnectedFromGC", () => (disconnects += 1));
  resync.start();
  assert.equal(dota.haveGCSession, false);
  assert.equal(dota.inDota2, false);
  // The quit is silent: server.mjs's disconnect handler never sees it.
  assert.equal(disconnects, 0);
  t.mock.timers.tick(RESYNC_RELAUNCH_MS);
  assert.equal(dota.inDota2, true);
  // dota2-user's first hello, 500 ms after the launch: ClientHello (4006).
  t.mock.timers.tick(500);
  assert.deepEqual(sent, [[570, 4006]]);
  dota._clearHelloTimer();
});
