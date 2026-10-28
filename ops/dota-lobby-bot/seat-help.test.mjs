import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobbyController } from "./controller.mjs";
import { formatEvent } from "./event-log.mjs";
import {
  CHAT_GREET_SETTLE_MS,
  CHAT_LINE_GAP_MS,
  CHAT_LINE_MAX,
  CHAT_NAME_MAX,
  CHAT_NAME_MAX_UNITS,
  SEAT_FIX_GAP_MS,
  SEAT_FLIP_MAX_PER_JOB,
  SEAT_KICK_MAX_PER_PLAYER,
  greeting,
  greetLine,
  moveLine,
  rosterNames,
  sanitizeName,
  seatHelpKey,
} from "./seat-help.mjs";
import { validReply } from "../dota-lobby-relay/src/protocol.mjs";

const bot = "76561198000000099";
const ids = Array.from({ length: 10 }, (_, i) => `765611980000000${10 + i}`);
const stranger = "76561198000000077";
const LOBBY = "123456789012345678";
const CHANNEL = "9223372036854775907";
const names = ["Sam", "Lee", "Ash", "Kim", "Bo", "Ivy", "Max", "Ola", "Pat", "Rue"];
const spec = {
  key: "inhouse:4242:1",
  name: "GGD2L Inhouse 4242",
  password: "inhouse123",
  leagueId: 20004,
  gameMode: 2,
  serverRegion: 2,
  radiant: ids.slice(0, 5),
  dire: ids.slice(5),
  names: Object.fromEntries(ids.map((id, i) => [id, names[i]])),
};
const season = { ...spec, key: "season:fixture:1", name: "GGD2L A vs B G1 7" };

// The lobby with the bot in the pool (GC team 4) and the given members:
// [id, team] or [id, team, extra fields].
function lobby(seats, overrides = {}) {
  const allMembers = [{ id: bot, team: 4 }, ...seats.map(([id, team, extra]) => ({ id, team, ...extra }))];
  return {
    lobbyId: LOBBY,
    gameName: spec.name,
    passKey: spec.password,
    leaderId: bot,
    gameMode: 2,
    leagueid: 20004,
    serverRegion: 2,
    allowCheats: false,
    fillWithBots: false,
    seriesType: 0,
    state: 0,
    matchId: "0",
    matchOutcome: 0,
    memberIndices: allMembers.map((_, i) => i),
    allMembers,
    ...overrides,
  };
}
const correct = ids.map((id, i) => [id, i < 5 ? 0 : 1]);
const swapped = ids.map((id, i) => [id, i < 5 ? 1 : 0]);

function setup(t, { online = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ld2l-seat-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Every seat and chat command, in order.
  const sent = [];
  const laters = [];
  const logs = [];
  const time = { at: 1_000_000 };
  const transport = {
    steamId: () => bot,
    create: () => sent.push(["create"]),
    start: () => sent.push(["start"]),
    leave: () => sent.push(["leave"]),
    resync: () => sent.push(["resync"]),
    removeBotFromTeam: () => sent.push(["remove-bot"]),
    invite: () => {},
    kickFromTeam: (id) => sent.push(["kick", id]),
    flipTeams: () => sent.push(["flip"]),
    joinChat: (lobbyId) => sent.push(["join", lobbyId]),
    chat: (channelId, text) => sent.push(["chat", channelId, text]),
    later: (ms) => laters.push(ms),
  };
  const options = {
    file: join(dir, "state.json"),
    transport,
    now: () => time.at,
    log: (event, fields) => logs.push(formatEvent(event, fields, new Date(time.at))),
  };
  const c = new LobbyController(options);
  c.online = online;
  c.absenceConfirmed = true;
  const of = (kind) => sent.filter((s) => s[0] === kind);
  return { c, sent, laters, logs, time, transport, options, of };
}
// Created and ready, with nobody in yet.
function ready(c, s = spec) {
  c.request("create", s);
  c.snapshot(lobby([], { gameName: s.name }));
}
// Dota's answer to the bot's chat join.
const joined = (c, overrides = {}) =>
  c.chatJoined({ channelName: `Lobby_${LOBBY}`, channelType: 3, channelId: CHANNEL, ...overrides });

test("seat help is for inhouse games and duels, never season games", () => {
  assert.equal(seatHelpKey("inhouse:4242:1"), true);
  assert.equal(seatHelpKey("eu:inhouse:4242:1"), true);
  assert.equal(seatHelpKey("duel:4242:1"), true);
  assert.equal(seatHelpKey("eu:duel:4242:1"), true);
  assert.equal(seatHelpKey("season:fixture:1"), false);
  assert.equal(seatHelpKey("eu:season:fixture:1"), false);
  assert.equal(seatHelpKey(undefined), false);
});

test("a roster sitting mirrored gets one swap, confirmed by the next lobby update", (t) => {
  const { c, of, logs, time } = setup(t);
  ready(c);
  c.snapshot(lobby(swapped));
  assert.deepEqual(of("flip"), [["flip"]]);
  assert.deepEqual(of("kick"), []);
  // The update that still shows the old seats (the swap in flight) asks nothing.
  c.snapshot(lobby(swapped));
  time.at += SEAT_FIX_GAP_MS - 1;
  c.tick();
  assert.equal(of("flip").length, 1);
  assert.deepEqual(of("kick"), []);
  // The swap lands.
  c.snapshot(lobby(correct));
  assert.ok(logs.some((l) => / seat-flip key=inhouse:4242:1 result=confirmed n=1$/.test(l)));
  assert.equal(c.request("status", spec).state, "ready");
  assert.deepEqual(of("kick"), []);
});

test("swaps stop at two a job, 30 s apart; a roster still mirrored then is moved player by player", (t) => {
  const { c, of, time } = setup(t);
  ready(c);
  c.snapshot(lobby(swapped));
  time.at += SEAT_FIX_GAP_MS;
  c.tick();
  assert.equal(of("flip").length, SEAT_FLIP_MAX_PER_JOB);
  time.at += SEAT_FIX_GAP_MS;
  c.tick();
  assert.equal(of("flip").length, SEAT_FLIP_MAX_PER_JOB);
  assert.deepEqual(of("kick").map((k) => k[1]).sort(), [...ids].sort());
});

test("no swap with a stranger on a side, a player missing, or anyone's team unknown", (t) => {
  for (const seats of [
    [...swapped, [stranger, 0]],
    swapped.slice(1),
    swapped.map(([id, team], i) => (i === 7 ? [id, 0, { teamOnWire: false }] : [id, team])),
  ]) {
    const { c, of } = setup(t);
    ready(c);
    c.snapshot(lobby(seats));
    assert.deepEqual(of("flip"), []);
  }
  // Nor with the bot itself on a side (its own removal goes first).
  const { c, of } = setup(t);
  ready(c);
  const seats = lobby(swapped);
  seats.allMembers[0].team = 1;
  c.snapshot(seats);
  assert.deepEqual(of("flip"), []);
  assert.equal(of("remove-bot").length, 1);
});

test("a roster player on the wrong side goes back to the pool, three times at most, 30 s apart", (t) => {
  const { c, of, time } = setup(t);
  ready(c);
  const wrong = lobby([[ids[0], 1], [ids[6], 1]]);
  c.snapshot(wrong);
  assert.deepEqual(of("kick"), [["kick", ids[0]]]);
  // Back on the wrong side at once: nothing until 30 s have passed.
  c.snapshot(lobby([[ids[0], 4], [ids[6], 1]]));
  c.snapshot(wrong);
  time.at += SEAT_FIX_GAP_MS - 1;
  c.tick();
  assert.equal(of("kick").length, 1);
  time.at += 1;
  c.tick();
  assert.equal(of("kick").length, 2);
  for (let i = 0; i < 3; i++) {
    time.at += SEAT_FIX_GAP_MS;
    c.snapshot(wrong);
  }
  assert.equal(of("kick").length, SEAT_KICK_MAX_PER_PLAYER);
  // A player on their own side, or in the pool, is never moved.
  assert.ok(of("kick").every((k) => k[1] === ids[0]));
});

test("a stranger on a side goes back to the pool; spectators, casters and the pool are left alone", (t) => {
  const { c, of } = setup(t);
  ready(c);
  c.snapshot(lobby([[stranger, 0], ["76561198000000078", 1], ["76561198000000079", 2], ["76561198000000080", 3], ["76561198000000081", 4], ["76561198000000082", 5]]));
  assert.deepEqual(of("kick"), [["kick", stranger], ["kick", "76561198000000078"]]);
});

test("a player on both of the spec's sides may sit on either", (t) => {
  const { c, of } = setup(t);
  const both = { ...spec, radiant: [...ids.slice(0, 4), ids[5]] };
  ready(c, both);
  c.snapshot(lobby([[ids[5], 1], [ids[4], 0]]));
  c.snapshot(lobby([[ids[5], 0], [ids[4], 0]]));
  // ids[4] is on neither side now: a stranger.
  assert.deepEqual(of("kick"), [["kick", ids[4]]]);
});

test("the bot itself, a coach, and a member whose team Dota didn't send are never moved", (t) => {
  const { c, of, logs } = setup(t);
  ready(c);
  const seats = lobby([
    [ids[0], 1, { coachTeam: 1 }],
    [ids[1], 0, { coachTeam: 5 }],
    // The decoder's default (Radiant) for a team Dota left out.
    [ids[5], 0, { teamOnWire: false }],
    [stranger, 0, { teamOnWire: false }],
  ]);
  seats.allMembers[0].team = 1;
  c.snapshot(seats);
  c.snapshot(seats);
  assert.deepEqual(of("kick"), []);
  assert.equal(of("remove-bot").length, 2);
  // Logged when the count changes, not on every update.
  assert.equal(logs.filter((l) => / seat-unknown key=inhouse:4242:1 count=2$/.test(l)).length, 1);
});

test("no seat help while starting, releasing, offline, led by someone else, or for a season game", (t) => {
  const wrong = (s = spec) => lobby([[ids[0], 1]], { gameName: s.name });

  const seasonGame = setup(t);
  ready(seasonGame.c, season);
  seasonGame.c.snapshot(wrong(season));
  seasonGame.time.at += SEAT_FIX_GAP_MS;
  seasonGame.c.tick();
  assert.deepEqual(seasonGame.of("kick"), []);
  assert.deepEqual(seasonGame.of("join"), []);

  const starting = setup(t);
  ready(starting.c);
  starting.c.snapshot(lobby(correct));
  starting.c.request("start", spec);
  starting.c.snapshot(lobby([...correct.slice(1), [ids[0], 1]]));
  assert.deepEqual(starting.of("kick"), []);

  const releasing = setup(t);
  ready(releasing.c);
  releasing.c.request("release", spec);
  releasing.c.snapshot(wrong());
  assert.deepEqual(releasing.of("kick"), []);

  const offline = setup(t);
  ready(offline.c);
  offline.c.online = false;
  offline.c.snapshot(wrong());
  offline.time.at += SEAT_FIX_GAP_MS;
  offline.c.tick();
  assert.deepEqual(offline.of("kick"), []);
  // Back online, the clock catches up.
  offline.c.online = true;
  offline.c.tick();
  assert.deepEqual(offline.of("kick"), [["kick", ids[0]]]);

  const otherLeader = setup(t);
  ready(otherLeader.c);
  otherLeader.c.snapshot(lobby([[ids[0], 1]], { leaderId: ids[3] }));
  assert.deepEqual(otherLeader.of("kick"), []);

  const wrongSettings = setup(t);
  ready(wrongSettings.c);
  wrongSettings.c.snapshot(lobby([[ids[0], 1]], { leagueid: 1 }));
  assert.deepEqual(wrongSettings.of("kick"), []);

  const serverSetup = setup(t);
  ready(serverSetup.c);
  serverSetup.c.snapshot(lobby([[ids[0], 1]], { state: 1 }));
  assert.deepEqual(serverSetup.of("kick"), []);
});

test("each move and swap is saved before it goes out; a send that throws counts and waits 30 s", (t) => {
  const { c, of, transport, options, logs, time } = setup(t);
  ready(c);
  const onDisk = [];
  transport.kickFromTeam = (id) => {
    onDisk.push(JSON.parse(readFileSync(options.file, "utf8")).jobs[spec.key].seatKicks?.[id]?.count);
    if (id === stranger) throw new Error("Cannot send GC message");
  };
  c.snapshot(lobby([[ids[0], 1], [stranger, 1]]));
  assert.deepEqual(onDisk, [1, 1]);
  assert.ok(logs.some((l) => / seat-kick key=inhouse:4242:1 reason=side count=1 n=0$/.test(l)));
  assert.ok(logs.some((l) => / seat-kick key=inhouse:4242:1 reason=stranger count=0 n=1$/.test(l)));
  c.snapshot(lobby([[ids[0], 1], [stranger, 1]]));
  assert.equal(onDisk.length, 2);
  time.at += SEAT_FIX_GAP_MS;
  c.tick();
  assert.deepEqual(onDisk, [1, 1, 2, 2]);

  const swap = setup(t);
  ready(swap.c);
  const flipsOnDisk = [];
  swap.transport.flipTeams = () =>
    flipsOnDisk.push(JSON.parse(readFileSync(swap.options.file, "utf8")).jobs[spec.key].seatFlips);
  swap.c.snapshot(lobby(swapped));
  assert.deepEqual(flipsOnDisk, [{ count: 1, at: swap.time.at }]);
  assert.deepEqual(of("kick"), []);
});

test("the limits survive a restart", (t) => {
  const { c, of, options, time, sent } = setup(t);
  ready(c);
  c.snapshot(lobby([[ids[0], 1]]));
  c.snapshot(lobby([]));
  const resumed = new LobbyController(options);
  resumed.online = true;
  resumed.snapshot(lobby([[ids[0], 1]]));
  assert.equal(of("kick").length, 1);
  time.at += SEAT_FIX_GAP_MS;
  resumed.snapshot(lobby([[ids[0], 1]]));
  assert.equal(sent.filter((s) => s[0] === "kick").length, 2);
  assert.equal(resumed.data.jobs[spec.key].seatKicks[ids[0]].count, 2);
});

test("seat help never touches the Start check, the seat report or the relay's reply shape", (t) => {
  const { c } = setup(t);
  ready(c);
  c.snapshot(lobby([[ids[0], 1], [stranger, 0]]));
  const reply = c.request("status", { ...spec, withPlayers: true, withLifecycle: true });
  assert.ok(validReply({ id: "00000000-0000-4000-8000-000000000000", status: 200, body: reply }, "status"));
  assert.deepEqual(Object.keys(reply).filter((k) => reply[k] !== undefined).sort(), ["lobbyId", "players", "state"]);
  assert.equal(reply.players[0].seat, "dire");
  assert.throws(() => c.request("start", spec), /ROSTER/);
});

// ---- Lobby chat ----

test("once ready, the bot joins the lobby's chat and says nothing while only it is there", (t) => {
  const { c, of, laters, time, options, transport, sent } = setup(t);
  // Saved before it goes out: read back from disk at send time.
  const onDisk = [];
  transport.joinChat = (lobbyId) => {
    onDisk.push(JSON.parse(readFileSync(options.file, "utf8")).jobs[spec.key].chat?.joins);
    sent.push(["join", lobbyId]);
  };
  ready(c);
  assert.deepEqual(of("join"), [["join", LOBBY]]);
  assert.deepEqual(onDisk, [1]);
  assert.equal(joined(c), true);
  // Dota's lobby chat keeps no history: a line now would reach nobody.
  for (let i = 0; i < 4; i++) {
    time.at += 60_000;
    c.tick();
    c.pumpChat(true);
  }
  assert.deepEqual(of("chat"), []);
  assert.deepEqual(laters, []);
  // A stranger in the pool is no one's to greet.
  c.snapshot(lobby([[stranger, 4]]));
  time.at += 60_000;
  c.pumpChat(true);
  assert.deepEqual(of("chat"), []);
});

test("each drafted player is greeted with their side once they arrive, those arriving together in one line", (t) => {
  const { c, of, laters, time, options, transport, sent } = setup(t);
  const greetedOnDisk = [];
  transport.chat = (channelId, text) => {
    const saved = JSON.parse(readFileSync(options.file, "utf8")).jobs[spec.key].chat?.greeted ?? {};
    greetedOnDisk.push(Object.keys(saved).length);
    sent.push(["chat", channelId, text]);
  };
  ready(c);
  joined(c);
  // Sam and Lee (Radiant) land unassigned, Ivy (Dire) a second later.
  c.snapshot(lobby([[ids[0], 4], [ids[1], 4]]));
  time.at += 1_000;
  c.snapshot(lobby([[ids[0], 4], [ids[1], 4], [ids[5], 4]]));
  // Nothing until they have been in 3 s, so their Dota has joined the chat.
  assert.deepEqual(of("chat"), []);
  assert.deepEqual(laters, [CHAT_GREET_SETTLE_MS]);
  time.at += CHAT_GREET_SETTLE_MS - 1_000 - 1;
  c.pumpChat(true);
  assert.deepEqual(of("chat"), []);
  time.at += 1;
  c.pumpChat(true);
  assert.deepEqual(of("chat"), [["chat", CHANNEL, "Radiant: Sam, Lee. Take a Radiant slot."]]);
  // Saved before it went out, and Ivy's turn (5 s on, though she settles
  // sooner) woken.
  assert.deepEqual(greetedOnDisk, [2]);
  assert.equal(laters.at(-1), CHAT_LINE_GAP_MS);
  time.at += CHAT_LINE_GAP_MS - 1;
  c.pumpChat(true);
  assert.equal(of("chat").length, 1);
  time.at += 1;
  c.pumpChat(true);
  assert.deepEqual(of("chat")[1], ["chat", CHANNEL, "Ivy: you're on Dire. Take a Dire slot."]);
  // Someone who joins after those lines gets one of their own.
  time.at += 60_000;
  c.snapshot(lobby([[ids[0], 0], [ids[1], 4], [ids[5], 1], [ids[6], 4]]));
  time.at += CHAT_GREET_SETTLE_MS;
  c.pumpChat(true);
  assert.deepEqual(of("chat")[2], ["chat", CHANNEL, "Max: you're on Dire. Take a Dire slot."]);
  // Once a player a job: later updates, a repeat answer, a player who left
  // and came back, and a restart say nothing more.
  const allIn = lobby([[ids[0], 4], [ids[1], 4], [ids[5], 4], [ids[6], 4]]);
  c.snapshot(lobby([[ids[1], 4]]));
  c.snapshot(allIn);
  joined(c);
  time.at += 60_000;
  c.pumpChat(true);
  const resumed = new LobbyController(options);
  resumed.online = true;
  resumed.snapshot(allIn);
  joined(resumed);
  time.at += 60_000;
  resumed.pumpChat(true);
  assert.equal(of("chat").length, 3);
  // A player who left before their turn and came back waits the 3 s again.
  resumed.snapshot(lobby([[ids[7], 4]]));
  time.at += 1_000;
  resumed.snapshot(lobby([]));
  time.at += 60_000;
  resumed.snapshot(lobby([[ids[7], 4]]));
  resumed.pumpChat(true);
  assert.equal(of("chat").length, 3);
  time.at += CHAT_GREET_SETTLE_MS;
  resumed.pumpChat(true);
  assert.deepEqual(of("chat")[3], ["chat", CHANNEL, "Ola: you're on Dire. Take a Dire slot."]);
  // A player already on their side needs no line; one who stands up into
  // the pool later gets it then.
  resumed.snapshot(lobby([[ids[2], 0]]));
  time.at += 60_000;
  resumed.pumpChat(true);
  assert.equal(of("chat").length, 4);
  resumed.snapshot(lobby([[ids[2], 4]]));
  time.at += CHAT_GREET_SETTLE_MS;
  resumed.pumpChat(true);
  assert.deepEqual(of("chat")[4], ["chat", CHANNEL, "Ash: you're on Radiant. Take a Radiant slot."]);
});

test("players already in when the join is answered are greeted then, and a reconnect loses no greeting", (t) => {
  const { c, of, time, laters } = setup(t);
  ready(c);
  c.snapshot(lobby([[ids[0], 4], [ids[9], 3]]));
  time.at += 10_000;
  joined(c);
  // Arrived together: the lobby's member order breaks the tie, and the
  // next greeting's turn is woken.
  assert.deepEqual(of("chat"), [["chat", CHANNEL, "Sam: you're on Radiant. Take a Radiant slot."]]);
  assert.equal(laters.at(-1), CHAT_LINE_GAP_MS);
  // A spectator slot isn't a side: Rue is told too.
  time.at += CHAT_LINE_GAP_MS;
  c.pumpChat(true);
  assert.deepEqual(of("chat")[1], ["chat", CHANNEL, "Rue: you're on Dire. Take a Dire slot."]);

  const fresh = setup(t);
  ready(fresh.c);
  joined(fresh.c);
  fresh.c.snapshot(lobby([[ids[3], 4]]));
  fresh.time.at += 1_000;
  // A Game Coordinator reconnect before Kim's turn: the channel is gone.
  fresh.c.welcoming();
  fresh.c.snapshot(lobby([[ids[3], 4]]));
  fresh.c.welcomed(true);
  fresh.time.at += CHAT_GREET_SETTLE_MS;
  fresh.c.pumpChat(true);
  assert.deepEqual(fresh.of("chat"), []);
  // The rejoin 30 s after the last join brings it.
  fresh.time.at += 30_000;
  fresh.c.tick();
  assert.equal(fresh.of("join").length, 2);
  joined(fresh.c);
  for (let i = 0; i < 3; i++) {
    fresh.time.at += 60_000;
    fresh.c.pumpChat(true);
  }
  assert.deepEqual(fresh.of("chat"), [["chat", CHANNEL, "Kim: you're on Radiant. Take a Radiant slot."]]);
});

test("greeting() picks the side whose player waited longest, and never the bot, a stranger, a coach, the seated or the unknown", () => {
  const at = 100_000;
  const settled = at - CHAT_GREET_SETTLE_MS;
  const members = [
    { id: bot, team: 4 },
    { id: stranger, team: 4 },
    { id: ids[0], team: 4 },
    { id: ids[1], team: 4, coachTeam: 0 },
    { id: ids[2], team: 0 },
    { id: ids[3], team: 1 },
    { id: ids[4], team: 4, teamOnWire: false },
    { id: ids[5], team: 5 },
    { id: ids[6], team: 2 },
    { id: ids[7], team: 4 },
  ];
  const seen = new Map(members.map((m) => [m.id, settled]));
  // Dire's Ivy came first, so Dire's line goes first, with every Dire player due.
  seen.set(ids[5], settled - 1);
  // Ola is still settling.
  seen.set(ids[7], at - 1_000);
  const plan = greeting({ members, spec, now: at, seen, greeted: {} });
  assert.deepEqual(plan, { due: { side: 1, ids: [ids[5], ids[6]] }, wait: CHAT_GREET_SETTLE_MS - 1_000 });
  // Those two greeted: Sam is next, the only Radiant player due.
  const next = greeting({ members, spec, now: at, seen, greeted: { [ids[5]]: at, [ids[6]]: at } });
  assert.deepEqual(next.due, { side: 0, ids: [ids[0]] });
  // Never seen (the clock ran before the update): not yet.
  assert.equal(greeting({ members, spec, now: at, seen: new Map(), greeted: {} }).due, null);
  // A player on both of the spec's sides has no one side to be told.
  const both = { ...spec, dire: [ids[0], ...spec.dire.slice(1)] };
  const onBoth = greeting({ members: [{ id: ids[0], team: 4 }], spec: both, now: at, seen, greeted: {} });
  assert.deepEqual(onBoth, { due: null, wait: undefined });
});

test("without names the bot says the plain line for a side", () => {
  const none = rosterNames({ ...spec, names: undefined });
  assert.equal(greetLine(0, spec.radiant.slice(0, 2), none), "Radiant players: take a Radiant slot.");
  assert.equal(greetLine(1, [ids[5]], none), "Dire players: take a Dire slot.");
});

test("a move says who and where, at most once a player every 30 s and one line every 5 s", (t) => {
  const { c, of, time } = setup(t);
  ready(c);
  joined(c);
  time.at += 10_000;
  c.pumpChat(true);
  time.at += 10_000;
  c.snapshot(lobby([[ids[0], 1], [ids[5], 0], [stranger, 0]]));
  assert.equal(of("kick").length, 3);
  const lines = () => of("chat").map((s) => s[2]);
  assert.deepEqual(lines(), ["Sam: you're on Radiant. Take a Radiant slot."]);
  time.at += CHAT_LINE_GAP_MS;
  c.pumpChat(true);
  time.at += CHAT_LINE_GAP_MS;
  c.pumpChat(true);
  assert.deepEqual(lines(), [
    "Sam: you're on Radiant. Take a Radiant slot.",
    "Ivy: you're on Dire. Take a Dire slot.",
    "That seat is for a drafted player, so you were moved to unassigned.",
  ]);
  // Sam back on Dire at once: no move and no line until 30 s after the first.
  c.snapshot(lobby([[ids[0], 1]]));
  assert.equal(lines().length, 3);
  time.at += SEAT_FIX_GAP_MS - 2 * CHAT_LINE_GAP_MS;
  c.snapshot(lobby([[ids[0], 1]]));
  assert.equal(of("kick").length, 4);
  assert.equal(lines().length, 4);
  // A move's line told Sam and Ivy their side: back in the pool, no greeting.
  c.snapshot(lobby([[ids[0], 4], [ids[5], 4]]));
  for (let i = 0; i < 3; i++) {
    time.at += 60_000;
    c.pumpChat(true);
  }
  assert.equal(lines().length, 4);
  // A move's line waiting its turn goes before a greeting, and is the moved
  // player's greeting: one line about Bo, never two.
  const order = setup(t);
  ready(order.c);
  joined(order.c);
  order.c.snapshot(lobby([[ids[1], 4]]));
  order.time.at += CHAT_GREET_SETTLE_MS;
  order.c.pumpChat(true);
  order.c.snapshot(lobby([[ids[1], 4], [ids[4], 1]]));
  order.c.snapshot(lobby([[ids[1], 4], [ids[4], 4]]));
  for (let i = 0; i < 4; i++) {
    order.time.at += CHAT_LINE_GAP_MS;
    order.c.pumpChat(true);
  }
  assert.deepEqual(order.of("chat").map((s) => s[2]), [
    "Lee: you're on Radiant. Take a Radiant slot.",
    "Bo: you're on Radiant. Take a Radiant slot.",
  ]);
  // A swap gets its own line.
  const swap = setup(t);
  ready(swap.c);
  joined(swap.c);
  swap.time.at += 10_000;
  swap.c.pumpChat(true);
  swap.time.at += 10_000;
  swap.c.snapshot(lobby(swapped));
  assert.equal(swap.of("chat").at(-1)[2], moveLine("flip"));
});

test("lines are dropped after 30 s, and all of them once the lobby is no longer being set up", (t) => {
  const { c, of, time } = setup(t);
  ready(c);
  // Moved before Dota answered the join: the line waits for the channel.
  c.snapshot(lobby([[ids[0], 1]]));
  time.at += 31_000;
  joined(c);
  // The 31 s old move line never goes, and Sam, seated as far as the bot
  // knows, isn't greeted.
  time.at += CHAT_LINE_GAP_MS;
  c.pumpChat(true);
  assert.deepEqual(of("chat"), []);
  // Shown in the pool, he is greeted instead.
  c.snapshot(lobby([[ids[0], 4]]));
  time.at += CHAT_GREET_SETTLE_MS;
  c.pumpChat(true);
  assert.deepEqual(of("chat").map((s) => s[2]), ["Sam: you're on Radiant. Take a Radiant slot."]);

  const started = setup(t);
  ready(started.c);
  joined(started.c);
  started.c.snapshot(lobby([[ids[0], 1], [stranger, 0]]));
  assert.equal(started.of("chat").length, 1);
  assert.equal(started.c.chat.queue.length, 1);
  started.c.snapshot(lobby(correct));
  started.c.request("start", spec);
  started.time.at += CHAT_LINE_GAP_MS;
  started.c.pumpChat(true);
  assert.equal(started.of("chat").length, 1);
  assert.equal(started.c.chat.queue.length, 0);
});

test("at most eight lines wait their turn", (t) => {
  const { c, of, time } = setup(t);
  ready(c);
  joined(c);
  time.at += 10_000;
  c.pumpChat(true);
  time.at += 10_000;
  const strangers = Array.from({ length: 10 }, (_, i) => [`765611980000001${10 + i}`, i % 2]);
  c.snapshot(lobby(strangers));
  assert.equal(of("kick").length, 10);
  // The first move's line went at once; eight wait, the tenth is dropped.
  assert.equal(of("chat").length, 1);
  assert.equal(c.chat.queue.length, 8);
  for (let i = 0; i < 12; i++) {
    time.at += CHAT_LINE_GAP_MS;
    c.pumpChat(true);
  }
  // One every 5 s, until the rest are 30 s old.
  assert.equal(of("chat").length, 1 + 5);
  assert.equal(c.chat.queue.length, 0);
});

test("an answer with no channel id is a refusal too", (t) => {
  const { c, logs } = setup(t);
  ready(c);
  assert.equal(joined(c, { channelId: undefined }), false);
  assert.equal(c.data.jobs[spec.key].chat.unavailable, "refused");
  assert.ok(logs.some((l) => / chat key=inhouse:4242:1 result=unavailable reason=refused$/.test(l)));
});

test("a refused join leaves the job's chat unavailable, and the seat help goes on", (t) => {
  const { c, of, logs, time } = setup(t);
  ready(c);
  assert.equal(joined(c, { result: 5 }), false);
  assert.ok(logs.some((l) => / chat key=inhouse:4242:1 result=unavailable reason=refused n=5$/.test(l)));
  c.snapshot(lobby([[ids[0], 1]]));
  assert.deepEqual(of("kick"), [["kick", ids[0]]]);
  for (let i = 0; i < 4; i++) {
    time.at += 60_000;
    c.tick();
  }
  assert.equal(of("join").length, 1);
  assert.deepEqual(of("chat"), []);
});

test("a join Dota never answers is tried once more, then the job goes quiet", (t) => {
  const { c, of, logs, time, options } = setup(t);
  ready(c);
  time.at += 29_999;
  c.tick();
  assert.equal(of("join").length, 1);
  time.at += 1;
  c.tick();
  assert.equal(of("join").length, 2);
  time.at += 30_000;
  c.tick();
  assert.ok(logs.some((l) => / chat key=inhouse:4242:1 result=unavailable reason=no-answer$/.test(l)));
  for (let i = 0; i < 4; i++) {
    time.at += 60_000;
    c.tick();
  }
  assert.equal(of("join").length, 2);
  // Saved: a restart stays quiet too.
  const resumed = new LobbyController(options);
  resumed.online = true;
  resumed.snapshot(lobby([]));
  time.at += 60_000;
  resumed.tick();
  assert.equal(of("join").length, 2);
});

test("a join or a line that throws makes the job's chat unavailable, never a move", (t) => {
  const { c, of, transport, logs } = setup(t);
  transport.joinChat = () => {
    throw new Error("Cannot send GC message");
  };
  ready(c);
  assert.ok(logs.some((l) => / chat key=inhouse:4242:1 result=unavailable reason=send-failed$/.test(l)));
  c.snapshot(lobby([[ids[0], 1]]));
  assert.deepEqual(of("kick"), [["kick", ids[0]]]);

  const line = setup(t);
  line.transport.chat = () => {
    throw new Error("Cannot send GC message");
  };
  ready(line.c);
  joined(line.c);
  line.c.snapshot(lobby([[ids[0], 1]]));
  assert.deepEqual(line.of("kick"), [["kick", ids[0]]]);
  assert.ok(line.logs.some((l) => / chat key=inhouse:4242:1 result=unavailable reason=send-failed$/.test(l)));
  assert.equal(line.c.data.jobs[spec.key].chat.unavailable, "send-failed");
  // The moves go on.
  line.time.at += SEAT_FIX_GAP_MS;
  line.c.snapshot(lobby([[ids[0], 1], [ids[1], 4]]));
  assert.equal(line.of("kick").length, 2);
});

test("chat answers for another lobby, another channel type or a season job are ignored", (t) => {
  const { c, of } = setup(t);
  assert.equal(joined(c), false);
  ready(c);
  assert.equal(joined(c, { channelName: "Lobby_999" }), false);
  assert.equal(joined(c, { channelType: 0 }), false);
  assert.equal(joined(c, { channelName: "Lobby_999", channelType: undefined }), false);
  assert.deepEqual(of("chat"), []);
  assert.equal(c.chat.channelId, null);
  // A lobby channel Dota names its own way, answering the join we sent.
  assert.equal(joined(c, { channelName: "Lobby" }), true);
  assert.equal(c.chat.channelId, CHANNEL);

  const seasonGame = setup(t);
  ready(seasonGame.c, season);
  assert.equal(joined(seasonGame.c), false);
  assert.deepEqual(seasonGame.of("join"), []);
});

test("a Game Coordinator reconnect rejoins the chat, two joins a job at most", (t) => {
  const { c, of, time } = setup(t);
  ready(c);
  joined(c);
  for (let i = 0; i < 3; i++) {
    time.at += 60_000;
    c.welcoming();
    c.snapshot(lobby([]));
    c.welcomed(true);
    c.tick();
  }
  assert.equal(of("join").length, 2);
});

test("a reconnect rejoins no sooner than 30 s after the last join", (t) => {
  const { c, of, time } = setup(t);
  ready(c);
  joined(c);
  time.at += 10_000;
  c.welcoming();
  c.snapshot(lobby([]));
  c.welcomed(true);
  c.tick();
  assert.equal(of("join").length, 1);
  time.at += 20_000;
  c.tick();
  assert.equal(of("join").length, 2);
});

test("a join waits 30 s for its answer, however many updates arrive meanwhile", (t) => {
  const { c, of, time } = setup(t);
  ready(c);
  time.at += 10_000;
  c.snapshot(lobby([[ids[0], 0]]));
  c.tick();
  // An answer naming the lobby's channel its own way still counts.
  time.at += 10_000;
  assert.equal(joined(c, { channelName: "Lobby" }), true);
  assert.equal(of("join").length, 1);
});

test("the bot's own line coming back is logged once, as proof chat works", (t) => {
  const { c, logs } = setup(t);
  ready(c);
  assert.equal(c.chatSeen(CHANNEL), false);
  joined(c);
  assert.equal(c.chatSeen("1"), false);
  assert.equal(c.chatSeen(CHANNEL), true);
  assert.equal(c.chatSeen(CHANNEL), false);
  assert.equal(logs.filter((l) => / chat key=inhouse:4242:1 result=echoed$/.test(l)).length, 1);
});

// ---- Names ----

test("names are cleaned for one chat line: no newlines, control or format characters, 32 at most", () => {
  assert.equal(sanitizeName("  Sam  "), "Sam");
  assert.equal(sanitizeName("Sam\nRadiant: go Dire"), "Sam Radiant: go Dire");
  assert.equal(sanitizeName("a\tb\r\nc"), "a b c");
  assert.equal(sanitizeName("Z\u200bero\u202eevil\u0007"), "Zeroevil");
  assert.equal(sanitizeName("x".repeat(40)), "x".repeat(CHAT_NAME_MAX));
  assert.equal(sanitizeName("🙂".repeat(40)), "🙂".repeat(CHAT_NAME_MAX));
  // Bidi marks, embeddings, overrides and isolates all go.
  assert.equal(sanitizeName("\u061cA\u200eB\u200fC\u202aD\u202bE\u202cF\u202dG\u202eH\u2066I\u2067J\u2068K\u2069"), "ABCDEFGHIJK");
  for (const empty of ["", "   ", "​\n", "\u200d", " \u200c\u200d ", "\u{e0067}\u{e0062}", 7, null, undefined, ["Sam"]])
    assert.equal(sanitizeName(empty), undefined);
});

test("a name shows as typed: emoji sequences, flags and joiners intact, and a cut never splits one", () => {
  const family = "👨‍👩‍👧‍👦";
  const england = "🏴󠁧󠁢󠁥󠁮󠁧󠁿";
  for (const name of [`Sam${family}`, `Sam ${england}`, "می‌خواهم", "👍🏽Lee", "🇺🇸 Bo"])
    assert.equal(sanitizeName(name), name);
  // Joiners at the ends join nothing, and count for nothing in the cut.
  assert.equal(sanitizeName("\u200dSam\u200c"), "Sam");
  assert.equal(sanitizeName(`${"\u200d".repeat(62)}Sam`), "Sam");
  // A cut that ends on a space leaves none.
  assert.equal(sanitizeName(`${"x".repeat(31)} yz`), "x".repeat(31));
  // Any name the site sends (32 code points at most) comes through whole.
  const site = `${"x".repeat(28)}🇺🇸👍🏽`;
  assert.equal([...site].length, 32);
  assert.equal(sanitizeName(site), site);
  // The cut falls between two characters as they show.
  assert.equal(sanitizeName(`${"x".repeat(31)}🇺🇸🇺🇸`), `${"x".repeat(31)}🇺🇸`);
  assert.equal(sanitizeName(`${"x".repeat(31)}👍🏽👍🏽`), `${"x".repeat(31)}👍🏽`);
  assert.equal(sanitizeName(`${"x".repeat(31)}${family}${family}`), `${"x".repeat(31)}${family}`);
  // And the whole name stays within CHAT_NAME_MAX_UNITS.
  const families = sanitizeName(family.repeat(10));
  assert.equal(families, family.repeat(Math.floor(CHAT_NAME_MAX_UNITS / family.length)));
  assert.ok(families.length <= CHAT_NAME_MAX_UNITS);
});

test("names come from a map or one list a side, roster players only", () => {
  const base = { ...spec, names: undefined };
  assert.deepEqual([...rosterNames(base)], []);
  const lists = rosterNames({ ...base, radiantNames: names.slice(0, 5), direNames: names.slice(5) });
  assert.equal(lists.get(ids[0]), "Sam");
  assert.equal(lists.get(ids[9]), "Rue");
  // A list of another length can't be lined up with its side: ignored.
  assert.equal(rosterNames({ ...base, radiantNames: names.slice(0, 4) }).size, 0);
  // The map wins, only roster IDs count, and a bad entry is skipped.
  const mixed = rosterNames({
    ...base,
    names: { [ids[0]]: "Mapped", [stranger]: "Nobody", [ids[1]]: 42 },
    radiantNames: names.slice(0, 5),
  });
  assert.equal(mixed.get(ids[0]), "Mapped");
  assert.equal(mixed.get(ids[1]), "Lee");
  assert.equal(mixed.has(stranger), false);
  for (const bad of [null, "Sam", ["Sam"], 5]) assert.equal(rosterNames({ ...base, names: bad }).size, 0);
});

test("a side's line fits one chat line, naming as many as fit", () => {
  const long = rosterNames({ ...spec, names: Object.fromEntries(ids.map((id, i) => [id, `${"W".repeat(31)}${i}`])) });
  const radiant = greetLine(0, spec.radiant, long);
  const dire = greetLine(1, spec.dire, long);
  for (const line of [radiant, dire]) assert.ok(line.length <= CHAT_LINE_MAX, line);
  assert.match(radiant, /^Radiant: W{31}0, W{31}1 \+3 more\. Take a Radiant slot\.$/);
  // The longest name a line can carry still fits a player's own line.
  const widest = sanitizeName("🙂".repeat(CHAT_NAME_MAX_UNITS));
  assert.equal(widest.length, CHAT_NAME_MAX_UNITS);
  const wide = new Map([[ids[0], widest]]);
  for (const side of [0, 1]) {
    assert.ok(moveLine("side", side, widest).length <= CHAT_LINE_MAX);
    assert.ok(greetLine(side, [ids[0]], wide).length <= CHAT_LINE_MAX);
  }
  // Some unnamed: they count in "+N more".
  const some = rosterNames({ ...spec, names: { [ids[0]]: "Sam" } });
  assert.equal(greetLine(0, spec.radiant, some), "Radiant: Sam +4 more. Take a Radiant slot.");
  assert.equal(greetLine(1, spec.dire, some), "Dire players: take a Dire slot.");
  assert.equal(moveLine("side", 1), "Moved a Dire player to unassigned. Take a Dire slot.");
});

test("a job's names leave lobbies.json once its claim is freed", (t) => {
  const { c, options } = setup(t);
  ready(c, { ...spec, radiantNames: names.slice(0, 5), direNames: names.slice(5) });
  const saved = () => JSON.parse(readFileSync(options.file, "utf8")).jobs[spec.key].spec;
  assert.equal(saved().names[ids[0]], "Sam");
  assert.equal(saved().radiantNames.length, 5);
  c.request("release", spec);
  c.departed("destroy");
  const after = saved();
  for (const field of ["names", "radiantNames", "direNames"]) assert.equal(Object.hasOwn(after, field), false, field);
  // Everything else stays for the record.
  assert.deepEqual(after.radiant, spec.radiant);
  assert.equal(after.name, spec.name);
});

test("a whole night of seat help and chat logs counts and reasons only", (t) => {
  const { c, logs, time } = setup(t);
  ready(c);
  joined(c);
  c.snapshot(lobby([[ids[1], 4]]));
  time.at += CHAT_GREET_SETTLE_MS;
  c.pumpChat(true);
  time.at += CHAT_LINE_GAP_MS;
  c.snapshot(lobby([[ids[0], 1], [stranger, 0]]));
  time.at += CHAT_LINE_GAP_MS;
  c.pumpChat(true);
  time.at += SEAT_FIX_GAP_MS;
  c.snapshot(lobby(swapped));
  c.snapshot(lobby([[ids[5], 0, { teamOnWire: false }], ...correct.slice(0, 5)]));
  c.snapshot(lobby(correct));
  c.chatSeen(CHANNEL);
  c.request("start", spec);
  const text = logs.join("\n");
  for (const secret of [spec.password, spec.name, bot, stranger, CHANNEL, ...ids, ...names, "Take a"])
    assert.ok(!text.includes(secret), secret);
  for (const line of logs)
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[dota-bot\] [a-z-]+( [a-zA-Z]+=[^ ]+)*$/);
  for (const event of ["seat-kick", "seat-flip", "seat-unknown", "chat", "chat-line"])
    assert.ok(logs.some((line) => line.includes(` [dota-bot] ${event} `)), event);
  for (const reason of ["greet", "side", "stranger"])
    assert.ok(logs.some((line) => line.endsWith(` chat-line key=inhouse:4242:1 reason=${reason}`)), reason);
});

// ---- 1v1 mid duels ----

const duel = {
  key: "duel:4242:1",
  name: "GGD2L 1v1 4242",
  password: "inhouse123",
  leagueId: 20004,
  gameMode: 21,
  serverRegion: 2,
  radiant: [ids[0]],
  dire: [ids[5]],
  names: { [ids[0]]: "Sam", [ids[5]]: "Ivy" },
};
const duelLobby = (seats, overrides = {}) => lobby(seats, { gameName: duel.name, gameMode: 21, ...overrides });

test("a duel's two players sitting swapped get one swap, and a duel's lines say players", (t) => {
  const { c, of, time } = setup(t);
  c.request("create", duel);
  c.snapshot(duelLobby([]));
  assert.equal(joined(c), true);
  c.snapshot(duelLobby([[ids[0], 1], [ids[5], 0]]));
  assert.deepEqual(of("flip"), [["flip"]]);
  assert.deepEqual(of("kick"), []);
  assert.deepEqual(of("chat").map((s) => s[2]), ["Both players sat on the wrong sides, so I swapped Radiant and Dire."]);
  c.snapshot(duelLobby([[ids[0], 0], [ids[5], 1]]));
  assert.equal(c.request("status", duel).state, "ready");
  // A stranger on a side is moved, with the duel's line.
  time.at += SEAT_FIX_GAP_MS;
  c.snapshot(duelLobby([[ids[0], 0], [ids[5], 1], [stranger, 0]]));
  assert.deepEqual(of("kick"), [["kick", stranger]]);
  time.at += CHAT_LINE_GAP_MS;
  c.pumpChat(true);
  assert.equal(of("chat").at(-1)[2], "That seat is for a player in this 1v1, so you were moved to unassigned.");
});

test("a duel player on the wrong side alone is moved back to the pool", (t) => {
  const { c, of } = setup(t);
  c.request("create", duel);
  c.snapshot(duelLobby([[ids[0], 1]]));
  assert.deepEqual(of("kick"), [["kick", ids[0]]]);
  assert.deepEqual(of("flip"), []);
});

test("a duel's greeting names both players and their sides in one line", (t) => {
  const { c, of, time } = setup(t);
  c.request("create", duel);
  c.snapshot(duelLobby([]));
  joined(c);
  c.snapshot(duelLobby([[ids[0], 4]]));
  time.at += CHAT_GREET_SETTLE_MS;
  c.tick();
  assert.deepEqual(of("chat").map((s) => s[2]), ["1v1 mid: Sam on Radiant, Ivy on Dire. Take your side."]);
  // The other player gets it once they arrive; nobody gets it twice.
  c.snapshot(duelLobby([[ids[0], 4], [ids[5], 4]]));
  time.at += Math.max(CHAT_GREET_SETTLE_MS, CHAT_LINE_GAP_MS);
  c.tick();
  time.at += CHAT_LINE_GAP_MS;
  c.tick();
  assert.equal(of("chat").length, 2);
  assert.equal(of("chat")[1][2], "1v1 mid: Sam on Radiant, Ivy on Dire. Take your side.");
});

test("a duel's lines without names, and the longest names, still fit one chat line", () => {
  const plain = { ...duel, names: undefined };
  assert.equal(greetLine(0, [ids[0]], rosterNames(plain), plain), "1v1 mid: take the side the site shows you, Radiant or Dire.");
  const long = { ...duel, names: { [ids[0]]: "😀".repeat(40), [ids[5]]: "W".repeat(40) } };
  assert.equal(greetLine(1, [ids[5]], rosterNames(long), long), "1v1 mid: take the side the site shows you, Radiant or Dire.");
  const max = { ...duel, names: { [ids[0]]: "W".repeat(40), [ids[5]]: "M".repeat(40) } };
  const line = greetLine(1, [ids[5]], rosterNames(max), max);
  assert.equal(line, `1v1 mid: ${"W".repeat(32)} on Radiant, ${"M".repeat(32)} on Dire. Take your side.`);
  assert.ok(line.length <= CHAT_LINE_MAX);
  // Inhouse lines are unchanged when a spec is passed.
  assert.equal(moveLine("stranger", undefined, undefined, spec), "That seat is for a drafted player, so you were moved to unassigned.");
  assert.equal(moveLine("flip", undefined, undefined, spec), "Both teams sat on the wrong sides, so I swapped Radiant and Dire.");
  assert.equal(greetLine(0, [ids[0]], rosterNames(spec), spec), "Sam: you're on Radiant. Take a Radiant slot.");
});
