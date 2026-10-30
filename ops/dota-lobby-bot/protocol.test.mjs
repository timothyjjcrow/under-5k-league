import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import SteamUser from "steam-user";
import { Dota2User } from "dota2-user";
import protos from "dota2-user/protobufs/index.js";
import {
  accountIdOf,
  LOBBY_CHANNEL_TYPE,
  lobbyChannelName,
  markWireTeams,
  membersTeamOnWire,
  readMessage,
} from "./lobby-wire.mjs";
import { EARLY_LEAVE_GAME_STATES } from "./controller.mjs";

test("installed Steam/GC adapter and pinned request wire fields interoperate", () => {
  const user = new SteamUser({ dataDirectory: null });
  const dota = new Dota2User(user);
  user.steamID = { getSteamID64: () => "76561198000000099" };
  let sent;
  user.sendToGC = (...args) => {
    sent = args;
  };
  const schema = protobuf.loadSync(
    fileURLToPath(new URL("./lobby.proto", import.meta.url)),
  );
  const type = schema.lookupType("CreateLobby");
  const details = schema.lookupType("LobbyDetails");
  assert.equal(type.fields.lobbyDetails.id, 7);
  assert.equal(details.fields.leagueid.id, 16);
  assert.equal(details.fields.gameMode.id, 5);
  const bytes = Buffer.from(
    type
      .encode(
        type.create({
          passKey: "private",
          lobbyDetails: {
            gameMode: 2,
            serverRegion: 2,
            leagueid: 12345,
            seriesType: 0,
          },
        }),
      )
      .finish(),
  );
  dota.sendRawBuffer(7038, bytes);
  assert.equal(sent[0], 570);
  assert.equal(sent[1], 7038);
  assert.deepEqual(sent[3], bytes);
});
test("installed GC shared-object decoder keeps uint64 lobby IDs and current members", () => {
  const lobby = protos.CSODOTALobby.create({
    lobbyId: "123456789012345678",
    gameMode: 2,
    serverRegion: 2,
    leagueid: 12345,
    memberIndices: [0],
    allMembers: [{ id: "76561198000000010", team: 0 }],
  });
  const bytes = protos.CSODOTALobby.encode(lobby).finish();
  const decoded = protos.CSODOTALobby.decode(bytes);
  assert.equal(decoded.lobbyId, "123456789012345678");
  assert.deepEqual(decoded.memberIndices, [0]);
  assert.equal(decoded.allMembers[0].id, "76561198000000010");
});
test("lobby invites go out as GC 4512 carrying the player's fixed64 Steam ID", () => {
  const user = new SteamUser({ dataDirectory: null });
  const dota = new Dota2User(user);
  user.steamID = { getSteamID64: () => "76561198000000099" };
  let sent;
  user.sendToGC = (...args) => {
    sent = args;
  };
  dota.sendPartial(protos.EGCBaseMsg.k_EMsgGCInviteToLobby, {
    steamId: "76561197960287930",
  });
  assert.equal(sent[0], 570);
  assert.equal(sent[1], 4512);
  // Field 1, fixed64 little-endian 0x01100001000056BA; client version 0 omitted.
  assert.equal(Buffer.from(sent[3]).toString("hex"), "09ba56000001001001");
  // send() leaves the client version undefined and throws: why the bot uses sendPartial.
  assert.throws(() =>
    dota.send(protos.EGCBaseMsg.k_EMsgGCInviteToLobby, { steamId: "76561197960287930" }),
  );
  // The GC's answer (4502) decodes with the Steam ID as a string.
  const answer = protos.CMsgInvitationCreated.encode(
    protos.CMsgInvitationCreated.fromPartial({
      groupId: "123",
      steamId: "76561197960287930",
      userOffline: true,
    }),
  ).finish();
  const decoded = protos.CMsgInvitationCreated.decode(answer);
  assert.equal(decoded.steamId, "76561197960287930");
  assert.equal(decoded.userOffline, true);
  assert.equal(protos.EGCBaseMsg.k_EMsgGCInvitationCreated, 4502);
});

// ---- Seat help and lobby chat (seat-help.mjs, lobby-wire.mjs) ----

const schema = () => protobuf.loadSync(fileURLToPath(new URL("./lobby.proto", import.meta.url)));
const encode = (type, data) => {
  const message = schema().lookupType(type);
  assert.equal(message.verify(data), null);
  return Buffer.from(message.encode(message.create(data)).finish()).toString("hex");
};

test("a player's Dota account id is their Steam64 ID's low 32 bits, and nothing else passes", () => {
  assert.equal(accountIdOf("76561197960287930"), 22202);
  assert.equal(accountIdOf("76561202255233023"), 4294967295);
  for (const bad of ["76561197960265728", "76561202255233024", "7656119796028793", "x6561197960287930", 76561197960287930, undefined])
    assert.throws(() => accountIdOf(bad));
});

test("seat moves and the swap go out as GC 8047 with the account id and GC 7320 with no fields", () => {
  const user = new SteamUser({ dataDirectory: null });
  const dota = new Dota2User(user);
  user.steamID = { getSteamID64: () => "76561198000000099" };
  const sent = [];
  user.sendToGC = (...args) => sent.push(args);
  // KickFromTeam: field 1, varint 22202.
  assert.equal(encode("KickFromTeam", { accountId: accountIdOf("76561197960287930") }), "08baad01");
  assert.equal(encode("Empty", {}), "");
  dota.sendRawBuffer(protos.EDOTAGCMsg.k_EMsgGCPracticeLobbyKickFromTeam, Buffer.from("08baad01", "hex"));
  dota.sendRawBuffer(protos.EDOTAGCMsg.k_EMsgGCFlipLobbyTeams, Buffer.alloc(0));
  assert.deepEqual(sent.map((s) => [s[0], s[1]]), [[570, 8047], [570, 7320]]);
  // The installed decoder's own empty message agrees.
  assert.equal(protos.CMsgFlipLobbyTeams.encode({}).finish().length, 0);
});

test("the chat join, its answer and a chat line match Dota's chat protos", () => {
  assert.equal(protos.EDOTAGCMsg.k_EMsgGCJoinChatChannel, 7009);
  assert.equal(protos.EDOTAGCMsg.k_EMsgGCJoinChatChannelResponse, 7010);
  assert.equal(protos.EDOTAGCMsg.k_EMsgGCChatMessage, 7273);
  assert.equal(protos.DOTAChatChannelTypeT.DOTAChannelType_Lobby, LOBBY_CHANNEL_TYPE);
  assert.equal(lobbyChannelName("123456789012345678"), "Lobby_123456789012345678");
  // Join: field 2 the name, field 4 the type.
  assert.equal(
    encode("JoinChatChannel", { channelName: "Lobby_123", channelType: 3 }),
    `1209${Buffer.from("Lobby_123").toString("hex")}2003`,
  );
  // The answer's fixed64 channel id past 2^53 keeps every digit; a field
  // Dota left out stays absent.
  const answer = schema().lookupType("JoinChatChannelResponse");
  const bytes = answer
    .encode(answer.create({ channelName: "Lobby_123", channelId: protobuf.util.Long.fromString("9223372036854775907", true), channelType: 3 }))
    .finish();
  assert.deepEqual(readMessage(schema(), "JoinChatChannelResponse", bytes), {
    channelName: "Lobby_123",
    channelId: "9223372036854775907",
    channelType: 3,
  });
  // A line: channel_id is a varint (wire type 0) here, and send()'s check
  // needs a Long, never the string the answer carries.
  const line = schema().lookupType("ChatMessage");
  assert.match(line.verify({ channelId: "9223372036854775907", text: "hi" }), /integer\|Long expected/);
  const hex = encode("ChatMessage", { channelId: protobuf.util.Long.fromString("9223372036854775907", true), text: "hi" });
  assert.ok(hex.startsWith("10"));
  assert.deepEqual(readMessage(schema(), "ChatMessage", Buffer.from(hex, "hex")), {
    channelId: "9223372036854775907",
    text: "hi",
  });
  assert.throws(() => readMessage(schema(), "ChatMessage", Buffer.from("ff", "hex")));
});

test("a member's team Dota left out is marked unknown, though the decoder reads it as Radiant", () => {
  // Three members as the GC may send them: team 0 on the wire, no team, team 4.
  const member = (id, team) => {
    const w = protobuf.Writer.create().uint32(9).fixed64(protobuf.util.Long.fromString(id, true));
    if (team !== undefined) w.uint32(24).int32(team);
    return w.finish();
  };
  const w = protobuf.Writer.create().uint32(8).uint64(protobuf.util.Long.fromString("123456789012345678", true));
  for (const m of [member("76561198000000010", 0), member("76561198000000011"), member("76561198000000012", 4)])
    w.uint32(962).bytes(m);
  const bytes = w.finish();
  const lobby = protos.CSODOTALobby.decode(bytes);
  assert.deepEqual(lobby.allMembers.map((m) => m.team), [0, 0, 4]);
  assert.deepEqual(membersTeamOnWire(bytes), [true, false, true]);
  markWireTeams(lobby, bytes);
  assert.deepEqual(lobby.allMembers.map((m) => m.teamOnWire), [true, false, true]);
  // Bytes it can't read: every member unknown, so nobody is moved.
  const broken = protos.CSODOTALobby.decode(bytes);
  markWireTeams(broken, Buffer.concat([bytes, Buffer.from("fa0705", "hex")]));
  assert.deepEqual(broken.allMembers.map((m) => m.teamOnWire), [false, false, false]);
  // Bytes that don't line up with the decoded members: all unknown too.
  const extra = protos.CSODOTALobby.decode(bytes);
  extra.allMembers.push({ id: "76561198000000013", team: 0 });
  markWireTeams(extra, bytes);
  assert.deepEqual(extra.allMembers.map((m) => m.teamOnWire), [false, false, false, false]);
  // Only a varint field 3 is a team: one of another wire type (here bytes)
  // is not, so that member reads unknown.
  const odd = protobuf.Writer.create()
    .uint32(9)
    .fixed64(protobuf.util.Long.fromString("76561198000000014", true))
    .uint32(26)
    .bytes(Buffer.from([0]))
    .finish();
  const withOdd = protobuf.Writer.create().uint32(962).bytes(member("76561198000000010", 0)).uint32(962).bytes(odd).finish();
  assert.deepEqual(membersTeamOnWire(withOdd), [true, false]);
});

test("server.mjs moves players only with KickFromTeam and the swap, and never seats, kicks out or shuffles", () => {
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /kickFromTeam: \(steamId\) =>\s*send\(8047, "KickFromTeam", \{ accountId: accountIdOf\(steamId\) \}\)/);
  assert.match(server, /flipTeams: \(\) => send\(7320, "Empty"\)/);
  // Kick (7081) removes from the lobby; BalancedShuffle (7188) and
  // SetTeamSlot (7047) are never the bot's to send.
  assert.doesNotMatch(server, /\bsend\w*\(\s*(?:7081|7188|7047)\b|k_EMsgGCPracticeLobbyKick\b|k_EMsgGCBalancedShuffleLobby|k_EMsgGCPracticeLobbySetTeamSlot/);
  // Every command goes through send() or the invite's sendPartial.
  const commands = [...server.matchAll(/\bsend\((\d+),/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  assert.deepEqual([...new Set(commands)], [7009, 7035, 7038, 7040, 7041, 7273, 7320, 8047]);
  // Every lobby snapshot carries which teams Dota sent.
  assert.match(server, /controller\.snapshot\(markWireTeams\(CSODOTALobby\.decode\(obj\.objectData\), obj\.objectData\)\)/);
  // The chat answers reach the controller, and the chat clock never throws.
  assert.match(server, /k_EMsgGCJoinChatChannelResponse\) \{[\s\S]*?controller\.chatJoined\(joined\)/);
  assert.match(server, /function runChat\(\) \{\s*try \{\s*controller\.pumpChat\(true\);\s*\} catch \{/);
  assert.match(server, /later: \(ms\) => setTimeout\(runChat, ms\)\.unref\(\)/);
  assert.match(server, /user\.on\("accountLimitations"/);
});

// ---- Early leave (controller.mjs leaveEarly, detailsClock) ----

test("early leave sends CMsgAbandonCurrentGame (7035, no fields) through send(), and only from the transport", () => {
  assert.equal(protos.EDOTAGCMsg.k_EMsgGCAbandonCurrentGame, 7035);
  assert.equal(encode("AbandonCurrentGame", {}), "");
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /abandon: \(\) => send\(7035, "AbandonCurrentGame"\)/);
  // Off unless DOTA_BOT_EARLY_LEAVE lists a kind, parsed before Steam starts.
  assert.match(server, /const earlyLeave = earlyLeaveKinds\(process\.env\.DOTA_BOT_EARLY_LEAVE\);/);
  assert.match(server, /earlyLeaveKinds: earlyLeave,/);
});

test("a match-details request is GC 7095 carrying the uint64 match id, and its answer decodes the outcome", () => {
  assert.equal(protos.EDOTAGCMsg.k_EMsgGCMatchDetailsRequest, 7095);
  assert.equal(protos.EDOTAGCMsg.k_EMsgGCMatchDetailsResponse, 7096);
  const user = new SteamUser({ dataDirectory: null });
  const dota = new Dota2User(user);
  user.steamID = { getSteamID64: () => "76561198000000099" };
  let sent;
  user.sendToGC = (...args) => {
    sent = args;
  };
  dota.sendPartial(protos.EDOTAGCMsg.k_EMsgGCMatchDetailsRequest, { matchId: "9050201642" });
  assert.equal(sent[0], 570);
  assert.equal(sent[1], 7095);
  // Field 1, varint 9050201642.
  assert.equal(protos.CMsgGCMatchDetailsRequest.decode(Buffer.from(sent[3])).matchId, "9050201642");
  // The answer: result 1 (OK), the match with its id as a string and the outcome.
  const answer = protos.CMsgGCMatchDetailsResponse.encode(
    protos.CMsgGCMatchDetailsResponse.fromPartial({ result: 1, match: { matchId: "9050201642", matchOutcome: 2 } }),
  ).finish();
  const decoded = protos.CMsgGCMatchDetailsResponse.decode(answer);
  assert.equal(decoded.result, 1);
  assert.equal(decoded.match.matchId, "9050201642");
  assert.equal(decoded.match.matchOutcome, 2);
  // The installed router decodes it for server.mjs's handler.
  let routed;
  dota.router.on(protos.EDOTAGCMsg.k_EMsgGCMatchDetailsResponse, (message) => {
    routed = message;
  });
  dota.router.route(7096, Buffer.from(answer));
  assert.equal(routed.match.matchOutcome, 2);
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /matchDetails: \(matchId\) =>\s*dota\.sendPartial\(protos\.EDOTAGCMsg\.k_EMsgGCMatchDetailsRequest, \{ matchId \}\)/);
  assert.match(server, /k_EMsgGCMatchDetailsResponse, \(answer\) => \{\s*try \{\s*controller\.matchDetails\(answer\);\s*\} catch \{/);
});

test("the lobby's game state is DOTA_GameState: early leave's states are the hero draft to the horn", () => {
  const states = protos.DOTAGameState;
  assert.deepEqual(
    EARLY_LEAVE_GAME_STATES,
    [
      states.DOTA_GAMERULES_STATE_HERO_SELECTION,
      states.DOTA_GAMERULES_STATE_STRATEGY_TIME,
      states.DOTA_GAMERULES_STATE_PRE_GAME,
      states.DOTA_GAMERULES_STATE_GAME_IN_PROGRESS,
      states.DOTA_GAMERULES_STATE_TEAM_SHOWCASE,
    ],
  );
  assert.equal(states.DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD, 1);
  assert.equal(states.DOTA_GAMERULES_STATE_POST_GAME, 6);
  const lobby = protos.CSODOTALobby.decode(protos.CSODOTALobby.encode(protos.CSODOTALobby.create({ lobbyId: "1", gameState: 5 })).finish());
  assert.equal(lobby.gameState, 5);
  // Left out on the wire, it decodes as 0: never "under way".
  assert.equal(protos.CSODOTALobby.decode(protos.CSODOTALobby.encode(protos.CSODOTALobby.create({ lobbyId: "1" })).finish()).gameState, 0);
});
