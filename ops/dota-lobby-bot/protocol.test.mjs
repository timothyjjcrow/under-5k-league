import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import SteamUser from "steam-user";
import { Dota2User } from "dota2-user";
import protos from "dota2-user/protobufs/index.js";

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
