// One line per bot event: "<ISO time> [dota-bot] <event> key=value ...".
//
// Only the field names below are written, and only as booleans, finite
// numbers or short plain tokens (job keys, lobby and match ids, states,
// reasons). Anything else is dropped or masked, so a lobby's name or password,
// a player's Steam ID, a token or a secret can never reach the log by
// accident: no call site may pass them, and a field this list doesn't name
// is never printed.
const FIELDS = new Set([
  "action",
  "activeKey",
  "activeState",
  "code",
  "complete",
  "count",
  "dir",
  "from",
  "gameState",
  "invited",
  "key",
  "lobby",
  "lobbyId",
  "lobbyState",
  "matchId",
  "members",
  "mine",
  "ms",
  "n",
  "outcome",
  "over",
  "owner",
  "players",
  "reason",
  "releasing",
  "result",
  "source",
  "to",
  "type",
]);
const TOKEN = /^[A-Za-z0-9_:.-]{1,160}$/;

function value(raw) {
  if (raw === null) return "none";
  if (typeof raw === "boolean") return String(raw);
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : "?";
  if (typeof raw === "string" && TOKEN.test(raw)) return raw;
  return "?";
}

export function formatEvent(event, fields = {}, at = new Date()) {
  const parts = [`${at.toISOString()} [dota-bot] ${TOKEN.test(event) ? event : "event"}`];
  for (const [name, raw] of Object.entries(fields ?? {}))
    if (FIELDS.has(name) && raw !== undefined) parts.push(`${name}=${value(raw)}`);
  return parts.join(" ");
}

/** A fixed operator message with the same timestamp prefix as the events. */
export function stamp(message, at = new Date()) {
  return `${at.toISOString()} ${message}`;
}

/** The opt-in GC trace (DOTA_BOT_GC_LOG=1): steam-user's own "Sending 570 GC
 * message 7040" / "Received 570 GC message 26" debug lines, reduced to a
 * direction and a message type. Every other debug line (some carry session
 * or license data) gives null and is never written. */
export function gcMessageEvent(message) {
  const match = typeof message === "string" && /^(Sending|Received) 570 GC message (\d{1,7})$/.exec(message);
  return match ? { dir: match[1] === "Sending" ? "out" : "in", type: Number(match[2]) } : null;
}

/** The bot's logger. A write that throws never stops the bot. */
export function eventLog({ write = console.log, clock = () => new Date() } = {}) {
  return (event, fields) => {
    try {
      write(formatEvent(event, fields, clock()));
    } catch {
      // Logging is best-effort.
    }
  };
}
