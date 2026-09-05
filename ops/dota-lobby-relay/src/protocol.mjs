export const MAX_BYTES = 8192;
export const REQUEST_TIMEOUT_MS = 10_000;
export const LEASE_MS = 90_000;
export const MAX_PENDING = 64;
export const INSTANCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^(season|inhouse):[a-zA-Z0-9_-]{1,128}:[1-9]\d?$/;
const STATES = new Set(["idle", "creating", "ready", "starting", "started", "blocked", "released"]);
const ERROR_CODES = new Set(["AUTH", "INVALID", "OFFLINE", "BUSY", "STATE", "ROSTER", "SETTINGS"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}
function id(value) {
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
}
function nullableId(value) {
  return value === null || id(value);
}
function nullableKey(value) {
  return value === null || (typeof value === "string" && KEY_PATTERN.test(value));
}
function nullableUint(value) {
  return value === null || (Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
}

export function validControlRequest(value) {
  if (!record(value) || !onlyKeys(value, ["action", "spec"])) return false;
  if (["active", "health"].includes(value.action)) return value.spec === undefined;
  return ["status", "create", "start", "release"].includes(value.action) && record(value.spec);
}

/** Whitelist response shapes so a bot error can never expose its input or secrets. */
export function validReply(value, action) {
  if (!record(value) || !onlyKeys(value, ["id", "status", "body"]) ||
      typeof value.id !== "string" || !INSTANCE_PATTERN.test(value.id) || !record(value.body)) return false;
  const body = value.body;
  if (value.status === 400 || value.status === 409)
    return onlyKeys(body, ["code"]) && ERROR_CODES.has(body.code);
  if (value.status !== 200) return false;
  if (action === "active") return onlyKeys(body, ["key"]) && nullableKey(body.key);
  if (action === "health") {
    return onlyKeys(body, ["online", "steamId", "activeKey", "lobbyId", "gameMode", "serverRegion", "leagueId"]) &&
      typeof body.online === "boolean" && nullableId(body.steamId) && nullableKey(body.activeKey) &&
      nullableId(body.lobbyId) && nullableUint(body.gameMode) && nullableUint(body.serverRegion) && nullableUint(body.leagueId);
  }
  return onlyKeys(body, ["state", "lobbyId", "matchId"]) && STATES.has(body.state) &&
    (body.lobbyId === undefined || id(body.lobbyId)) && (body.matchId === undefined || id(body.matchId));
}

export function leaseAlive(attachment, automaticResponseAt, now) {
  if (!attachment || attachment.retired || !INSTANCE_PATTERN.test(attachment.instance ?? "")) return false;
  const lastSeen = Math.max(attachment.connectedAt ?? 0, attachment.lastMessageAt ?? 0, automaticResponseAt ?? 0);
  return Number.isFinite(lastSeen) && lastSeen <= now && now - lastSeen < LEASE_MS;
}
