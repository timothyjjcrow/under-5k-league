import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lobbyHealth } from "./health.mjs";
import { validReply } from "../dota-lobby-relay/src/protocol.mjs";

test("bot health passes the relay whitelist before login and with a live regional lobby", () => {
  for (const region of [2, 3]) {
    const controller = { online: false, serverRegion: region, data: { active: null }, lobby: null };
    const offline = lobbyHealth(controller);
    assert.equal(validReply({ id: randomUUID(), status: 200, body: offline }, "health"), true);
    controller.online = true;
    controller.data.active = "inhouse:eu-fixture:1";
    controller.lobby = { lobbyId: "12345", gameMode: 2, serverRegion: region, leagueid: 12345 };
    const online = lobbyHealth(controller, "76561198000000001");
    assert.equal(online.serverRegion, region);
    assert.equal(validReply({ id: randomUUID(), status: 200, body: online }, "health"), true);
    assert.equal(validReply({ id: randomUUID(), status: 200, body: { ...online, configuredServerRegion: region } }, "health"), false);
  }
});
