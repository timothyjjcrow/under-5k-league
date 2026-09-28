// Player data refresh: ranked medals, the private-match-data flag, pub
// scouting snapshots, Steam names and avatars, and report-card stats on older
// stored games. The automation worker runs a small budgeted pass about once
// an hour (refreshPlayerDataAutomatically); the admin "Refresh player data
// now" button runs a bigger pass on demand. Both share the write rules below:
// never overwrite stored data with a failed fetch, and re-assert the linked
// Dota account in every write.

import { prisma } from "./prisma";
import { fetchPubStats, fetchRankTier } from "./dota";
import {
  dotaAccountLinkSnapshot,
  effectiveDotaAccountId,
} from "./dota-account";
import {
  PUB_STATS_REFRESH_MS,
  pickStaleAccounts,
  pubStatsFresh,
} from "./pub-stats";
import { fetchSteamProfiles } from "./steam";
import { enrichStoredGames } from "./match-import";
import {
  claimThrottle,
  getSetting,
  SETTING_KEYS,
  setSetting,
} from "./settings";
import { singleActiveSeason } from "./season";
import { profileSyncAllowed } from "./draft-admin";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The account fields a refresh reads and re-asserts. */
export type RefreshAccount = {
  id: string;
  steamId: string;
  dotaAccountIdV2: number | null;
  legacyDotaAccountId: number | null;
  pubStatsAt: Date | null;
};

/** Per-account outcome, kept small so a batch can tally without re-fetching.
 *  `rank` keys the outage detection + toast counts; `pubSynced` counts the
 *  scouting snapshots stored alongside. */
type RankSyncOutcome = {
  rank: "ranked" | "ok-no-rank" | "unreachable";
  pubSynced: boolean;
};

/** Sync one account's medal (+ fh_unavailable) — and, when `withPub`, its
 *  pub-scouting snapshot. `retry` tries whichever call missed once more; the
 *  automatic refresh passes false and backs off instead. */
async function syncOneRank(
  u: {
    id: string;
    dotaAccountIdV2: number | null;
    legacyDotaAccountId: number | null;
  },
  acc: number,
  withPub: boolean,
  retry = true,
): Promise<RankSyncOutcome> {
  // A bulk sync easily trips OpenDota's free rate limit (HTTP 429) or an 8s
  // timeout — a brief back-off + one retry usually clears it.
  const noPub = { ok: false as const, stats: null };
  let [result, pub] = await Promise.all([
    fetchRankTier(acc),
    withPub ? fetchPubStats(acc) : Promise.resolve(noPub),
  ]);
  if (retry && (!result.ok || (withPub && !pub.ok))) {
    await sleep(700);
    [result, pub] = await Promise.all([
      result.ok ? Promise.resolve(result) : fetchRankTier(acc),
      withPub && !pub.ok ? fetchPubStats(acc) : Promise.resolve(pub),
    ]);
  }
  // Store what OpenDota definitely said: a real medal, the public-match-data
  // flag (fh_unavailable) auto-import depends on, and/or the scouting
  // snapshot. A failed half never blocks the half that answered, and neither
  // failure ever wipes stored data.
  const data: {
    fhUnavailable?: boolean;
    pubStats?: string;
    pubStatsAt?: Date;
  } = {};
  if (result.ok) {
    if (result.fhUnavailable !== null)
      data.fhUnavailable = result.fhUnavailable;
  }
  if (pub.ok) {
    data.pubStats = JSON.stringify(pub.stats);
    data.pubStatsAt = new Date();
  }
  if (result.ok && result.rankTier != null) {
    // Admin corrections survive every automatic refresh, including one that
    // was already in flight when the correction was saved.
    await prisma.user.updateMany({
      where: { id: u.id, ...dotaAccountLinkSnapshot(u), rankTierManual: false },
      data: { rankTier: result.rankTier },
    });
  }
  if (Object.keys(data).length > 0) {
    // The WHERE re-asserts the account these figures describe (read-time
    // precondition in the write): a player relinking a different Dota account
    // mid-sweep must not get the old account's data stamped onto the new
    // link. count 0 = they relinked; drop the result — next sweep re-reads.
    await prisma.user.updateMany({
      where: { id: u.id, ...dotaAccountLinkSnapshot(u) },
      data,
    });
  }
  if (!result.ok) return { rank: "unreachable", pubSynced: pub.ok };
  return {
    rank: result.rankTier != null ? "ranked" : "ok-no-rank",
    pubSynced: pub.ok,
  };
}

// Serverless functions have a wall-clock ceiling (`maxDuration` on the admin
// page). One OpenDota timeout is 8s and the retry doubles it, so a serial loop
// over a full roster during an OpenDota outage blows the budget and the request
// dies with no response — the button spins "Working…" forever. Guards: run a
// few accounts at once, stop starting work past a time budget, and bail
// immediately if the very first batch is entirely unreachable (a strong
// "OpenDota is down" signal) instead of hitting an 8s timeout for every id.
const RANK_SYNC_CONCURRENCY = 4;
/** The on-demand refresh's whole time budget. */
export const MANUAL_REFRESH_BUDGET_MS = 45_000;
// The scouting snapshot costs TWO extra OpenDota calls per account, and the
// free tier's bucket is ~60/min — a 31-account sweep at 3 calls each would
// burn its own tail into 429s and could even read as a false outage. So each
// press syncs medals for EVERYONE but refreshes pub snapshots only for the
// stalest accounts up to this cap (fresh ones are skipped outright); the
// automatic refresh keeps working through the rest every hour.
const PUB_SYNC_MAX_PER_RUN = 12;

export type RankSyncResult = {
  ranked: number;
  unreachable: number;
  skipped: number;
  outage: boolean;
  /** Pub-scouting snapshots stored (rides the same loop as the medals). */
  stats: number;
  /** Stale snapshots deferred by PUB_SYNC_MAX_PER_RUN. */
  deferred: number;
};

/** Refresh medals for every given account and pub snapshots for the
 *  stalest few, within the deadline. */
export async function syncRanksFor(
  users: RefreshAccount[],
  deadlineMs: number,
): Promise<RankSyncResult> {
  const targets = users
    .map((u) => ({ u, acc: effectiveDotaAccountId(u) }))
    .filter((t): t is { u: RefreshAccount; acc: number } => !!t.acc);

  // Which accounts get the two extra pub calls this run — see
  // PUB_SYNC_MAX_PER_RUN. Missing/stale snapshots only, stalest first.
  const nowMs = Date.now();
  const staleCandidates = targets
    .filter(({ u }) => !pubStatsFresh(u.pubStatsAt, nowMs))
    .sort(
      (a, b) =>
        (a.u.pubStatsAt?.getTime() ?? 0) - (b.u.pubStatsAt?.getTime() ?? 0),
    );
  const pubTargets = new Set(
    staleCandidates.slice(0, PUB_SYNC_MAX_PER_RUN).map((t) => t.u.id),
  );
  const deferred = staleCandidates.length - pubTargets.size;

  let ranked = 0;
  let unreachable = 0;
  let skipped = 0;
  let outage = false;
  let stats = 0;

  for (let i = 0; i < targets.length; i += RANK_SYNC_CONCURRENCY) {
    if (Date.now() >= deadlineMs) {
      skipped = targets.length - i;
      break;
    }
    const batch = targets.slice(i, i + RANK_SYNC_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map(({ u, acc }) => syncOneRank(u, acc, pubTargets.has(u.id))),
    );
    for (const o of outcomes) {
      if (o.rank === "unreachable") unreachable++;
      else if (o.rank === "ranked") ranked++;
      if (o.pubSynced) stats++;
    }
    // Whole first batch unreachable ⇒ OpenDota is down; don't burn the budget
    // (and the admin's patience) hitting an 8s timeout for every remaining id.
    if (
      i === 0 &&
      batch.length >= 3 &&
      outcomes.every((o) => o.rank === "unreachable")
    ) {
      outage = true;
      skipped = targets.length - batch.length;
      break;
    }
  }
  return { ranked, unreachable, skipped, outage, stats, deferred };
}

/** Steam's GetPlayerSummaries answers up to 100 ids per call. */
const STEAM_BATCH = 100;
/** Its per-call timeout is 10s; don't start one with less than this left. */
const STEAM_START_BUDGET_MS = 11_000;

/**
 * Refresh Steam persona names, avatars and profile links for every account,
 * writing only the rows that changed. Steam's API, not OpenDota's, so it
 * costs nothing from the OpenDota budget. Without STEAM_API_KEY it does
 * nothing.
 */
export async function refreshSteamProfiles(
  deadlineMs: number,
): Promise<{ updated: number; checked: number }> {
  if (!process.env.STEAM_API_KEY) return { updated: 0, checked: 0 };
  const users = await prisma.user.findMany({
    select: {
      id: true,
      steamId: true,
      name: true,
      avatar: true,
      profileUrl: true,
    },
    orderBy: { id: "asc" },
  });
  let updated = 0;
  let checked = 0;
  for (let i = 0; i < users.length; i += STEAM_BATCH) {
    if (deadlineMs - Date.now() < STEAM_START_BUDGET_MS) break;
    const batch = users.slice(i, i + STEAM_BATCH);
    const profiles = await fetchSteamProfiles(batch.map((u) => u.steamId));
    for (const u of batch) {
      const p = profiles.get(u.steamId);
      if (!p) continue;
      checked++;
      if (
        p.name === u.name &&
        p.avatar === u.avatar &&
        p.profileUrl === u.profileUrl
      ) {
        continue;
      }
      const saved = await prisma.user.updateMany({
        where: { id: u.id },
        data: { name: p.name, avatar: p.avatar, profileUrl: p.profileUrl },
      });
      updated += saved.count;
    }
  }
  return { updated, checked };
}

// ---------------------------------------------------------------------------
// The automatic hourly pass
// ---------------------------------------------------------------------------

const PLAYER_DATA_REFRESH_KEY = SETTING_KEYS.PLAYER_DATA_REFRESH_AT;
const PLAYER_DATA_REFRESH_FAILED_KEY =
  SETTING_KEYS.PLAYER_DATA_REFRESH_FAILED_USER;
/**
 * Just under an hour: the scheduler wakes the worker at least hourly, and a
 * wake a few seconds early must not wait out a second hour.
 */
const PLAYER_DATA_REFRESH_INTERVAL_SECONDS = 55 * 60;
/** Accounts per pass: 3 OpenDota calls each (medal, win/loss, heroes). */
export const PLAYER_DATA_REFRESH_ACCOUNTS = 4;
/** Older stored games given report-card stats per pass: 1 call each. */
const PLAYER_DATA_REFRESH_GAMES = 3;
/**
 * After OpenDota refuses a call (a rate limit or an outage) the next pass
 * waits this much longer than usual. The same budget carries live result
 * sync, which matters more.
 */
const PLAYER_DATA_REFRESH_BACKOFF_MS = 2 * 60 * 60_000;
/** Time one account needs: its fetches run in parallel with 8s timeouts. */
const ACCOUNT_START_BUDGET_MS = 12_000;
/** Time one game needs: a 12s match fetch plus the write. */
const GAME_START_BUDGET_MS = 15_000;

export type PlayerDataRefreshOptions = {
  /** Absolute epoch-millisecond deadline supplied by the automation lease. */
  deadlineMs?: number;
  signal?: AbortSignal;
};

export type AutomaticPlayerDataRefresh = {
  /** False when the pass wasn't due (or had no time to start). */
  ran: boolean;
  steamProfiles: number;
  accounts: number;
  games: number;
  /** OpenDota refused a call, so the next pass was pushed back. */
  backedOff: boolean;
};

function timeLeft(options: PlayerDataRefreshOptions, neededMs: number) {
  if (options.signal?.aborted) return false;
  return (
    options.deadlineMs === undefined ||
    options.deadlineMs - Date.now() >= neededMs
  );
}

const SELECT_ACCOUNT = {
  id: true,
  steamId: true,
  dotaAccountIdV2: true,
  legacyDotaAccountId: true,
  pubStatsAt: true,
} as const;

/**
 * The automation worker's low-priority step, run after result sync and only
 * when result sync isn't watching a live match or lobby. About once an hour
 * it refreshes Steam names and avatars, the few stalest accounts' medal and
 * scouting stats, and report-card stats for a few older stored games. It
 * stops at the first call OpenDota refuses and waits longer before the next
 * pass. While an auction is live or paused it leaves medals and names alone
 * (captains are reading them in the room), like the admin button.
 */
export async function refreshPlayerDataAutomatically(
  options: PlayerDataRefreshOptions = {},
): Promise<AutomaticPlayerDataRefresh> {
  const idle: AutomaticPlayerDataRefresh = {
    ran: false,
    steamProfiles: 0,
    accounts: 0,
    games: 0,
    backedOff: false,
  };
  // Not enough time for even one account: leave the pass unclaimed so the
  // next worker run can take it.
  if (!timeLeft(options, ACCOUNT_START_BUDGET_MS)) return idle;
  const nowMs = Date.now();
  if (
    !(await claimThrottle(
      PLAYER_DATA_REFRESH_KEY,
      PLAYER_DATA_REFRESH_INTERVAL_SECONDS,
      nowMs,
    ))
  ) {
    return idle;
  }

  const season = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, draft: { select: { status: true } } },
    }),
  );
  const profilesAllowed = profileSyncAllowed(season?.draft?.status);
  const deadlineMs = options.deadlineMs ?? nowMs + MANUAL_REFRESH_BUDGET_MS;

  let steamProfiles = 0;
  if (profilesAllowed) {
    steamProfiles = (await refreshSteamProfiles(deadlineMs)).updated;
  }

  let accounts = 0;
  let refusedBy: string | null = null;
  let refused = false;
  if (profilesAllowed && timeLeft(options, ACCOUNT_START_BUDGET_MS)) {
    const staleBefore = new Date(nowMs - PUB_STATS_REFRESH_MS);
    const stale = {
      OR: [{ pubStatsAt: null }, { pubStatsAt: { lt: staleBefore } }],
    };
    const [signups, others, lastFailedId] = await Promise.all([
      season
        ? prisma.user.findMany({
            where: {
              ...stale,
              registrations: {
                some: { seasonId: season.id, status: "ACTIVE" },
              },
            },
            select: SELECT_ACCOUNT,
            orderBy: [
              { pubStatsAt: { sort: "asc", nulls: "first" } },
              { id: "asc" },
            ],
            take: 50,
          })
        : Promise.resolve([]),
      prisma.user.findMany({
        where: stale,
        select: SELECT_ACCOUNT,
        // Never-fetched accounts first on both providers (Postgres sorts
        // NULL last by default), so the take can't crowd them out.
        orderBy: [
          { pubStatsAt: { sort: "asc", nulls: "first" } },
          { id: "asc" },
        ],
        take: 50,
      }),
      getSetting(PLAYER_DATA_REFRESH_FAILED_KEY),
    ]);
    const picks = pickStaleAccounts([...signups, ...others], {
      signupIds: new Set(signups.map((u) => u.id)),
      lastFailedId,
      nowMs,
      limit: PLAYER_DATA_REFRESH_ACCOUNTS,
    });
    for (const u of picks) {
      if (!timeLeft(options, ACCOUNT_START_BUDGET_MS)) break;
      const acc = effectiveDotaAccountId(u);
      if (!acc) continue;
      const outcome = await syncOneRank(u, acc, true, false);
      if (outcome.rank === "unreachable" || !outcome.pubSynced) {
        refused = true;
        refusedBy = u.id;
        break;
      }
      accounts++;
    }
  }

  let games = 0;
  if (!refused && timeLeft(options, GAME_START_BUDGET_MS)) {
    const enriched = await enrichStoredGames(PLAYER_DATA_REFRESH_GAMES, {
      deadlineMs,
      signal: options.signal,
      minStartMs: GAME_START_BUDGET_MS,
      stopOnFailure: true,
    });
    games = enriched.enriched;
    if (enriched.stoppedOnFailure) refused = true;
  }

  if (refused) {
    // A later timestamp keeps claimThrottle refusing until it has aged a
    // full interval: the back-off plus the usual hour.
    await setSetting(
      PLAYER_DATA_REFRESH_KEY,
      new Date(nowMs + PLAYER_DATA_REFRESH_BACKOFF_MS).toISOString(),
    );
  }
  if (refusedBy) {
    await setSetting(PLAYER_DATA_REFRESH_FAILED_KEY, refusedBy);
  }
  return { ran: true, steamProfiles, accounts, games, backedOff: refused };
}
