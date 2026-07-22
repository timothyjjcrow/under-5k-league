import { prisma } from "./prisma";
import {
  AUTO_SYNC,
  INHOUSE_ACTIVE_STATUSES,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";
import { autoSyncClaimCutoff } from "./result-sync";
import {
  ANNOUNCE_FAILED_PREFIX,
  announceSeriesResultOnce,
  autoDetectGamesForMatch,
  syncLeagueGames,
} from "./match-import";
import {
  maybeAutoDetectResult,
  maybeFormLobby,
  resolveCaptainVote,
  resolveReadyCheck,
  resolveStalledPick,
} from "./inhouse-service";
import { getSetting, SETTING_KEYS } from "./settings";

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
 * ISO timestamps compare lexicographically, so the conditional update is a
 * valid "only if stale" claim.
 */
async function claimSyncThrottle(
  key: string,
  intervalSeconds: number,
  nowMs: number,
): Promise<boolean> {
  const value = new Date(nowMs).toISOString();
  try {
    await prisma.setting.create({ data: { key, value } });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
  }
  const staleBefore = new Date(nowMs - intervalSeconds * 1000).toISOString();
  const updated = await prisma.setting.updateMany({
    where: { key, value: { lt: staleBefore } },
    data: { value },
  });
  return updated.count > 0;
}

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
  const season = await prisma.season.findFirst({ where: { isActive: true } });
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
    select: { id: true, autoSyncedAt: true, autoSyncAttempts: true },
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
    return { imported: res.imported, watch: true };
  }

  // Each match's rescan interval backs off exponentially with consecutive
  // empty scans (autoSyncAttempts), so a fixture that will never yield games
  // stops burning OpenDota budget while a live series stays brisk.
  const claimable = [...due]
    .filter(
      (m) =>
        !m.autoSyncedAt ||
        m.autoSyncedAt < autoSyncClaimCutoff(nowMs, m.autoSyncAttempts),
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
    const claim = await prisma.match.updateMany({
      where: {
        id: m.id,
        status: { not: MATCH_STATUS.COMPLETED },
        OR: [
          { autoSyncedAt: null },
          { autoSyncedAt: { lt: autoSyncClaimCutoff(nowMs, m.autoSyncAttempts) } },
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
  if (!active && queued === 0) return { recorded: false, watch: false };

  await maybeFormLobby();
  await resolveReadyCheck();
  await resolveCaptainVote();
  await resolveStalledPick();
  const recorded = await maybeAutoDetectResult();

  const stillActive = await prisma.inhouseLobby.findFirst({
    where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
    select: { id: true },
  });
  return { recorded, watch: !!stillActive };
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
  const failed = await prisma.setting.findMany({
    where: {
      key: { startsWith: "resultAnnounced:" },
      value: { startsWith: ANNOUNCE_FAILED_PREFIX },
    },
    take: 3, // a Discord outage queues several — drain a few per sweep
  });
  if (failed.length === 0) return;
  const matches = await prisma.match.findMany({
    where: {
      id: { in: failed.map((f) => f.key.slice("resultAnnounced:".length)) },
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
  for (const m of matches) {
    await announceSeriesResultOnce(m);
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
