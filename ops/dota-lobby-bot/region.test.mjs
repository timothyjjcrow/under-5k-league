import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerRegion } from "dota2-user/enums/ServerRegion.js";
import { gameServerRegion, gameServerRegions } from "./region.mjs";

test("configured regions match the installed Dota protocol", () => {
  assert.equal(gameServerRegion(), ServerRegion.USEast);
  assert.equal(gameServerRegion("2"), ServerRegion.USEast);
  assert.equal(gameServerRegion("3"), ServerRegion.Europe);
});

test("wrong or partial region settings fail before Steam login", () => {
  for (const value of ["", "1", "0", "3.0", "3x", "03", " 3", "Europe", null, 3])
    assert.throws(() => gameServerRegion(value), /DOTA_GAME_SERVER_REGION/);
});

test("sharing requires an explicit bounded region allowlist", () => {
  assert.deepEqual(gameServerRegions(), [2]);
  assert.deepEqual(gameServerRegions(undefined, "3"), [3]);
  assert.deepEqual(gameServerRegions("2,3", "2"), [2, 3]);
  assert.deepEqual(gameServerRegions("3,2"), [3, 2]);
  assert.deepEqual(gameServerRegions("3"), [3]);
  for (const value of ["", "1,2,3", "2,2", "3,3", "2, 3", "*", "all", "2,3,", [2, 3], 3, null])
    assert.throws(() => gameServerRegions(value), /DOTA_GAME_SERVER_REGIONS/);
});
