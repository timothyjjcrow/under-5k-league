import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import SteamUser from "steam-user";
import { Dota2User } from "dota2-user";
import protos from "dota2-user/protobufs/index.js";
import protobuf from "protobufjs";
import { LobbyController, BotError } from "./controller.mjs";
import { readSteamAuth, writeSteamAuth } from "./auth-store.mjs";
import { RelayClient, relayConnection } from "./relay-client.mjs";
import { runWithProcessLock } from "./process-lock.mjs";
import { gameServerRegion } from "./region.mjs";

const serverRegion = gameServerRegion(process.env.DOTA_GAME_SERVER_REGION);
const secret = process.env.DOTA_LOBBY_BOT_SECRET ?? "";
if (secret.length < 32 || secret.length > 512 || /\s/.test(secret))
  throw new Error(
    "Set DOTA_LOBBY_BOT_SECRET to a random secret of at least 32 characters.",
  );
const stateDir = resolve(process.env.DOTA_BOT_STATE_DIR ?? "./state");
await runWithProcessLock(stateDir);
// Read the session only while holding the same lock as the login helper. This
// prevents a worker from starting with the old account during a new sign-in.
let savedAuth = readSteamAuth(stateDir);
if (!savedAuth && (!process.env.STEAM_BOT_USERNAME || !process.env.STEAM_BOT_PASSWORD))
  throw new Error(
    "Sign in to the dedicated Steam bot account first: run npm run login.",
  );
const user = new SteamUser({
  dataDirectory: resolve(stateDir, "steam"),
  autoRelogin: true,
  renewRefreshTokens: true,
});
const dota = new Dota2User(user);
const schema = protobuf.loadSync(
  fileURLToPath(new URL("./lobby.proto", import.meta.url)),
);
function send(id, type, data = {}) {
  const message = schema.lookupType(type);
  const error = message.verify(data);
  if (error) throw new Error("Invalid lobby protocol payload");
  dota.sendRawBuffer(
    id,
    Buffer.from(message.encode(message.create(data)).finish()),
  );
}
const controller = new LobbyController({
  serverRegion,
  file: resolve(stateDir, "lobbies.json"),
  transport: {
    steamId: () => user.steamID?.getSteamID64(),
    create: (s) =>
      send(7038, "CreateLobby", {
        passKey: s.password,
        lobbyDetails: {
          gameName: s.name,
          passKey: s.password,
          leagueid: s.leagueId,
          gameMode: s.gameMode,
          serverRegion: s.serverRegion,
          allowCheats: false,
          fillWithBots: false,
          allowSpectating: true,
          seriesType: 0,
          dotaTvDelay: 1,
          visibility: 0,
          pauseSetting: 0,
        },
      }),
    start: () => send(7041, "Empty"),
    leave: () => send(7040, "Empty"),
    removeBotFromTeam: () =>
      send(8047, "KickFromTeam", { accountId: user.steamID.accountid }),
  },
});

function control(request) {
  try {
    const { action, spec } = request;
    if (action === "active") return { status: 200, body: { key: controller.data.active ?? null } };
    if (action === "health") return {
      status: 200,
      body: {
        online: controller.online,
        steamId: user.steamID?.getSteamID64() ?? null,
        activeKey: controller.data.active ?? null,
        lobbyId: controller.lobby?.lobbyId ?? null,
        gameMode: controller.lobby?.gameMode ?? null,
        serverRegion: controller.lobby?.serverRegion ?? null,
        configuredServerRegion: serverRegion,
        leagueId: controller.lobby?.leagueid ?? null,
      },
    };
    return { status: 200, body: controller.request(action, spec) };
  } catch (error) {
    return { status: error instanceof BotError ? 409 : 400, body: { code: error instanceof BotError ? error.code : "INVALID" } };
  }
}
const relay = new RelayClient({
  connection: relayConnection(process.env.DOTA_LOBBY_RELAY_URL, process.env.DOTA_RELAY_WORKER_SECRET, process.env.NODE_ENV !== "production"),
  handle: control,
});

const { ESOMsg, EGCBaseClientMsg, CSODOTALobby } = protos;
const LOBBY_TYPE_ID = 2004;
let steamStopped = false;
let pendingRefreshToken;
function stopSteam(message) {
  steamStopped = true;
  controller.online = false;
  pendingRefreshToken = undefined;
  console.error(message);
  user.logOff();
}
function saveRefreshToken(refreshToken, steamId, accountName) {
  try {
    savedAuth = writeSteamAuth(stateDir, { refreshToken, steamId, accountName });
    return true;
  } catch {
    stopSteam("[dota-bot] Could not safely save the Steam session. Stop the worker, check state permissions and run npm run login.");
    return false;
  }
}
function objectUpdate(obj) {
  if (obj.typeId === LOBBY_TYPE_ID)
    controller.snapshot(CSODOTALobby.decode(obj.objectData));
}
function subscribed(cache) {
  for (const object of cache.objects ?? []) {
    for (const objectData of object.objectData ?? [])
      objectUpdate({ typeId: object.typeId, objectData });
  }
}
function removed(obj) {
  if (obj.typeId !== LOBBY_TYPE_ID) return;
  const removedLobby = CSODOTALobby.decode(obj.objectData);
  if (!controller.lobby || removedLobby.lobbyId === controller.lobby.lobbyId)
    controller.departed();
}
dota.router.on(EGCBaseClientMsg.k_EMsgGCClientWelcome, (welcome) => {
  if (steamStopped) return;
  controller.lobby = null;
  for (const cache of welcome.outofdateSubscribedCaches ?? [])
    subscribed(cache);
  controller.absenceConfirmed =
    !controller.lobby && (welcome.uptodateSubscribedCaches ?? []).length === 0;
  controller.online = true;
  console.log("[dota-bot] Game Coordinator connected");
});
dota.router.on(ESOMsg.k_ESOMsg_CacheSubscribed, subscribed);
dota.router.on(ESOMsg.k_ESOMsg_Create, objectUpdate);
// The published Dota2User router omits the single-object Update mapping.
user.on("receivedFromGC", (appid, type, payload) => {
  if (appid === 570 && type === ESOMsg.k_ESOMsg_Update)
    objectUpdate(protos.CMsgSOSingleObject.decode(payload));
});
dota.router.on(ESOMsg.k_ESOMsg_Destroy, removed);
dota.router.on(ESOMsg.k_ESOMsg_UpdateMultiple, (update) => {
  for (const obj of [...update.objectsAdded, ...update.objectsModified])
    objectUpdate(obj);
  for (const obj of update.objectsRemoved) removed(obj);
});
dota.router.on(ESOMsg.k_ESOMsg_CacheUnsubscribed, (cache) => {
  if (controller.lobby && cache.ownerSoid?.id === controller.lobby.lobbyId)
    controller.departed();
});
dota.on("disconnectedFromGC", () => {
  controller.online = false;
});
user.on("disconnected", () => {
  controller.online = false;
});
user.on("error", () => {
  controller.online = false;
  console.error(
    "[dota-bot] Steam login/connection failed; check the bot account and Steam Guard.",
  );
});
user.on("loggedOn", () => {
  if (steamStopped) return user.logOff();
  const steamId = user.steamID?.getSteamID64();
  if (savedAuth && steamId !== savedAuth.steamId)
    return stopSteam("[dota-bot] Steam signed in to an unexpected account. Stop the worker and run npm run login.");
  if (pendingRefreshToken) {
    const token = pendingRefreshToken;
    pendingRefreshToken = undefined;
    if (!saveRefreshToken(token, steamId, process.env.STEAM_BOT_USERNAME)) return;
  }
  user.setPersona(SteamUser.EPersonaState.Online);
  user.gamesPlayed([570], false);
});
user.on("refreshToken", (refreshToken) => {
  if (steamStopped) return;
  if (savedAuth) {
    // Renewal can arrive before loggedOn, so bind to the saved identity instead
    // of depending on user.steamID already being available.
    saveRefreshToken(refreshToken, savedAuth.steamId, savedAuth.accountName);
  } else if (user.steamID) {
    saveRefreshToken(refreshToken, user.steamID.getSteamID64(), process.env.STEAM_BOT_USERNAME);
  } else {
    pendingRefreshToken = refreshToken;
  }
});
user.on("playingState", (blocked) => {
  if (blocked && !steamStopped)
    stopSteam("[dota-bot] This Steam account is playing a game in another session. Close that game or use a dedicated bot account, then restart the worker.");
});
user.on("steamGuard", (_domain, callback, lastCodeWrong) => {
  if (!process.stdin.isTTY) {
    console.error(
      "[dota-bot] Steam Guard required. Run interactively once with the same persistent state directory.",
    );
    process.exitCode = 1;
    user.logOff();
    server.close();
    return;
  }
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  input.question(
    lastCodeWrong ? "Incorrect code. Steam Guard code: " : "Steam Guard code: ",
    (code) => {
      input.close();
      callback(code.trim());
    },
  );
});

const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const reply = (status, body) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return reply(401, { code: "AUTH" });
  if (
    req.url !== "/lobby" ||
    req.method !== "POST" ||
    req.headers["content-type"] !== "application/json"
  )
    return reply(404, { code: "INVALID" });
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) return reply(413, { code: "INVALID" });
      chunks.push(chunk);
    }
    const result = control(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    reply(result.status, result.body);
  } catch (error) {
    reply(error instanceof BotError ? 409 : 400, {
      code: error instanceof BotError ? error.code : "INVALID",
    });
  }
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(
  Number(process.env.PORT ?? 8090),
  process.env.HOST ?? "127.0.0.1",
  () => console.log("[dota-bot] Control service listening"),
);
relay.start();
user.logOn(savedAuth ? {
  refreshToken: savedAuth.refreshToken,
  steamID: savedAuth.steamId,
} : {
  accountName: process.env.STEAM_BOT_USERNAME,
  password: process.env.STEAM_BOT_PASSWORD,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    controller.online = false;
    relay.stop();
    user.logOff();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
