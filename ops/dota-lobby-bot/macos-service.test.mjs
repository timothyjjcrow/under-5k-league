import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LABEL, renderLaunchAgent, serviceArguments, serviceInstance, assertInstanceIsolation, waitForUnload,
} from "./macos-service.mjs";

test("default service identity stays unchanged and Europe is independent", () => {
  assert.deepEqual(serviceInstance(), { label: LABEL, envFile: ".env" });
  assert.deepEqual(serviceInstance("eu"), { label: `${LABEL}.eu`, envFile: ".env.eu" });
  assert.deepEqual(serviceArguments(["install", "--instance", "eu", "--keep-awake"]), {
    command: "install", instance: "eu", keepAwake: true,
  });
  assert.deepEqual(serviceArguments(["stop", "--instance", "eu"]), {
    command: "stop", instance: "eu", keepAwake: false,
  });
});

test("instance options cannot escape filenames or silently target the US service", () => {
  for (const args of [["stop", "--instance"], ["stop", "--instance", "../eu"],
    ["stop", "--instance", ""], ["stop", "--keep-awake"],
    ["stop", "--instance", "eu", "--instance", "us"]])
    assert.throws(() => serviceArguments(args));
});

test("European LaunchAgent points only to its own settings and logs", () => {
  const plist = renderLaunchAgent({
    nodePath: "/node", directory: "/bot", envPath: "/bot/.env.eu",
    logDir: "/bot/state/eu/logs", label: `${LABEL}.eu`, keepAwake: true,
  });
  assert.match(plist, /com\.ggd2l\.dota-lobby-bot\.eu/);
  assert.match(plist, /--env-file=\/bot\/\.env\.eu/);
  assert.match(plist, /\/bot\/state\/eu\/logs\/stdout\.log/);
  assert.match(plist, /\/usr\/bin\/caffeinate/);
  assert.doesNotMatch(plist, /<string>--env-file=\/bot\/\.env<\/string>/);
});

test("customized US and EU state paths and ports cannot collide", () => {
  const us = { DOTA_BOT_STATE_DIR: "./state/us", PORT: "8091" };
  assert.throws(() => assertInstanceIsolation(
    { DOTA_BOT_STATE_DIR: "./state/us", PORT: "8092" }, [us], "/bot",
  ), /separate DOTA_BOT_STATE_DIR/);
  assert.throws(() => assertInstanceIsolation(
    { DOTA_BOT_STATE_DIR: "./state/eu/../us", PORT: "8092" }, [us], "/bot",
  ), /separate DOTA_BOT_STATE_DIR/);
  assert.throws(() => assertInstanceIsolation(
    { DOTA_BOT_STATE_DIR: "./state/eu", PORT: "8091" }, [us], "/bot",
  ), /separate PORT/);
  assert.doesNotThrow(() => assertInstanceIsolation(
    { DOTA_BOT_STATE_DIR: "./state/eu", PORT: "8092" }, [us], "/bot",
  ));
});

// Sleeping advances the clock, so the tests never wait in real time.
function virtualClock() {
  let time = 0;
  return { now: () => time, sleep: (milliseconds) => { time += milliseconds; } };
}

test("stop returns at once when launchd has already unloaded the service", () => {
  const clock = virtualClock();
  let probes = 0;
  waitForUnload({ probe: () => { probes += 1; return false; }, ...clock });
  assert.equal(probes, 1);
  assert.equal(clock.now(), 0);
});

test("stop waits while launchd is still tearing the service down", () => {
  const clock = virtualClock();
  let probes = 0;
  waitForUnload({ probe: () => (probes += 1) <= 3, ...clock });
  assert.equal(probes, 4);
  assert.equal(clock.now(), 750);
});

test("stop gives up with a clear error only after launchd's own kill deadline", () => {
  const exitTimeOut = Number(renderLaunchAgent({
    nodePath: "/node", directory: "/bot", envPath: "/bot/.env", logDir: "/bot/state/logs",
  }).match(/<key>ExitTimeOut<\/key><integer>(\d+)<\/integer>/)[1]);
  const clock = virtualClock();
  let probes = 0;
  const probe = () => {
    probes += 1;
    if (probes > 1000) assert.fail("the wait never gave up");
    return true;
  };
  assert.throws(() => waitForUnload({ probe, ...clock }), {
    message: 'The Mac service did not unload within 20 seconds. Run status until it shows "Loaded: no", then run this command again.',
  });
  assert.equal(clock.now(), 20_000);
  assert.ok(clock.now() > exitTimeOut * 1000);
});

test("stop and uninstall wait for the unload after bootout", () => {
  const source = readFileSync(new URL("./macos-service.mjs", import.meta.url), "utf8");
  assert.match(source, /launchctl\(\["bootout", service\]\);\s+waitForUnload\(\{ probe: isLoaded,/);
});
