import { prisma } from "./prisma";
import {
  AUTO_SYNC,
  INHOUSE_ACTIVE_STATUSES,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";
import {
  autoSyncClaimCutoff,
  minutesSinceAutoSyncOpen,
} from "./result-sync";
import { queuePresentCutoff } from "./inhouse";
import {
  ANNOUNCE_FAILED_PREFIX,
  announceSeriesResultOnce,
  autoDetectGamesForMatch,
  syncLeagueGames,
} from "./match-import";
import {
  maybeAutoDetectResult,
  maybeFormLobby,
  resolveAbandonedLobby,
  resolveCaptainVote,
  resolveReadyCheck,
  resolveStalledPick,
} from "./inhouse-service";
import { resolveUnsettledBets } from "./inhouse-bet-service";
import {
  CHAMPION_ANNOUNCED_PREFIX,
  claimThrottle,
  getSetting,
  RESULT_ANNOUNCED_PREFIX,
  SETTING_KEYS,
} from "./settings";
import { announceChampionOnce } from "./playoff-service";
import { syncInhouseBoard } from "./inhouse-board-service";
import { raceHook } from "./race-hook";

// Automatic result sync — the league updates itself instead of waiting on a
// captain or admin to press a button. Driven lazily (no cron/websocket, same
// philosophy as the draft clock): the sitewide <ResultSyncPing> POSTs
// /api/sync on every page view and slow-polls on match nights, and this
// service decides — under atomic claims that bound OpenDota usage — whether
// anything is worth scanning right now. Captain reporting and the admin
// controls stay as manual overrides for games automation can't see (players
// with public match data off, unscheduled fixtures).

export type ResultSyncOutcome = {
  /** League games imported this run (caller busts the "games" cache tag). */
  imported: number;
  /** An inhouse result was recorded this run. */
  inhouse: boolean;
  /** Matches are in their detection window or an inhouse lobby is live —
   *  the client should poll fast so parked dashboards update themselves. */
  watch: boolean;
  /** Change cursor (`resultChangedAt` Setting): bumped by EVERY result path —
   *  auto sync, captain import, admin record, inhouse. Clients refresh when it
   *  advances, so the one poller whose request performed an import isn't the
   *  only viewer who ever repaints. */
  cursor: string | null;
};

/**
 * Atomic global throttle (Setting-row claim, the reminder-service pattern).
 * Moved to settings.ts once the inhouse board needed it too — importing it
 * back from here would have closed a cycle (result-sync → inhouse-service →
 * inhouse-board-service → result-sync).
 */
const claimSyncThrottle = claimThrottle;

/**
 * Scan due league matches for finished games. "Due" = unplayed/partial, with a
 * kickoff between MIN_MINUTES_AFTER_KICKOFF and WINDOW_HOURS ago. With a Valve
 * league id one throttled /leagues call covers everything; otherwise ONE due
 * match (stalest scan first) is claimed per run and roster-scanned via the
 * existing autoDetectGamesForMatch — a full league night rotates through its
 * matches within a few intervals while staying inside the API budget.
 */
async function syncDueMatches(
  nowMs: number,
): Promise<{ imported: number; watch: boolean }> {
  // Same newest-wins tiebreak as getActiveSeason. If a transient two-active
  // state ever occurs, every reader must at least agree WHICH season that is —
  // an unordered findFirst could have auto-sync importing into a different
  // season than the one the whole UI is rendering.
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
  });
  if (
    !season ||
    (season.status !== SEASON_STATUS.REGULAR_SEASON &&
      season.status !== SEASON_STATUS.PLAYOFFS)
  ) {
    return { imported: 0, watch: false };
  }

  const due = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      status: { not: MATCH_STATUS.COMPLETED },
      scheduledAt: {
        gte: new Date(nowMs - AUTO_SYNC.WINDOW_HOURS * 3600_000),
        lte: new Date(nowMs - AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF * 60_000),
      },
    },
    select: {
      id: true,
      autoSyncedAt: true,
      autoSyncAttempts: true,
      scheduledAt: true,
    },
  });
  if (due.length === 0) return { imported: 0, watch: false };

  if (season.dotaLeagueId) {
    if (
      !(await claimSyncThrottle(
        SETTING_KEYS.LEAGUE_AUTO_SYNC_AT,
        AUTO_SYNC.LEAGUE_INTERVAL_SECONDS,
        nowMs,
      ))
    ) {
      return { imported: 0, watch: true };
    }
    const res = await syncLeagueGames(season.id, { auto: true });
    if (res.unreachable) {
      // Roll our own claim back so the next tick can retry immediately —
      // otherwise every outage tick costs one full throttle interval (the
      // roster path's rollback pattern). Value-scoped to the exact ISO
      // claimThrottle stamped, so a NEWER claim is never deleted.
      await prisma.setting.deleteMany({
        where: {
          key: SETTING_KEYS.LEAGUE_AUTO_SYNC_AT,
          value: new Date(nowMs).toISOString(),
        },
      });
    }
    return { imported: res.imported, watch: true };
  }

  // Each match's rescan interval backs off exponentially with consecutive
  // empty scans (autoSyncAttempts), so a fixture that will never yield games
  // stops burning OpenDota budget while a live series stays brisk.
  // Young matches get a floored interval (see autoSyncIntervalSeconds) so a
  // late-starting night isn't punished for the empty scans before tip-off.
  const dueMinutes = (m: { scheduledAt: Date | null }) =>
    m.scheduledAt
      ? minutesSinceAutoSyncOpen(m.scheduledAt.getTime(), nowMs)
      : Number.POSITIVE_INFINITY;
  const claimable = [...due]
    .filter(
      (m) =>
        !m.autoSyncedAt ||
        m.autoSyncedAt <
          autoSyncClaimCutoff(nowMs, m.autoSyncAttempts, dueMinutes(m)),
    )
    .sort(
      (a, b) =>
        (a.autoSyncedAt?.getTime() ?? 0) - (b.autoSyncedAt?.getTime() ?? 0),
    );
  if (claimable.length === 0) return { imported: 0, watch: true };

  // Global speed bump BEFORE the per-match claims: without it N simultaneous
  // pollers each claim a DIFFERENT due match and fan out into N parallel
  // roster scans — a burst past OpenDota's per-minute cap on league nights.
  if (
    !(await claimSyncThrottle(
      SETTING_KEYS.ROSTER_AUTO_SYNC_AT,
      AUTO_SYNC.SCAN_GAP_SECONDS,
      nowMs,
    ))
  ) {
    return { imported: 0, watch: true };
  }

  for (const m of claimable) {
    // Claim before scanning — concurrent pollers race here, one wins. The
    // increment counts this scan as empty until proven otherwise.
    //
    // Seam: `status: { not: COMPLETED }` was last checked in the `due` query
    // above, and TWO round trips sit between that read and this write (the
    // claimable filter, then the global throttle claim). A rival that DECIDES
    // the series in that gap — an admin forfeit ruling, a captain's manual
    // import, the league feed — is exactly what the predicate exists to catch,
    // and racing real calls cannot steer it (the throttle serializes runs, so
    // the two never overlap here). Nothing is inside a transaction at this
    // point, so the rival cannot deadlock. See src/lib/race-hook.ts.
    await raceHook("resultSync.syncDueMatches.beforeMatchClaim");
    const claim = await prisma.match.updateMany({
      where: {
        id: m.id,
        status: { not: MATCH_STATUS.COMPLETED },
        OR: [
          { autoSyncedAt: null },
          {
            autoSyncedAt: {
              lt: autoSyncClaimCutoff(
                nowMs,
                m.autoSyncAttempts,
                dueMinutes(m),
              ),
            },
          },
        ],
      },
      data: {
        autoSyncedAt: new Date(nowMs),
        autoSyncAttempts: { increment: 1 },
      },
    });
    if (claim.count === 0) continue;
    const res = await autoDetectGamesForMatch(m.id);
    if (res.imported > 0) {
      await prisma.match.update({
        where: { id: m.id },
        data: { autoSyncAttempts: 0 },
      });
    } else if (res.unreachable) {
      // OpenDota was down or rate-limiting, so finding nothing proves nothing.
      // Roll the speculative increment back — otherwise a brief outage pushed
      // every match of the night into hours-long backoff and the results only
      // landed if somebody remembered the manual button.
      await prisma.match.update({
        where: { id: m.id },
        data: { autoSyncAttempts: { decrement: 1 } },
      });
    }
    return { imported: res.imported, watch: true };
  }
  return { imported: 0, watch: true };
}

/**
 * Run the inhouse lazy resolvers from outside the room. While a game is being
 * played, all ten players are in the Dota client — often with /inhouse closed —
 * so the room's own polling stops exactly when the result becomes detectable.
 * Any page view on the site now forms/advances/closes the lobby instead.
 * Gated behind one cheap read so idle page loads cost almost nothing.
 */
async function syncInhouse(): Promise<{ recorded: boolean; watch: boolean }> {
  const [active, queued] = await Promise.all([
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: { id: true },
    }),
    prisma.inhouseQueueEntry.count(),
  ]);

  // Settle/refund any stranded pot BEFORE the early return below — deliberately
  // not down in the resolver chain past it, and for exactly the reason the board
  // repaint inside that branch exists. "No lobby, empty queue" is not a quiet
  // state for money: it is the state a pot gets stranded in. The request that
  // won the COMPLETED claim can die before the payout, and every result path
  // requires IN_PROGRESS, so nothing re-triggers it; meanwhile the ten who
  // played have closed their tabs and the room has nobody polling it. Below the
  // early return this sweep would first run whenever the NEXT lobby forms —
  // hours or days of a debited stake with no outcome, on the one feature where
  // "it caught up eventually" is not an acceptable answer.
  //
  // Wrapped, alone among the resolvers: /api/sync executes this chain on every
  // page view of the entire site, so a bug in a play-money feature must never
  // be able to stop ten people playing Dota (or a league match importing).
  try {
    await resolveUnsettledBets();
  } catch (e) {
    console.error("[inhouse] bet sweep failed:", e);
  }

  if (!active && queued === 0) {
    // Repaint the board on the way out. This branch is where the queue is
    // ALREADY empty and no lobby is up — which is exactly the state the board
    // is most likely to be lying about, because nothing else runs here: the
    // resolvers below are skipped, and the inhouse room has nobody polling it.
    // The two that bite: a game that just ENDED (the board still reads "game
    // in progress" until something repaints it), and the last player leaving
    // and closing the tab in the same breath. A Discord channel confidently
    // advertising a dead queue is worse than no board at all.
    await syncInhouseBoard();
    return { recorded: false, watch: false };
  }

  // Abandoned READY/IN_PROGRESS teardown runs here too — this is the path
  // that reaches a lobby NOBODY is polling, which is precisely how one gets
  // abandoned in the first place. Without it a dead lobby also pinned every
  // sitewide pinger to the fast `watch` cadence forever (it stays "active").
  await resolveAbandonedLobby();
  await maybeFormLobby();
  await resolveReadyCheck();
  await resolveCaptainVote();
  await resolveStalledPick();
  const recorded = await maybeAutoDetectResult();

  const [stillActive, present] = await Promise.all([
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: { id: true },
    }),
    prisma.inhouseQueueEntry.count({
      where: { lastSeenAt: { gte: queuePresentCutoff(Date.now()) } },
    }),
  ]);
  await syncInhouseBoard();
  // A FILLING queue is watch-worthy too, not just a live lobby. Sitewide
  // pingers used to idle at IDLE_POLL_SECONDS (300) whenever there was no
  // lobby yet, which left both lobby formation and the Discord board up to
  // five minutes behind on exactly the stretch that decides whether a game
  // happens. Present-only so a ghost row can't hold every client at the fast
  // cadence until the 180s prune catches it.
  //
  // An open BETTING window needs no clause of its own: `betsCloseAt` is stamped
  // only on the DRAFTING→READY transition, and READY is one of
  // INHOUSE_ACTIVE_STATUSES — so `stillActive` already pins every client to the
  // fast cadence for the whole 45 seconds and beyond. A `betsCloseAt > now`
  // test here would be dead code wearing the look of a live guard.
  return { recorded, watch: !!stillActive || present > 0 };
}

/**
 * Retry series announcements whose Discord send failed. The failing run is
 * the one that COMPLETED the match, so no import path ever re-triggers it —
 * this throttled sweep re-claims exactly the markers announceSeriesResultOnce
 * stamped `failed:` (never anything else, so history can't re-announce).
 */
async function retryFailedAnnouncements(nowMs: number): Promise<void> {
  if (
    !(await claimSyncThrottle(
      SETTING_KEYS.ANNOUNCE_RETRY_AT,
      AUTO_SYNC.LEAGUE_INTERVAL_SECONDS,
      nowMs,
    ))
  ) {
    return;
  }
  // Inside the same throttle claim — the champion marker is rarer than a
  // series result but strictly more important, so it must not wait on the
  // series queue draining first.
  await retryFailedChampionAnnouncements();
  const failed = await prisma.setting.findMany({
    where: {
      key: { startsWith: RESULT_ANNOUNCED_PREFIX },
      value: { startsWith: ANNOUNCE_FAILED_PREFIX },
    },
    take: 3, // a Discord outage queues several — drain a few per sweep
  });
  if (failed.length === 0) return;
  const matches = await prisma.match.findMany({
    where: {
      id: { in: failed.map((f) => f.key.slice(RESULT_ANNOUNCED_PREFIX.length)) },
    },
    select: {
      id: true,
      homeTeamId: true,
      awayTeamId: true,
      homeScore: true,
      awayScore: true,
      week: true,
      phase: true,
    },
  });
  // A marker whose match no longer exists (a deleted test season) can never be
  // announced, but it still occupies one of the `take` slots on every sweep —
  // three of them permanently starved real failed announcements. Drop them.
  const alive = new Set(matches.map((m) => m.id));
  const orphaned = failed
    .map((f) => f.key)
    .filter((k) => !alive.has(k.slice(RESULT_ANNOUNCED_PREFIX.length)));
  if (orphaned.length > 0) {
    await prisma.setting.deleteMany({ where: { key: { in: orphaned } } });
  }
  for (const m of matches) {
    await announceSeriesResultOnce(m);
  }
}

/**
 * The champion's half of the same sweep. Kept separate because the marker is
 * keyed by SEASON, not match, and because announceChampionOnce does its own
 * orphan cleanup (an un-crowned season drops the marker instead of retrying
 * forever). Cheap: one indexed prefix scan, and in the overwhelmingly common
 * case it matches nothing.
 */
async function retryFailedChampionAnnouncements(): Promise<void> {
  const failed = await prisma.setting.findMany({
    where: {
      key: { startsWith: CHAMPION_ANNOUNCED_PREFIX },
      value: { startsWith: ANNOUNCE_FAILED_PREFIX },
    },
    take: 2,
  });
  for (const f of failed) {
    await announceChampionOnce(f.key.slice(CHAMPION_ANNOUNCED_PREFIX.length));
  }
}

/** One sync pass: league matches + inhouse. Safe (and cheap) on every ping. */
export async function runResultSync(): Promise<ResultSyncOutcome> {
  const nowMs = Date.now();
  await retryFailedAnnouncements(nowMs);
  const [league, inhouse] = await Promise.all([
    syncDueMatches(nowMs),
    syncInhouse(),
  ]);
  // Read the cursor AFTER the syncs so a result this very run just landed is
  // already reflected in the value handed back.
  const cursor = await getSetting(SETTING_KEYS.RESULT_CHANGED_AT);
  return {
    imported: league.imported,
    inhouse: inhouse.recorded,
    watch: league.watch || inhouse.watch,
    cursor,
  };
}
