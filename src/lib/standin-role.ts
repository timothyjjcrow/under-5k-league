import {
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "./constants";
import { postAuctionWorkOpen } from "./league-lifecycle";

// The Discord "Standin" role (Tim's call, 2026-11-17): every league Discord
// marks the people a captain can call on to cover a seat, and the site keeps
// that role right by itself. This file is the rule and the bookkeeping, pure;
// standin-role-service.ts reads the league and talks to Discord through
// discord-roles.ts.

/** The active season's phase, as the rule needs it. */
export type StandinRoleSeason = {
  status: string;
  /** The season's Draft row status, or null when it has none. */
  draftStatus: string | null;
};

/** One signup in the active season. */
export type StandinRoleSignup = {
  type: string;
  status: string;
  /** Holds a roster seat (or captains a team) this season. */
  rostered: boolean;
};

/**
 * Who holds the Standin role. Only the ACTIVE season counts, and never once
 * it is COMPLETE (the season ended). Within it, an ACTIVE signup with no
 * roster seat holds the role when it is:
 *
 * - a STANDIN signup, in every phase from signups on; or
 * - a PLAYER signup once the auction is done (`postAuctionWorkOpen`: DRAFT
 *   after the auction, the regular season, the playoffs). That is a free
 *   agent, who can cover a seat. Before the auction an unrostered player is
 *   in the draft pool, not a standin.
 *
 * Withdrawn and removed signups never hold it, nor does anyone on a roster:
 * a signing, a draft purchase or a promotion onto a roster takes it away.
 */
export function holdsStandinRole(
  season: StandinRoleSeason | null,
  signup: StandinRoleSignup | null,
): boolean {
  if (!season || !signup) return false;
  if (season.status === SEASON_STATUS.COMPLETE) return false;
  if (signup.status !== REGISTRATION_STATUS.ACTIVE) return false;
  if (signup.rostered) return false;
  if (signup.type === REGISTRATION_TYPE.STANDIN) return true;
  if (signup.type === REGISTRATION_TYPE.PLAYER) {
    return postAuctionWorkOpen(season.status, season.draftStatus);
  }
  return false;
}

/** A signup with the account the role goes on. */
export type StandinRoleEntry = StandinRoleSignup & {
  userId: string;
  /** The OAuth-proven Discord account; null when they haven't linked one. */
  discordId: string | null;
};

export type StandinRoleTargets = {
  /** Discord ids that should hold the role, sorted. */
  holders: string[];
  /** Discord ids of everyone else signed up this season (any status), sorted:
   *  the people the admin sync checks for a role they shouldn't have. */
  others: string[];
  /** Users who should hold it but have no linked Discord. */
  unlinkedUserIds: string[];
  /** How many who should hold it (linked or not) are STANDIN signups; the
   *  rest are free agents. */
  standins: number;
};

/** Apply the rule to every signup of the active season. */
export function standinRoleTargets(
  season: StandinRoleSeason | null,
  entries: StandinRoleEntry[],
): StandinRoleTargets {
  const holders = new Set<string>();
  const others = new Set<string>();
  const unlinked = new Set<string>();
  let standins = 0;
  for (const entry of entries) {
    const holds = holdsStandinRole(season, entry);
    if (holds && entry.type === REGISTRATION_TYPE.STANDIN) standins++;
    if (!entry.discordId) {
      if (holds) unlinked.add(entry.userId);
      continue;
    }
    if (holds) holders.add(entry.discordId);
    else others.add(entry.discordId);
  }
  // A discordId is unique per user and a user signs up once per season, so
  // nobody is in both sets; the delete keeps "holder" winning regardless.
  for (const id of holders) others.delete(id);
  return {
    holders: [...holders].sort(),
    others: [...others].sort(),
    unlinkedUserIds: [...unlinked].sort(),
    standins,
  };
}

// ---------------------------------------------------------------------------
// The ledger: who the site last made sure holds the role.
//
// Automatic passes run after many writes (every admin action, signups,
// withdrawals, the worker), so they must cost no Discord request when nothing
// changed. They compare the rule's answer with the ledger and write only the
// difference. The ledger records the site's own writes, never a reading of
// Discord shown to anyone: a role someone changed by hand in Discord is put
// right by the admin's "Sync Standin role now", which reads every member live
// and rewrites the ledger from what it saw.
// ---------------------------------------------------------------------------

export type StandinRoleLedger = {
  /** The role these entries are about. A different role starts empty. */
  roleId: string;
  /** Discord ids the site gave the role to (or saw holding it). */
  held: string[];
  /** Discord ids that should hold it but weren't in the server when last
   *  tried, with when (epoch ms). Retried after STANDIN_ROLE_AWAY_RETRY_MS. */
  away: Record<string, number>;
};

/**
 * How long a holder who wasn't in the server waits before an automatic pass
 * tries again. Without it every pass would spend one request per absentee;
 * with it a player who joins later gets the role within this window, or at
 * once from the admin's Sync.
 */
export const STANDIN_ROLE_AWAY_RETRY_MS = 6 * 60 * 60_000;

const SNOWFLAKE = /^\d{15,25}$/;

export function emptyStandinRoleLedger(roleId: string): StandinRoleLedger {
  return { roleId, held: [], away: {} };
}

/** Read the stored ledger; anything unreadable, or for another role, is empty. */
export function parseStandinRoleLedger(
  raw: string | null,
  roleId: string,
): StandinRoleLedger {
  if (!raw) return emptyStandinRoleLedger(roleId);
  try {
    const parsed = JSON.parse(raw) as Partial<StandinRoleLedger> | null;
    if (!parsed || parsed.roleId !== roleId) {
      return emptyStandinRoleLedger(roleId);
    }
    const held = Array.isArray(parsed.held)
      ? [...new Set(parsed.held.filter((id) => typeof id === "string" && SNOWFLAKE.test(id)))].sort()
      : [];
    const away: Record<string, number> = {};
    if (parsed.away && typeof parsed.away === "object") {
      for (const [id, at] of Object.entries(parsed.away)) {
        if (SNOWFLAKE.test(id) && typeof at === "number" && Number.isFinite(at)) {
          away[id] = at;
        }
      }
    }
    return { roleId, held, away };
  } catch {
    return emptyStandinRoleLedger(roleId);
  }
}

export function serializeStandinRoleLedger(ledger: StandinRoleLedger): string {
  const away: Record<string, number> = {};
  for (const id of Object.keys(ledger.away).sort()) away[id] = ledger.away[id];
  return JSON.stringify({
    roleId: ledger.roleId,
    held: [...new Set(ledger.held)].sort(),
    away,
  });
}

export type StandinRolePlan = {
  /** Give the role to these. */
  give: string[];
  /** Take it off these. */
  take: string[];
  /** Absentees who no longer need it: forget them, no request. */
  forget: string[];
};

/**
 * What an automatic pass has to do: give the role to holders the ledger
 * doesn't list (an absentee only once its retry is due), take it off ledger
 * entries the rule no longer covers. Empty = nothing to write anywhere.
 */
export function standinRolePlan(
  holders: string[],
  ledger: StandinRoleLedger,
  nowMs: number,
): StandinRolePlan {
  const want = new Set(holders);
  const held = new Set(ledger.held);
  const give: string[] = [];
  for (const id of [...want].sort()) {
    if (held.has(id)) continue;
    const triedAt = ledger.away[id];
    if (triedAt !== undefined && nowMs - triedAt < STANDIN_ROLE_AWAY_RETRY_MS) {
      continue;
    }
    give.push(id);
  }
  const take = [...held].filter((id) => !want.has(id)).sort();
  const forget = Object.keys(ledger.away)
    .filter((id) => !want.has(id))
    .sort();
  return { give, take, forget };
}

export function standinRolePlanEmpty(plan: StandinRolePlan): boolean {
  return plan.give.length === 0 && plan.take.length === 0 && plan.forget.length === 0;
}

/** One role write's answer (discord-roles.ts RoleChange). */
export type StandinRoleWriteOutcome = "ok" | "not-a-member" | "forbidden" | "failed";

export type StandinRoleWrite = {
  discordId: string;
  on: boolean;
  outcome: StandinRoleWriteOutcome;
};

/**
 * The ledger after a pass's writes. A write that worked moves the id in or
 * out; giving it to someone not in the server records them as away; removing
 * it from someone not in the server is done (there is nothing to remove). A
 * failed or forbidden write changes nothing, so the next pass tries again.
 */
export function ledgerAfterWrites(
  ledger: StandinRoleLedger,
  writes: StandinRoleWrite[],
  forget: string[],
  nowMs: number,
): StandinRoleLedger {
  const held = new Set(ledger.held);
  const away = { ...ledger.away };
  for (const id of forget) delete away[id];
  for (const w of writes) {
    if (w.outcome === "failed" || w.outcome === "forbidden") continue;
    if (w.on) {
      if (w.outcome === "ok") {
        held.add(w.discordId);
        delete away[w.discordId];
      } else {
        held.delete(w.discordId);
        away[w.discordId] = nowMs;
      }
    } else {
      held.delete(w.discordId);
      delete away[w.discordId];
    }
  }
  return { roleId: ledger.roleId, held: [...held].sort(), away };
}

// ---------------------------------------------------------------------------
// The admin's "Sync Standin role now": a live read of every member it checks.
// ---------------------------------------------------------------------------

/** What one live member read said about the role; null = Discord didn't say. */
export type StandinRoleLive = "has" | "lacks" | "not-member" | null;

/**
 * What the admin sync does for one person, from the rule's answer and the
 * live read. An unknown read writes anyway (both writes are idempotent, and
 * the write's own answer says whether it reached them), so a slow read never
 * leaves a standin without the role.
 */
export function standinRoleLiveStep(
  shouldHold: boolean,
  live: StandinRoleLive,
): "give" | "take" | "keep" | "absent" {
  if (live === "not-member") return shouldHold ? "absent" : "keep";
  if (shouldHold) return live === "has" ? "keep" : "give";
  return live === "lacks" ? "keep" : "take";
}

export type StandinRoleSyncCounts = {
  /** Signups the rule gives the role to, linked or not. */
  holders: number;
  /** Of those, STANDIN signups (the rest are free agents). */
  standins: number;
  /** Of those, how many have no linked Discord (the site can't reach them). */
  unlinked: number;
  /** Role given now. */
  given: number;
  /** Role taken off now. */
  taken: number;
  /** Already right: holders who had it, others who didn't. */
  unchanged: number;
  /** Holders who aren't in the server. */
  notInServer: number;
  /** Reads or writes Discord didn't answer, or the time ran out. */
  failed: number;
  /** The bot may not manage the role (its own role sits below it). */
  forbidden: boolean;
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The admin sync's toast: counts first, then anything that needs a hand. */
export function standinRoleSyncMessage(c: StandinRoleSyncCounts): string {
  const freeAgents = c.holders - c.standins;
  const who =
    c.holders === 0
      ? "Nobody should have the Standin role right now"
      : `${plural(c.holders, "player should", "players should")} have the Standin role (${plural(c.standins, "standin", "standins")}, ${plural(freeAgents, "free agent", "free agents")})`;
  const did =
    c.given === 0 && c.taken === 0
      ? "nothing needed changing"
      : [
          c.given > 0 ? `gave it to ${c.given}` : null,
          c.taken > 0 ? `took it off ${c.taken}` : null,
        ]
          .filter(Boolean)
          .join(" and ");
  const parts = [`${who}: ${did}.`];
  if (c.notInServer > 0) {
    parts.push(
      `${c.notInServer} of them ${c.notInServer === 1 ? "isn't" : "aren't"} in the Discord server, so they get it within a few hours of joining.`,
    );
  }
  if (c.unlinked > 0) {
    parts.push(
      `${plural(c.unlinked, "signup has", "signups have")} no linked Discord, so the site can't give them the role.`,
    );
  }
  if (c.forbidden) {
    parts.push(
      "Discord refused: the bot's role must sit above Standin in Server Settings → Roles. Move it up and press again.",
    );
  } else if (c.failed > 0) {
    parts.push(
      `Discord didn't answer for ${c.failed}; press Sync again in a minute.`,
    );
  }
  return parts.join(" ");
}
