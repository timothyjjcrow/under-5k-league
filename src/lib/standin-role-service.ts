import { prisma } from "./prisma";
import { singleActiveSeason } from "./season";
import { claimThrottle, getSetting, SETTING_KEYS, setSetting } from "./settings";
import { runAfterResponse } from "./after-response";
import {
  fetchGuildMember,
  getStandinRoleConfig,
  setStandinRole,
  type RoleConfig,
} from "./discord-roles";
import { getStandinRoleId } from "./discord";
import { discordMutationsAllowed } from "./discord-mutation-policy";
import {
  ledgerAfterWrites,
  parseStandinRoleLedger,
  serializeStandinRoleLedger,
  standinRoleLiveStep,
  standinRolePlan,
  standinRolePlanEmpty,
  standinRoleTargets,
  type StandinRoleLedger,
  type StandinRoleLive,
  type StandinRoleSeason,
  type StandinRoleSyncCounts,
  type StandinRoleTargets,
  type StandinRoleWrite,
} from "./standin-role";

// The Discord "Standin" role, kept on the active season's standins and free
// agents (Tim's call, 2026-11-17; the rule is holdsStandinRole in
// standin-role.ts). Two ways in:
//
//  1. AUTOMATIC. `refreshStandinRole()` runs after the response of every
//     admin action and of the player actions that change who signed up or
//     who is linked (saveRegistration, leaveLeague, the Discord link and
//     unlink), after the draft completes, and the worker looks after a pass
//     that changed the league (a crowned champion arrives that way) and
//     otherwise every STANDIN_ROLE_IDLE_CHECK_SECONDS. A pass reads the rule's
//     answer and the ledger and writes only the difference, so a quiet
//     league costs a few reads and no Discord request.
//  2. THE ADMIN'S "Sync Standin role now" (`reconcileStandinRole`): a live
//     read of every member it checks (this season's signups and everyone in
//     the ledger), fixing whatever differs, the ledger rewritten from what
//     it saw. It is how hand edits in Discord, and the role given by hand on
//     2026-11-17, come into line.
//
// Every write goes through discord-roles.ts after the commit, behind
// discordMutationsAllowed() (getStandinRoleConfig is null where writes are
// off). "not-a-member" is not an error: they get it when they join.

/** Spam floor between automatic passes that write to Discord. */
export const STANDIN_ROLE_MIN_SECONDS = 5;
/** How often the worker looks when its pass changed nothing in the league. */
export const STANDIN_ROLE_IDLE_CHECK_SECONDS = 600;
/** At most this many role writes in one automatic pass; the rest wait for
 *  the next one (setting a role for the first time gives it to everyone). */
export const STANDIN_ROLE_MAX_WRITES = 60;
/** An automatic pass stops starting writes after this long. */
export const STANDIN_ROLE_PASS_MS = 15_000;
/** The admin sync's budget: a whole season's signups, paced reads. */
export const STANDIN_ROLE_SYNC_MS = 25_000;
/** Concurrent member reads in the admin sync (the reach sweep's four). */
const SYNC_CONCURRENCY = 4;

/** Everything the rule needs about the active season, in four reads. */
export async function loadStandinRoleTargets(): Promise<{
  seasonId: string | null;
  targets: StandinRoleTargets;
}> {
  const active = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: {
        id: true,
        status: true,
        draft: { select: { status: true } },
      },
    }),
  );
  if (!active) {
    return { seasonId: null, targets: standinRoleTargets(null, []) };
  }
  const season: StandinRoleSeason = {
    status: active.status,
    draftStatus: active.draft?.status ?? null,
  };
  const [signups, members, teams] = await Promise.all([
    prisma.registration.findMany({
      where: { seasonId: active.id },
      select: {
        userId: true,
        type: true,
        status: true,
        user: { select: { discordId: true } },
      },
    }),
    prisma.teamMember.findMany({
      where: { seasonId: active.id },
      select: { userId: true },
    }),
    prisma.team.findMany({
      where: { seasonId: active.id },
      select: { captainId: true },
    }),
  ]);
  const rostered = new Set<string>([
    ...members.map((m) => m.userId),
    ...teams.map((t) => t.captainId),
  ]);
  return {
    seasonId: active.id,
    targets: standinRoleTargets(
      season,
      signups.map((s) => ({
        userId: s.userId,
        discordId: s.user.discordId,
        type: s.type,
        status: s.status,
        rostered: rostered.has(s.userId),
      })),
    ),
  };
}

async function readLedger(roleId: string): Promise<StandinRoleLedger> {
  return parseStandinRoleLedger(
    await getSetting(SETTING_KEYS.STANDIN_ROLE_STATE),
    roleId,
  );
}

/**
 * Last write wins on purpose. Two passes that overlap (the spam floor keeps
 * that rare) write ledgers that may each miss the other's change; the next
 * pass sees the difference and repeats the write, which is idempotent. A
 * compare-and-swap would buy nothing a repeat doesn't.
 */
async function writeLedger(ledger: StandinRoleLedger): Promise<void> {
  await setSetting(
    SETTING_KEYS.STANDIN_ROLE_STATE,
    serializeStandinRoleLedger(ledger),
  );
}

export type StandinRoleSyncOutcome =
  | "off"
  | "unchanged"
  | "throttled"
  | "applied"
  | "partial";

/**
 * One automatic pass: the rule against the ledger, then only the difference.
 * Safe to call after any write. `retryNow` skips the absentee wait for these
 * Discord ids (a player who just linked, and joined the server with it).
 */
export async function syncStandinRole(
  options: {
    nowMs?: number;
    deadlineAtMs?: number;
    retryNow?: string[];
  } = {},
): Promise<StandinRoleSyncOutcome> {
  const nowMs = options.nowMs ?? Date.now();
  const cfg = await getStandinRoleConfig();
  if (!cfg) return "off";
  const { targets } = await loadStandinRoleTargets();
  const ledger = await readLedger(cfg.roleId);
  for (const id of options.retryNow ?? []) delete ledger.away[id];
  const plan = standinRolePlan(targets.holders, ledger, nowMs);
  if (standinRolePlanEmpty(plan)) return "unchanged";
  if (
    !(await claimThrottle(
      SETTING_KEYS.STANDIN_ROLE_AT,
      STANDIN_ROLE_MIN_SECONDS,
      nowMs,
    ))
  ) {
    return "throttled";
  }
  const deadline = Math.min(
    options.deadlineAtMs ?? Infinity,
    Date.now() + STANDIN_ROLE_PASS_MS,
  );
  const todo = [
    ...plan.take.map((discordId) => ({ discordId, on: false })),
    ...plan.give.map((discordId) => ({ discordId, on: true })),
  ];
  const writes: StandinRoleWrite[] = [];
  let partial = false;
  for (const step of todo) {
    if (writes.length >= STANDIN_ROLE_MAX_WRITES || Date.now() >= deadline) {
      partial = true;
      break;
    }
    const outcome = await setStandinRole(step.discordId, step.on, cfg);
    writes.push({ ...step, outcome });
    // A hierarchy refusal applies to every write; stop spending requests.
    if (outcome === "forbidden") {
      partial = true;
      break;
    }
  }
  await writeLedger(ledgerAfterWrites(ledger, writes, plan.forget, Date.now()));
  return partial || writes.some((w) => w.outcome === "failed")
    ? "partial"
    : "applied";
}

/**
 * Run a pass after the response of the write that just committed, so nobody
 * waits on Discord. A pass that loses the spam floor to a concurrent one
 * waits it out once and looks again: the winner may have read the league
 * before this write landed. Never throws.
 */
export function refreshStandinRole(
  options: { retryNow?: string[] } = {},
): Promise<void> {
  return runAfterResponse(async () => {
    const first = await syncStandinRole(options);
    if (first !== "throttled") return;
    await new Promise((resolve) =>
      setTimeout(resolve, STANDIN_ROLE_MIN_SECONDS * 1000 + 250),
    );
    await syncStandinRole(options);
  });
}

/**
 * The worker's look, once per pass. `changed` says the pass did something
 * the rule may follow (imported a game, which can crown a champion, sold a
 * lot, built a playoff round): then it always looks. Otherwise at most every
 * STANDIN_ROLE_IDLE_CHECK_SECONDS, which also retries absentees and
 * anything a lost after-response pass left. Off costs no database read
 * without a bot token, one Setting read with one.
 */
export async function syncStandinRoleFromWorker(
  changed: boolean,
  options: { nowMs?: number; deadlineAtMs?: number } = {},
): Promise<StandinRoleSyncOutcome | "idle"> {
  const nowMs = options.nowMs ?? Date.now();
  const cfg = await getStandinRoleConfig();
  if (!cfg) return "off";
  if (
    !changed &&
    !(await claimThrottle(
      SETTING_KEYS.STANDIN_ROLE_CHECK_AT,
      STANDIN_ROLE_IDLE_CHECK_SECONDS,
      nowMs,
    ))
  ) {
    return "idle";
  }
  return syncStandinRole({ nowMs, deadlineAtMs: options.deadlineAtMs });
}

// ---------------------------------------------------------------------------
// The admin's "Sync Standin role now"
// ---------------------------------------------------------------------------

export type StandinRoleReconcile =
  | { ok: true; counts: StandinRoleSyncCounts }
  | { ok: false; error: string };

function liveRole(
  info: Awaited<ReturnType<typeof fetchGuildMember>>,
  roleId: string,
): StandinRoleLive {
  if (info === null) return null;
  if (info.membership === "not-member") return "not-member";
  return info.roles.includes(roleId) ? "has" : "lacks";
}

/**
 * Read every member it checks live and fix what differs: this season's
 * signups with a linked Discord, plus everyone the ledger lists (a past
 * season's standins, an unlinked account). The ledger is rewritten from what
 * Discord said; where it said nothing, the old entry stands.
 */
export async function reconcileStandinRole(
  options: { deadlineMs?: number; cfg?: RoleConfig } = {},
): Promise<StandinRoleReconcile> {
  if (!discordMutationsAllowed()) {
    return {
      ok: false,
      error:
        "Discord writes are off here (a preview or staging), so the live server's roles were not changed.",
    };
  }
  const cfg = options.cfg ?? (await getStandinRoleConfig());
  if (!cfg) {
    return {
      ok: false,
      error: (await getStandinRoleId())
        ? "The Discord bot isn't set up here (DISCORD_BOT_TOKEN and DISCORD_GUILD_ID), so the role can't be given."
        : "Save the Standin role id first.",
    };
  }
  const { targets } = await loadStandinRoleTargets();
  const ledger = await readLedger(cfg.roleId);
  const holders = new Set(targets.holders);
  const ids = [
    ...new Set([
      ...targets.holders,
      ...targets.others,
      ...ledger.held,
      ...Object.keys(ledger.away),
    ]),
  ].sort();

  const counts: StandinRoleSyncCounts = {
    holders: targets.holders.length + targets.unlinkedUserIds.length,
    standins: targets.standins,
    unlinked: targets.unlinkedUserIds.length,
    given: 0,
    taken: 0,
    unchanged: 0,
    notInServer: 0,
    failed: 0,
    forbidden: false,
  };
  const held = new Set(ledger.held);
  const away = { ...ledger.away };
  const nowMs = Date.now();
  const deadline = nowMs + (options.deadlineMs ?? STANDIN_ROLE_SYNC_MS);

  const settle = (id: string, shouldHold: boolean, step: string, write?: string) => {
    if (step === "keep") {
      counts.unchanged++;
      if (shouldHold) held.add(id);
      else held.delete(id);
      delete away[id];
      return;
    }
    if (step === "absent") {
      counts.notInServer++;
      held.delete(id);
      away[id] = nowMs;
      return;
    }
    if (write === "ok") {
      if (step === "give") {
        counts.given++;
        held.add(id);
      } else {
        counts.taken++;
        held.delete(id);
      }
      delete away[id];
      return;
    }
    if (write === "not-a-member") {
      // Reads said member (or nothing); the write says they've gone.
      held.delete(id);
      if (shouldHold) {
        counts.notInServer++;
        away[id] = nowMs;
      } else {
        counts.unchanged++;
        delete away[id];
      }
      return;
    }
    if (write === "forbidden") counts.forbidden = true;
    counts.failed++;
  };

  let next = 0;
  const workers = Array.from(
    { length: Math.min(SYNC_CONCURRENCY, ids.length) },
    async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if (Date.now() >= deadline || counts.forbidden) {
          counts.failed++;
          continue;
        }
        const shouldHold = holders.has(id);
        const live = liveRole(await fetchGuildMember(id, cfg), cfg.roleId);
        const step = standinRoleLiveStep(shouldHold, live);
        if (step === "give" || step === "take") {
          settle(id, shouldHold, step, await setStandinRole(id, step === "give", cfg));
        } else {
          settle(id, shouldHold, step);
        }
      }
    },
  );
  await Promise.all(workers);
  // Absentees no longer covered by the rule need no memory.
  for (const id of Object.keys(away)) if (!holders.has(id)) delete away[id];
  await writeLedger({ roleId: cfg.roleId, held: [...held], away });
  return { ok: true, counts };
}

/** What /admin's Discord card shows about the role, from the database only. */
export type StandinRoleStatus = {
  roleId: string | null;
  /** Bot token and guild are set. */
  botReady: boolean;
  /** Signups the rule gives the role to, linked or not. */
  holders: number;
  standins: number;
  unlinkedNames: string[];
  /** How many the site last made sure hold it (the ledger). */
  given: number;
  /** How many weren't in the server when last tried. */
  away: number;
};

export async function getStandinRoleStatus(): Promise<StandinRoleStatus> {
  const roleId = await getStandinRoleId();
  const botReady = !!process.env.DISCORD_BOT_TOKEN && !!process.env.DISCORD_GUILD_ID;
  const { targets } = await loadStandinRoleTargets();
  const ledger = roleId ? await readLedger(roleId) : null;
  const unlinked = targets.unlinkedUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: targets.unlinkedUserIds } },
        select: { name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      })
    : [];
  return {
    roleId,
    botReady,
    holders: targets.holders.length + targets.unlinkedUserIds.length,
    standins: targets.standins,
    unlinkedNames: unlinked.map((u) => u.name),
    given: ledger?.held.length ?? 0,
    away: ledger ? Object.keys(ledger.away).length : 0,
  };
}
