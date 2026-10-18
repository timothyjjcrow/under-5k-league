import protobuf from "protobufjs";

// Wire facts the seat help needs that Dota2User's decoders hide. Checked
// against SteamDatabase/GameTracking-Dota2 Protobufs on 2026-10-18.

// A Steam64 ID's low 32 bits are the Dota account id that lobby commands
// such as KickFromTeam (8047) take.
const ACCOUNT_ID_BASE = BigInt("76561197960265728");
const MAX_ACCOUNT_ID = BigInt("4294967295");

/** The Dota account id (uint32) of a Steam64 ID string. Throws on anything
 * that isn't one, so a bad id never reaches the Game Coordinator. */
export function accountIdOf(steamId) {
  if (typeof steamId !== "string" || !/^\d{17}$/.test(steamId))
    throw new Error("Not a Steam64 ID");
  const accountId = BigInt(steamId) - ACCOUNT_ID_BASE;
  if (accountId <= BigInt(0) || accountId > MAX_ACCOUNT_ID)
    throw new Error("Not a Steam64 ID");
  return Number(accountId);
}

// DOTAChatChannelType_t's DOTAChannelType_Lobby.
export const LOBBY_CHANNEL_TYPE = 3;

/** A lobby's chat channel name: "Lobby_<lobby id>", as ValvePython's dota2
 * (features/chat.py, join_lobby_channel) builds it. */
export function lobbyChannelName(lobbyId) {
  return `Lobby_${lobbyId}`;
}

/** Decode a GC message with one of lobby.proto's types: 64-bit ids as
 * decimal strings, and a field Dota left out stays absent (never its
 * default). Throws on bytes that aren't one. */
export function readMessage(schema, type, payload) {
  const message = schema.lookupType(type);
  return message.toObject(message.decode(payload), { longs: String });
}

// CSODOTALobby.all_members is field 120; CSODOTALobbyMember.team is field 3.
const ALL_MEMBERS_FIELD = 120;
const MEMBER_TEAM_FIELD = 3;

/** For each entry of a lobby's all_members, in order: whether its team was on
 * the wire. Dota2User's decoder reads a missing team as 0 (Radiant), which
 * the seat help must never act on. */
export function membersTeamOnWire(bytes) {
  const reader = protobuf.Reader.create(bytes);
  const present = [];
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag >>> 3 === ALL_MEMBERS_FIELD && (tag & 7) === 2) {
      const end = reader.uint32() + reader.pos;
      let team = false;
      while (reader.pos < end) {
        const inner = reader.uint32();
        if (inner >>> 3 === MEMBER_TEAM_FIELD && (inner & 7) === 0) team = true;
        reader.skipType(inner & 7);
      }
      if (reader.pos !== end) throw new Error("Malformed lobby member");
      present.push(team);
    } else reader.skipType(tag & 7);
  }
  return present;
}

/** Mark each decoded member with `teamOnWire`. Bytes it can't read mark
 * every member unknown, so the seat help leaves them all alone. */
export function markWireTeams(lobby, bytes) {
  let present = [];
  try {
    present = membersTeamOnWire(bytes);
  } catch {
    present = [];
  }
  for (const [i, member] of (lobby?.allMembers ?? []).entries())
    member.teamOnWire = present.length === lobby.allMembers.length && present[i] === true;
  return lobby;
}
