import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import SteamUser from "steam-user";
import { Dota2User } from "dota2-user";
import protos from "dota2-user/protobufs/index.js";
import protobuf from "protobufjs";
import { LobbyController, BotError, LEAVE_CONFIRM_MS } from "./controller.mjs";
import { eventLog, gcMessageEvent, stamp } from "./event-log.mjs";
import { gcResync } from "./gc-resync.mjs";
import { readSteamAuth, writeSteamAuth } from "./auth-store.mjs";
import { RelayClient, relayConnection } from "./relay-client.mjs";
import { runWithProcessLock } from "./process-lock.mjs";
import { gameServerRegions } from "./region.mjs";
import { earlyLeaveKinds } from "./lobby-kind.mjs";
import { lobbyHealth } from "./health.mjs";
import { offlineWatchdog, OFFLINE_RESTART_MS } from "./watchdog.mjs";
import { accountIdOf, lobbyChannelName, LOBBY_CHANNEL_TYPE, markWireTeams, readMessage } from "./lobby-wire.mjs";

// Timestamped, secret-free lines (event-log.mjs). launchd's log files carry
// no time of their own; journald adds one, and these read the same either way.
const log = eventLog();
const say = (message) => console.log(stamp(message));
const warn = (message) => console.error(stamp(message));

const serverRegions = gameServerRegions(process.env.DOTA_GAME_SERVER_REGIONS, process.env.DOTA_GAME_SERVER_REGION);
// Off unless listed: "duel", or "duel,inhouse,season" (docs/DOTA-LOBBY-BOT.md,
// Early leave). An unknown kind stops startup.
const earlyLeave = earlyLeaveKinds(process.env.DOTA_BOT_EARLY_LEAVE);
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
// A resync cycles the Game Coordinator session (gc-resync.mjs); the welcome
// handler below settles it, and no welcome in 30 s exits for a restart.
const resync = gcResync({
  user,
  stopped: () => steamStopped,
  noWelcome: () => {
    warn("[dota-bot] No Game Coordinator welcome 30 seconds after a resync; exiting so the service restarts.");
    exitForRestart();
  },
});
const controller = new LobbyController({
  serverRegions,
  earlyLeaveKinds: earlyLeave,
  log,
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
    // The clock runs again just past the Leave's confirmation deadline, so an
    // unconfirmed Leave resyncs in about 20 s, not at the next 30 s tick.
    leave: () => {
      send(7040, "Empty");
      setTimeout(runClock, LEAVE_CONFIRM_MS + 1000).unref();
    },
    resync: () => resync.start(),
    // Early leave (DOTA_BOT_EARLY_LEAVE): CMsgAbandonCurrentGame (7035, no
    // fields), sent just before the Leave above, once a game is under way.
    abandon: () => send(7035, "AbandonCurrentGame"),
    // A game the bot left early: its details, for the end it can't see.
    // Dota2User's own encoder, like the invite (the match id is a uint64).
    matchDetails: (matchId) =>
      dota.sendPartial(protos.EDOTAGCMsg.k_EMsgGCMatchDetailsRequest, { matchId }),
    removeBotFromTeam: () =>
      send(8047, "KickFromTeam", { accountId: user.steamID.accountid }),
    // Dota2User's own encoder: the fixed64 Steam ID goes as a string, and
    // sendPartial fills the client version that send() would leave undefined.
    invite: (steamId) =>
      dota.sendPartial(protos.EGCBaseMsg.k_EMsgGCInviteToLobby, { steamId }),
    // Seat help (seat-help.mjs), inhouse lobbies only. KickFromTeam sends a
    // player back to the unassigned pool; it never removes anyone from the
    // lobby (that is Kick, 7081, which the bot never sends).
    kickFromTeam: (steamId) =>
      send(8047, "KickFromTeam", { accountId: accountIdOf(steamId) }),
    flipTeams: () => send(7320, "Empty"),
    joinChat: (lobbyId) =>
      send(7009, "JoinChatChannel", {
        channelName: lobbyChannelName(lobbyId),
        channelType: LOBBY_CHANNEL_TYPE,
      }),
    chat: (channelId, text) =>
      send(7273, "ChatMessage", {
        channelId: protobuf.util.Long.fromString(channelId, true),
        text,
      }),
    // The next chat line's turn (at most one every 5 s).
    later: (ms) => setTimeout(runChat, ms).unref(),
  },
});
function runChat() {
  try {
    controller.pumpChat(true);
  } catch {
    // Chat is best-effort and never stops the worker.
  }
}

function control(request) {
  try {
    const { action, spec } = request;
    const at = controller.now();
    if (action === "active") {
      const key = controller.data.active ?? null;
      controller.logAnswer("active", null, { activeKey: key }, at);
      return { status: 200, body: { key } };
    }
    if (action === "health") {
      const body = lobbyHealth(controller, user.steamID?.getSteamID64());
      // Never the Steam ID it carries.
      controller.logAnswer("health", null, {
        result: body.online ? "online" : "offline",
        activeKey: body.activeKey,
        lobbyId: body.lobbyId,
      }, at);
      return { status: 200, body };
    }
    // handle() logs each answer (event-log.mjs): never the spec itself.
    return { status: 200, body: controller.handle(action, spec) };
  } catch (error) {
    return { status: error instanceof BotError ? 409 : 400, body: { code: error instanceof BotError ? error.code : "INVALID" } };
  }
}
const relay = new RelayClient({
  connection: relayConnection(process.env.DOTA_LOBBY_RELAY_URL, process.env.DOTA_RELAY_WORKER_SECRET, process.env.NODE_ENV !== "production"),
  handle: control,
  log: say,
});

const { ESOMsg, EGCBaseClientMsg, EGCBaseMsg, EDOTAGCMsg, CSODOTALobby } = protos;
const LOBBY_TYPE_ID = 2004;
let steamStopped = false;
let pendingRefreshToken;
function stopSteam(message) {
  steamStopped = true;
  controller.online = false;
  pendingRefreshToken = undefined;
  warn(message);
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
  if (
    obj.typeId === LOBBY_TYPE_ID &&
    // Which members' team Dota actually sent: the decoder reads a missing
    // one as Radiant, and the seat help never acts on that.
    controller.snapshot(markWireTeams(CSODOTALobby.decode(obj.objectData), obj.objectData))
  )
    say("[dota-bot] Launch came back to the lobby screen without a game; releasing the bot");
}
function subscribed(cache) {
  for (const object of cache.objects ?? []) {
    for (const objectData of object.objectData ?? [])
      objectUpdate({ typeId: object.typeId, objectData });
  }
}
function removed(obj, source) {
  if (obj.typeId !== LOBBY_TYPE_ID) return;
  const removedLobby = CSODOTALobby.decode(obj.objectData);
  if (!controller.lobby || removedLobby.lobbyId === controller.lobby.lobbyId)
    controller.departed(source);
}
dota.router.on(EGCBaseClientMsg.k_EMsgGCClientWelcome, (welcome) => {
  if (steamStopped) return;
  resync.welcomed();
  // Forget the lobby: the welcome's replay is the truth.
  controller.welcoming();
  for (const cache of welcome.outofdateSubscribedCaches ?? [])
    subscribed(cache);
  const freed = controller.welcomed(
    (welcome.uptodateSubscribedCaches ?? []).length === 0,
  );
  controller.online = true;
  say("[dota-bot] Game Coordinator connected");
  if (freed)
    say("[dota-bot] Reconnected in no lobby; free for the next one");
});
dota.router.on(ESOMsg.k_ESOMsg_CacheSubscribed, subscribed);
dota.router.on(ESOMsg.k_ESOMsg_Create, objectUpdate);
// The published Dota2User router omits the single-object Update mapping, and
// it never routes the GC's answer to a lobby invite.
user.on("receivedFromGC", (appid, type, payload) => {
  if (appid === 570 && type === ESOMsg.k_ESOMsg_Update)
    objectUpdate(protos.CMsgSOSingleObject.decode(payload));
  if (appid === 570 && type === EGCBaseMsg.k_EMsgGCInvitationCreated) {
    let created;
    try {
      created = protos.CMsgInvitationCreated.decode(payload);
    } catch {
      return warn("[dota-bot] Unreadable lobby invite answer from the Game Coordinator");
    }
    say(`[dota-bot] Lobby invite created${created.userOffline ? " (player offline)" : ""}`);
    controller.inviteCreated(created.steamId, created.userOffline);
  }
  // Nor the chat answers, which Dota2User has no decoders for.
  if (appid === 570 && type === EDOTAGCMsg.k_EMsgGCJoinChatChannelResponse) {
    let joined;
    try {
      joined = readMessage(schema, "JoinChatChannelResponse", payload);
    } catch {
      return warn("[dota-bot] Unreadable chat join answer from the Game Coordinator");
    }
    try {
      controller.chatJoined(joined);
    } catch {
      // Chat is best-effort and never stops the worker.
    }
  }
  if (appid === 570 && type === EDOTAGCMsg.k_EMsgGCChatMessage) {
    // Only the bot's own line coming back: proof its chat reaches the lobby.
    // Players' lines are never kept or logged.
    try {
      const line = readMessage(schema, "ChatMessage", payload);
      if (line.accountId === user.steamID?.accountid) controller.chatSeen(line.channelId);
    } catch {
      // Unreadable, or nothing to do with the bot.
    }
  }
});
// The Game Coordinator's answer to a host command (node-dota2 reads it for a
// kick from a team or a swap): its result only, logged when it isn't OK (1).
dota.router.on(EDOTAGCMsg.k_EMsgGCPracticeLobbyResponse, (answer) => {
  if (answer?.eresult !== 1) log("lobby-refused", { result: answer?.eresult ?? null });
});
// A limited Steam account (under US$5 spent) may be unable to chat: logged
// once a run and on any change, so a silent lobby chat has its likely reason.
let limitedLogged;
user.on("accountLimitations", (limited) => {
  if (limitedLogged === !!limited) return;
  limitedLogged = !!limited;
  log("account", { limited: !!limited });
});
// The answer to a match-details request for a game the bot left early.
dota.router.on(EDOTAGCMsg.k_EMsgGCMatchDetailsResponse, (answer) => {
  try {
    controller.matchDetails(answer);
  } catch {
    // Unreadable or late: the next ask, or the site's OpenDota result, covers it.
  }
});
dota.router.on(ESOMsg.k_ESOMsg_Destroy, (obj) => removed(obj, "destroy"));
dota.router.on(ESOMsg.k_ESOMsg_UpdateMultiple, (update) => {
  for (const obj of [...update.objectsAdded, ...update.objectsModified])
    objectUpdate(obj);
  for (const obj of update.objectsRemoved) removed(obj, "removed");
});
dota.router.on(ESOMsg.k_ESOMsg_CacheUnsubscribed, (cache) => {
  if (controller.lobby && cache.ownerSoid?.id === controller.lobby.lobbyId)
    controller.departed("unsubscribed");
  // Only the owner's type: its id can be the bot's own Steam ID.
  else log("unsubscribed-other", { owner: cache.ownerSoid?.type ?? null });
});
// The opt-in GC trace: message types only, never a payload (event-log.mjs).
if (process.env.DOTA_BOT_GC_LOG === "1")
  user.on("debug", (message) => {
    const event = gcMessageEvent(message);
    if (event) log("gc-message", event);
  });
dota.on("disconnectedFromGC", () => {
  controller.online = false;
  say("[dota-bot] Game Coordinator disconnected");
});
user.on("disconnected", (eresult) => {
  controller.online = false;
  say(`[dota-bot] Steam disconnected (result ${eresult}); waiting for automatic reconnect`);
});
user.on("error", () => {
  controller.online = false;
  warn(
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
    warn(
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
    log("request", { code: "INVALID", reason: "unreadable-body" });
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
  () => say("[dota-bot] Control service listening"),
);
relay.start();
// A Launch Dota never shows, and a lobby nobody starts, are released on a
// clock (controller.tick), so neither can hold the one bot for good. The same
// clock resyncs a Leave Dota never confirmed.
function runClock() {
  try {
    if (controller.tick())
      say("[dota-bot] Released a lobby that was not going to start");
  } catch {
    // A send that throws (Steam dropping) must never kill the worker.
    warn("[dota-bot] Lobby clock check failed; trying again in 30 seconds");
  }
}
setInterval(runClock, 30_000).unref();
// Exit non-zero so launchd/systemd start a fresh process with a fresh Steam
// session: after a stalled reconnect (watchdog.mjs) or a resync no welcome
// answered.
let exiting = false;
function exitForRestart() {
  if (exiting) return;
  exiting = true;
  controller.online = false;
  relay.stop();
  user.logOff();
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 3000).unref();
}
// A dropped Steam connection that never recovers leaves a live, silent, offline
// process. Exit non-zero so launchd/systemd start a fresh one (see watchdog.mjs).
const offlineTooLong = offlineWatchdog();
setInterval(() => {
  if (!offlineTooLong({ online: controller.online, stopped: steamStopped })) return;
  warn(`[dota-bot] Offline for ${OFFLINE_RESTART_MS / 60_000} minutes after losing Steam; exiting so the service restarts.`);
  exitForRestart();
}, 30_000).unref();
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
