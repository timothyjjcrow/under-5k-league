import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL, renderLaunchAgent, serviceArguments, serviceInstance, assertInstanceIsolation } from "./macos-service.mjs";

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
