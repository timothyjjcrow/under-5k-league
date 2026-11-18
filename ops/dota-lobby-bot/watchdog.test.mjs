import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { offlineWatchdog, signInWatchdog, SIGN_IN_RESTART_MS } from "./watchdog.mjs";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("exits once a bot that was online stays offline past the limit", () => {
  const c = clock();
  const check = offlineWatchdog({ limitMs: 1000, now: c.now });
  assert.equal(check({ online: true, stopped: false }), false);
  assert.equal(check({ online: false, stopped: false }), false);
  c.advance(999);
  assert.equal(check({ online: false, stopped: false }), false);
  c.advance(1);
  assert.equal(check({ online: false, stopped: false }), true);
});

test("a reconnect inside the limit resets the offline clock", () => {
  const c = clock();
  const check = offlineWatchdog({ limitMs: 1000, now: c.now });
  check({ online: true, stopped: false });
  check({ online: false, stopped: false });
  c.advance(900);
  assert.equal(check({ online: true, stopped: false }), false);
  check({ online: false, stopped: false });
  c.advance(900);
  assert.equal(check({ online: false, stopped: false }), false);
});

test("never exits before the first successful connection", () => {
  const c = clock();
  const check = offlineWatchdog({ limitMs: 1000, now: c.now });
  check({ online: false, stopped: false });
  c.advance(60_000);
  assert.equal(check({ online: false, stopped: false }), false);
});

test("never exits after a deliberate stop", () => {
  const c = clock();
  const check = offlineWatchdog({ limitMs: 1000, now: c.now });
  check({ online: true, stopped: false });
  check({ online: false, stopped: true });
  c.advance(60_000);
  assert.equal(check({ online: false, stopped: true }), false);
});

// The startup rule (signInWatchdog). `idle` is a fresh process with no Steam
// session yet: the 2026-11-17 wedge looked like this for 14.6 hours.
const idle = { online: false, signedIn: false, stopped: false, needsOperator: false };

test("a process that never signs in to Steam exits at the limit, counted from its start", () => {
  const c = clock();
  const check = signInWatchdog({ limitMs: 1000, now: c.now });
  c.advance(30);
  assert.equal(check(idle), false);
  c.advance(969);
  assert.equal(check(idle), false);
  c.advance(1);
  assert.equal(check(idle), true);
});

test("the startup limit outlasts a slow sign-in through Steam's weekly maintenance", () => {
  // 2026-11-10: about 9 minutes from the restart to signed in.
  assert.ok(SIGN_IN_RESTART_MS >= 10 * 60_000);
  assert.ok(SIGN_IN_RESTART_MS <= 20 * 60_000);
  const c = clock();
  const check = signInWatchdog({ now: c.now });
  c.advance(9 * 60_000);
  assert.equal(check(idle), false);
  assert.equal(check({ ...idle, signedIn: true }), false);
  c.advance(60_000);
  assert.equal(check({ ...idle, online: true, signedIn: true }), false);
});

test("signed in to Steam and waiting for the Game Coordinator never exits", () => {
  const c = clock();
  const check = signInWatchdog({ limitMs: 1000, now: c.now });
  assert.equal(check({ ...idle, signedIn: true }), false);
  c.advance(60_000);
  assert.equal(check({ ...idle, signedIn: true }), false);
});

test("a Steam drop before the first welcome restarts the clock from the drop", () => {
  const c = clock();
  const check = signInWatchdog({ limitMs: 1000, now: c.now });
  c.advance(500);
  assert.equal(check({ ...idle, signedIn: true }), false);
  c.advance(500);
  assert.equal(check(idle), false);
  c.advance(999);
  assert.equal(check(idle), false);
  c.advance(1);
  assert.equal(check(idle), true);
});

test("a Steam error or Steam Guard prompt never restarts, for the life of the process", () => {
  const c = clock();
  const check = signInWatchdog({ limitMs: 1000, now: c.now });
  assert.equal(check({ ...idle, needsOperator: true }), false);
  c.advance(60_000);
  assert.equal(check({ ...idle, needsOperator: true }), false);
  // Latched: later reports without it still never exit, however long.
  assert.equal(check(idle), false);
  c.advance(60_000);
  assert.equal(check(idle), false);
});

test("a deliberate stop never restarts", () => {
  const c = clock();
  const check = signInWatchdog({ limitMs: 1000, now: c.now });
  c.advance(60_000);
  assert.equal(check({ ...idle, stopped: true }), false);
});

test("once online, the startup rule never answers again", () => {
  const c = clock();
  const check = signInWatchdog({ limitMs: 1000, now: c.now });
  assert.equal(check({ ...idle, online: true, signedIn: true }), false);
  c.advance(60_000);
  assert.equal(check(idle), false);
  c.advance(60_000);
  assert.equal(check(idle), false);
});

// server.mjs feeds the startup rule from steam-user's own events.
function handlerOf(server, event) {
  const start = server.indexOf(`user.on("${event}", `);
  assert.ok(start > 0, event);
  return server.slice(start, server.indexOf("\n});", start));
}

test("server.mjs tracks the Steam session and the operator signals the startup rule reads", () => {
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  // Signed in only from loggedOn until a disconnect or an error.
  assert.match(handlerOf(server, "loggedOn"), /^user\.on\("loggedOn", \(\) => \{\n  steamSignedIn = true;/);
  assert.match(handlerOf(server, "disconnected"), /steamSignedIn = false;/);
  assert.match(handlerOf(server, "error"), /steamSignedIn = false;/);
  // An error or a Steam Guard prompt (either branch) needs an operator.
  assert.match(handlerOf(server, "error"), /steamNeedsOperator = true;/);
  assert.match(handlerOf(server, "steamGuard"), /^user\.on\("steamGuard", [^\n]*\n  steamNeedsOperator = true;\n  if \(!process\.stdin\.isTTY\)/);
  assert.equal(server.match(/steamSignedIn = true/g).length, 1);
  assert.equal(server.match(/steamNeedsOperator = true/g).length, 2);
});

test("server.mjs checks the startup rule every 30 s and exits through exitForRestart", () => {
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const start = server.indexOf("const neverSignedIn = signInWatchdog();");
  assert.ok(start > 0);
  const check = server.slice(start, server.indexOf("}, 30_000).unref();", start));
  assert.match(check, /online: controller\.online,\n\s*signedIn: steamSignedIn,\n\s*stopped: steamStopped,\n\s*needsOperator: steamNeedsOperator,/);
  assert.match(check, /warn\(`\[dota-bot\] Not signed in to Steam for \$\{SIGN_IN_RESTART_MS \/ 60_000\} minutes and never connected; exiting so the service restarts\.`\);\n\s*exitForRestart\(\);/);
  // The after-online rule is still wired as it was.
  assert.match(server, /const offlineTooLong = offlineWatchdog\(\);\nsetInterval\(\(\) => \{\n  if \(!offlineTooLong\(\{ online: controller\.online, stopped: steamStopped \}\)\) return;/);
});
