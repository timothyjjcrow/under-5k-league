// Seat help for an inhouse lobby (Tim's call, 2026-10-18): Dota can't seat a
// player for the host (SetTeamSlot carries no account id), so the bot sends
// each player who sits on the wrong side back to the unassigned pool, swaps
// the sides once when the whole roster sits mirrored, sends strangers off the
// teams, and says in the lobby's chat where to go. Pure decisions only: the
// controller records, saves, then sends.

// At least this long between two moves of one player (or two swaps), at most
// this many moves of one player and swaps per job, so a player who keeps
// picking the wrong side (or a stranger) is never moved in a loop.
export const SEAT_FIX_GAP_MS = 30_000;
export const SEAT_KICK_MAX_PER_PLAYER = 3;
export const SEAT_FLIP_MAX_PER_JOB = 2;
// Lobby chat: one line every 5 s at most, and a move's line not sent within
// 30 s dropped. A line about a player comes only with their greeting (once a
// job) or a move of theirs (at most one every 30 s, SEAT_FIX_GAP_MS). A join
// Dota doesn't answer in 30 s may be tried once more; two in all per job,
// then the job goes quiet.
export const CHAT_LINE_GAP_MS = 5_000;
export const CHAT_STALE_MS = 30_000;
export const CHAT_JOIN_TIMEOUT_MS = 30_000;
export const CHAT_MAX_JOINS = 2;
export const CHAT_QUEUE_MAX = 8;
// A drafted player is greeted once they have been in the lobby this long:
// Dota's lobby chat keeps no history, so a line sent before their client has
// joined the channel never reaches them, and players who arrive together
// share one line.
export const CHAT_GREET_SETTLE_MS = 3_000;
// A Steam persona name's length (the site's LOBBY_CHAT_NAME_MAX), counted in
// whole characters as they show (an emoji with its joiners, a flag, a skin
// tone is one), and never more than this many UTF-16 units in all.
export const CHAT_NAME_MAX = 32;
export const CHAT_NAME_MAX_UNITS = 64;
// Dota's own chat box takes about this many characters.
export const CHAT_LINE_MAX = 127;

// GC team enums: 0 GOOD_GUYS (Radiant), 1 BAD_GUYS (Dire). 2 broadcaster, 3
// spectator, 4 player pool and 5 no team are left alone.
const SIDE_NAMES = ["Radiant", "Dire"];
const NO_COACH = 5;

const INHOUSE_KEY = /^(?:eu:)?inhouse:/;

/** Seat help is for inhouse games only: a season game's late stand-in isn't
 * on the job's roster. */
export const seatHelpKey = (key) => typeof key === "string" && INHOUSE_KEY.test(key);

// Control, format, surrogate, private-use and unassigned characters go
// (zero-width spaces, bidi overrides and isolates among them), except what a
// name needs to show as typed: the zero-width joiner of an emoji sequence or
// the non-joiner of a Persian or Indic name (U+200D, U+200C), and the tag
// characters of a flag such as England's.
const STRIP = /(?![\u200c\u200d\u{e0020}-\u{e007f}])\p{C}/gu;
// Joiners at either end join nothing (a flag's tags at the end stay).
const EDGES = /^[\s\u200c\u200d]+|[\s\u200c\u200d]+$/gu;
// Joiners and tags alone show nothing.
const VISIBLE = /[^\s\u200c\u200d\u{e0020}-\u{e007f}]/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** A name fit for one chat line: whitespace (newlines and tabs too) as one
 * space, control and format characters (zero-width spaces, bidi overrides)
 * gone, and at most CHAT_NAME_MAX characters as they show, cut between two
 * of them, never inside an emoji or a flag (and CHAT_NAME_MAX_UNITS UTF-16
 * units). Anything else, or nothing visible, gives undefined. */
export function sanitizeName(raw) {
  if (typeof raw !== "string") return undefined;
  const clean = raw
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .replace(STRIP, "")
    .replace(/ {2,}/g, " ")
    .replace(EDGES, "");
  let capped = "";
  let shown = 0;
  for (const { segment } of graphemes.segment(clean)) {
    if (shown === CHAT_NAME_MAX || capped.length + segment.length > CHAT_NAME_MAX_UNITS) break;
    capped += segment;
    shown += 1;
  }
  capped = capped.replace(EDGES, "");
  return VISIBLE.test(capped) ? capped : undefined;
}

const roster = (spec) => [...new Set([...(spec?.radiant ?? []), ...(spec?.dire ?? [])])];

/** The roster's display names from the site's optional spec fields: `names`
 * (Steam64 ID to name) or `radiantNames` / `direNames` (one per ID of that
 * side, in order; a list of another length is ignored). Only roster IDs;
 * `names` wins. Never required: a spec without them gets the plain lines. */
export function rosterNames(spec) {
  const out = new Map();
  const players = roster(spec);
  // Every id here comes from the roster: the map is read by roster id, and
  // a list by its side's index.
  const add = (id, raw) => {
    const name = sanitizeName(raw);
    if (name && !out.has(id)) out.set(id, name);
  };
  const names = spec?.names;
  if (names && typeof names === "object" && !Array.isArray(names))
    for (const id of players) if (Object.hasOwn(names, id)) add(id, names[id]);
  for (const [ids, list] of [[spec?.radiant, spec?.radiantNames], [spec?.dire, spec?.direNames]])
    if (Array.isArray(ids) && Array.isArray(list) && list.length === ids.length)
      ids.forEach((id, i) => add(id, list[i]));
  return out;
}

/** "Radiant: Sam, Lee, Ash. Take a Radiant slot.", fitted to one chat line
 * ("+2 more" for names that don't fit), or the plain line with no names. */
function sideLine(side, ids, names) {
  const sideName = SIDE_NAMES[side];
  const tail = `. Take a ${sideName} slot.`;
  const known = ids.map((id) => names.get(id)).filter(Boolean);
  if (!known.length) return `${sideName} players: take a ${sideName} slot.`;
  let list = "";
  let shown = 0;
  for (const name of known) {
    const next = shown ? `${list}, ${name}` : name;
    const rest = ids.length - shown - 1;
    const more = rest > 0 ? ` +${rest} more` : "";
    if (`${sideName}: ${next}${more}${tail}`.length > CHAT_LINE_MAX) break;
    list = next;
    shown += 1;
  }
  const rest = ids.length - shown;
  return `${sideName}: ${list}${rest > 0 ? `${shown ? " " : ""}+${rest} more` : ""}${tail}`;
}

const personalLine = (side, name) => `${name}: you're on ${SIDE_NAMES[side]}. Take a ${SIDE_NAMES[side]} slot.`;

/** The greeting for drafted players of one side who just arrived: "Sam:
 * you're on Radiant. Take a Radiant slot." for one, "Radiant: Sam, Lee. Take
 * a Radiant slot." for more, or the plain side line with no names. */
export function greetLine(side, ids, names) {
  if (ids.length === 1 && names.has(ids[0])) return personalLine(side, names.get(ids[0]));
  return sideLine(side, ids, names);
}

/** What the bot says when it moved someone, or swapped the sides. */
export function moveLine(why, side, name) {
  if (why === "flip") return "Both teams sat on the wrong sides, so I swapped Radiant and Dire.";
  if (why === "stranger") return "That seat is for a drafted player, so you were moved to unassigned.";
  const sideName = SIDE_NAMES[side];
  return name ? personalLine(side, name) : `Moved a ${sideName} player to unassigned. Take a ${sideName} slot.`;
}

const onSide = (m) => m.team === 0 || m.team === 1;
const coaching = (m) => m.coachTeam !== undefined && m.coachTeam !== NO_COACH;
// A team the decoder filled in (server.mjs marks what was on the wire).
const teamKnown = (m) => m.teamOnWire !== false;

/** Every roster player seated on the opposite side and nobody else on a
 * side: one swap fixes it. Ten distinct players, five a side. */
export function mirrored(members, spec) {
  const radiant = members.filter((m) => m.team === 0).map((m) => m.id);
  const dire = members.filter((m) => m.team === 1).map((m) => m.id);
  return (
    spec.radiant.length === 5 &&
    spec.dire.length === 5 &&
    new Set([...spec.radiant, ...spec.dire]).size === 10 &&
    radiant.length === 5 &&
    dire.length === 5 &&
    spec.dire.every((id) => radiant.includes(id)) &&
    spec.radiant.every((id) => dire.includes(id))
  );
}

/**
 * What to do about the lobby's seats now. `members` are its current members;
 * `flips` and `kicks` are the job's saved records. Returns:
 * - `flip`: swap the sides (a mirrored roster, swaps left, the last one
 *   30 s or more ago, nobody's team unknown, the bot on no side);
 * - `kicks`: the members to send back to the unassigned pool, each a roster
 *   player on the other side (`side`) or a stranger on a side (`stranger`),
 *   within the per-player limits. None while a swap is under 30 s old (its
 *   result may not have arrived yet) or one is due;
 * - `unknown`: how many members' team the decoder filled in (never acted on).
 * The bot itself, coaches, spectators, broadcasters, the pool and the
 * unknown are never touched.
 */
export function seatPlan({ members, spec, bot, now, flips = {}, kicks = {} }) {
  const others = members.filter((m) => m.id !== bot);
  const unknown = others.filter((m) => !teamKnown(m)).length;
  const botOnSide = members.some((m) => m.id === bot && onSide(m));
  const plan = { flip: false, kicks: [], unknown };
  if (flips.at !== undefined && now - flips.at < SEAT_FIX_GAP_MS) return plan;
  if (
    mirrored(others, spec) &&
    unknown === 0 &&
    !botOnSide &&
    !others.some(coaching) &&
    (flips.count ?? 0) < SEAT_FLIP_MAX_PER_JOB
  ) {
    plan.flip = true;
    return plan;
  }
  const radiant = new Set(spec.radiant);
  const dire = new Set(spec.dire);
  for (const m of others) {
    if (!onSide(m) || coaching(m) || !teamKnown(m)) continue;
    const inRadiant = radiant.has(m.id);
    const inDire = dire.has(m.id);
    // On both sides of the spec: either side is right.
    if (inRadiant && inDire) continue;
    const side = inRadiant ? 0 : inDire ? 1 : undefined;
    const why = side === undefined ? "stranger" : side !== m.team ? "side" : null;
    if (!why) continue;
    const last = kicks[m.id];
    if (last && (now - last.at < SEAT_FIX_GAP_MS || last.count >= SEAT_KICK_MAX_PER_PLAYER)) continue;
    plan.kicks.push({ id: m.id, why, side });
  }
  return plan;
}

/**
 * Who to greet now. `members` are the lobby's current members, `greeted`
 * the job's saved greetings (Steam64 ID to when), and `seen` when each member
 * was first seen in the lobby this time (in memory). Due: a drafted player in
 * the lobby, off the sides (the unassigned pool, or a spectator or caster
 * slot), never greeted, seen CHAT_GREET_SETTLE_MS or more ago. Returns `due`
 * (the side of whoever has waited longest, and that side's due players in
 * roster order, for one line) or null, and `wait`: the ms until the next one
 * is due, when one is still settling. Only the roster is greeted (never a
 * stranger, nor the bot, which is on no roster), and never a coach, a player
 * already seated (a wrong side gets a move and its own line) or one whose
 * team Dota left out. A player on both of the spec's sides has no one side
 * to be told.
 */
export function greeting({ members, spec, now, seen, greeted = {} }) {
  const radiant = new Set(spec.radiant);
  const dire = new Set(spec.dire);
  const ready = [];
  let wait;
  for (const m of members) {
    if (Object.hasOwn(greeted, m.id) || onSide(m) || coaching(m) || !teamKnown(m)) continue;
    const inRadiant = radiant.has(m.id);
    if (inRadiant === dire.has(m.id)) continue;
    const since = seen.get(m.id);
    if (since === undefined) continue;
    const left = CHAT_GREET_SETTLE_MS - (now - since);
    if (left > 0) wait = Math.min(wait ?? left, left);
    else ready.push({ id: m.id, side: inRadiant ? 0 : 1, since });
  }
  if (!ready.length) return { due: null, wait };
  const first = ready.reduce((a, b) => (b.since < a.since ? b : a));
  const due = new Set(ready.map((r) => r.id));
  const ids = (first.side === 0 ? spec.radiant : spec.dire).filter((id) => due.has(id));
  return { due: { side: first.side, ids }, wait };
}
