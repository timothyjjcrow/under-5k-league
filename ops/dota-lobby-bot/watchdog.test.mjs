import { test } from "node:test";
import assert from "node:assert/strict";
import { offlineWatchdog } from "./watchdog.mjs";

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
