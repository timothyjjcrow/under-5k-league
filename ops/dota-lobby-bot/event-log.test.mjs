import { test } from "node:test";
import assert from "node:assert/strict";
import { eventLog, formatEvent, gcMessageEvent, stamp } from "./event-log.mjs";

const at = new Date("2026-10-18T02:10:43.277Z");

test("an event line is an ISO time, the bot's tag, the event and its fields", () => {
  assert.equal(
    formatEvent("leave-sent", { key: "inhouse:cmvd6ni8600g25yfe3etw52ut:1", reason: "postgame", lobbyState: 3 }, at),
    "2026-10-18T02:10:43.277Z [dota-bot] leave-sent key=inhouse:cmvd6ni8600g25yfe3etw52ut:1 reason=postgame lobbyState=3",
  );
  assert.equal(formatEvent("welcome", { complete: true, lobby: false, key: null }, at),
    "2026-10-18T02:10:43.277Z [dota-bot] welcome complete=true lobby=false key=none");
  assert.equal(stamp("[dota-bot] Game Coordinator connected", at),
    "2026-10-18T02:10:43.277Z [dota-bot] Game Coordinator connected");
});

test("fields the log doesn't name are dropped, and anything but a plain token is masked", () => {
  const line = formatEvent("request", {
    action: "create",
    // Never named, so never written, whatever a caller passes.
    password: "private123",
    name: "GGD2L Inhouse 42",
    spec: { password: "private123" },
    steamId: "76561198000000099",
    secret: "x".repeat(40),
    // Named, but not a plain token: masked.
    key: "inhouse:42:1 password=private123",
    reason: "a b",
    code: { leak: true },
    ms: Number.NaN,
    result: undefined,
  }, at);
  assert.equal(line, "2026-10-18T02:10:43.277Z [dota-bot] request action=create key=? reason=? code=? ms=?");
  assert.equal(formatEvent("bad event\nname", {}, at), "2026-10-18T02:10:43.277Z [dota-bot] event");
});

test("the seat help's and chat's events carry counts, reasons and the account's limited flag only", () => {
  assert.equal(formatEvent("account", { limited: true }, at), "2026-10-18T02:10:43.277Z [dota-bot] account limited=true");
  assert.equal(
    formatEvent("seat-kick", { key: "inhouse:42:1", reason: "stranger", count: 2, n: 0, id: "76561198000000099" }, at),
    "2026-10-18T02:10:43.277Z [dota-bot] seat-kick key=inhouse:42:1 reason=stranger count=2 n=0",
  );
  assert.equal(
    formatEvent("chat-line", { key: "inhouse:42:1", reason: "side", text: "Sam: you're on Radiant.", channelId: "9223372036854775907" }, at),
    "2026-10-18T02:10:43.277Z [dota-bot] chat-line key=inhouse:42:1 reason=side",
  );
});

test("a logger whose write throws never throws into the bot", () => {
  const log = eventLog({ write: () => { throw new Error("EPIPE"); }, clock: () => at });
  assert.doesNotThrow(() => log("resync", { reason: "release" }));
  const lines = [];
  eventLog({ write: (line) => lines.push(line), clock: () => at })("resync", { n: 1 });
  assert.deepEqual(lines, ["2026-10-18T02:10:43.277Z [dota-bot] resync n=1"]);
});

test("the GC trace keeps only steam-user's GC message lines, as a direction and a type", () => {
  assert.deepEqual(gcMessageEvent("Sending 570 GC message 7040"), { dir: "out", type: 7040 });
  assert.deepEqual(gcMessageEvent("Received 570 GC message 26"), { dir: "in", type: 26 });
  for (const other of [
    "Sending 730 GC message 7040",
    "Received 570 GC message 26 extra",
    'Using token "secret" from license for package 1',
    "Sending message: ClientGamesPlayedWithDataBlob",
    "",
    undefined,
    { message: "Sending 570 GC message 1" },
  ])
    assert.equal(gcMessageEvent(other), null, String(other));
});
