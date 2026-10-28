// The three kinds of bot job, read from the job's key: a season game
// (`season:`), a 5v5 inhouse game (`inhouse:`) and a 1v1 mid duel (`duel:`),
// each with Europe's `eu:` namespace. The relay keeps its own copy of the key
// pattern (ops/dota-lobby-relay/src/protocol.mjs); a test pins them equal.

export const KEY_PATTERN = /^(?:eu:)?(season|inhouse|duel):[a-zA-Z0-9_-]{1,128}:[1-9]\d?$/;
export const KINDS = Object.freeze(["season", "inhouse", "duel"]);

// Dota's game modes: Captains Mode for season and inhouse games, 1v1 Solo
// Mid for a duel.
export const CAPTAINS_MODE = 2;
export const SOLO_MID_MODE = 21;

/** The key's kind, or null for anything that isn't a job key. */
export function keyKind(key) {
  const match = typeof key === "string" ? KEY_PATTERN.exec(key) : null;
  return match ? match[1] : null;
}

/** Players a side: one in a duel, five otherwise. */
export const sideSize = (key) => (keyKind(key) === "duel" ? 1 : 5);

/** The game mode a kind's lobby must use. */
export const gameModeFor = (key) => (keyKind(key) === "duel" ? SOLO_MID_MODE : CAPTAINS_MODE);

/**
 * DOTA_BOT_EARLY_LEAVE: the kinds whose launched games the bot leaves once
 * they are under way, as a comma list ("duel", "duel,inhouse,season"). Unset
 * or empty is off for every kind: the bot stays to the postgame, as before
 * early leave existed. An unknown kind stops startup, like a bad region.
 */
export function earlyLeaveKinds(raw) {
  if (raw === undefined || raw === null) return Object.freeze([]);
  if (typeof raw !== "string") throw new Error("Unsupported DOTA_BOT_EARLY_LEAVE");
  const kinds = raw.split(",").map((kind) => kind.trim()).filter(Boolean);
  if (kinds.some((kind) => !KINDS.includes(kind)) || new Set(kinds).size !== kinds.length)
    throw new Error("Unsupported DOTA_BOT_EARLY_LEAVE");
  return Object.freeze(kinds);
}
