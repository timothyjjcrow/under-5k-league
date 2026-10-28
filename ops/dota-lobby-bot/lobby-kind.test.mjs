import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KEY_PATTERN as RELAY_KEY_PATTERN } from "../dota-lobby-relay/src/protocol.mjs";
import { KEY_PATTERN, earlyLeaveKinds, gameModeFor, keyKind, sideSize } from "./lobby-kind.mjs";

test("the bot and the relay accept exactly the same job keys", () => {
  assert.equal(KEY_PATTERN.source, RELAY_KEY_PATTERN.source);
  // No other copy of the pattern in the bot.
  for (const file of ["controller.mjs", "seat-help.mjs", "server.mjs"])
    assert.doesNotMatch(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"), /season\|inhouse/);
});

test("a key's kind, side size and game mode", () => {
  for (const [key, kind] of [
    ["season:fixture:1", "season"],
    ["inhouse:clx:1", "inhouse"],
    ["eu:inhouse:clx:1", "inhouse"],
    ["duel:clx:1", "duel"],
    ["eu:duel:clx:1", "duel"],
  ]) {
    assert.equal(keyKind(key), kind, key);
    assert.equal(sideSize(key), kind === "duel" ? 1 : 5, key);
    assert.equal(gameModeFor(key), kind === "duel" ? 21 : 2, key);
  }
  for (const key of ["duel:clx", "duels:clx:1", "us:duel:clx:1", "duel:clx:0", undefined, 7])
    assert.equal(keyKind(key), null, String(key));
});

test("DOTA_BOT_EARLY_LEAVE is off unless it lists kinds, and an unknown kind stops startup", () => {
  assert.deepEqual(earlyLeaveKinds(undefined), []);
  assert.deepEqual(earlyLeaveKinds(""), []);
  assert.deepEqual(earlyLeaveKinds(" , "), []);
  assert.deepEqual(earlyLeaveKinds("duel"), ["duel"]);
  assert.deepEqual(earlyLeaveKinds("duel, inhouse,season"), ["duel", "inhouse", "season"]);
  assert.ok(Object.isFrozen(earlyLeaveKinds("duel")));
  for (const bad of ["1", "0", "true", "on", "duel,duel", "duels", "Duel", "all"])
    assert.throws(() => earlyLeaveKinds(bad), /Unsupported/, bad);
});
