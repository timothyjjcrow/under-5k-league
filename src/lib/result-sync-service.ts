import { prisma } from "./prisma";
import { prismaErrorCode } from "./operational-code";
import {
  AUTO_SYNC,
  DRAFT_STATUS,
  INHOUSE_ACTIVE_STATUSES,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";
import { autoSyncClaimCutoff, minutesSinceAutoSyncOpen } from "./result-sync";
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
  championAnnouncedKey,
  claimThrottle,
  getSetting,
  HONORS_ANNOUNCED_PREFIX,
  RESULT_ANNOUNCED_PREFIX,
  SETTING_KEYS,
} from "./settings";
import { advancePlayoffBracket, announceChampionOnce } from "./playoff-service";
import { syncInhouseBoard } from "./inhouse-board-service";
import {
  deliverInhouseAnnouncements,
  reconcileMissingInhouseResultAnnouncements,
} from "./inhouse-announcement-outbox";
import { raceHook } from "./race-hook";
import {
  resolveExpiredNomination,
  resolveStalledNomination,
} from "./draft-service";
import {
  maybeAnnounceWeekHonors,
  retryPendingHonorAnnouncements,
} from "./honors-service";
import { getSeasonHonorReadiness } from "./honors-readiness-service";
import { HONOR_WEEK_STATE } from "./honors-readiness";
import { getActiveSeason, singleActiveSeason } from "./season";
import { maybeAnnounceUpcomingWeek } from "./reminder-service";
import { deliverPendingLeagueAnnouncements } from "./discord";
import { recoverableAnnouncementMarker } from "./announcement-marker";

// Automatic result sync — the league updates itself instead of waiting on a
// captain or admin to press a button. A leased scheduler invokes this service;
// the public /api/sync endpoint is a read-only cursor/watch snapshot. Atomic
// claims remain defense in depth against overlaps and manual races. The worker
// also advances a
// due auction clock, so draft progress does not depend on somebody keeping the
// draft room open. Captain reporting and the admin
// controls stay as manual overrides for games automation can't see (players
// with public match data off, unscheduled fixtures).

export type ResultSyncOutcome = {
  /** League games imported this run (caller busts the "games" cache tag). */
  imported: number;
  /** An inhouse result was recorded this run. */
  inhouse: boolean;
  /** A due auction bid or nomination clock advanced this run. */
  draft: boolean;
  /** Playoff reconciliation built a round or crowned the champion this run. */
  playoff: boolean;
  /** Matches are in their detection window, an inhouse lobby is live, or an
   *  auction clock is running — the client should poll fast so unattended
   *  workflows keep advancing and parked dashboards update themselves. */
  watch: boolean;
  /** Change cursor (`resultChangedAt` Setting): bumped by EVERY result path —
   *  auto sync, captain import, admin record, inhouse, and playoff
   *  reconciliation. Clients refresh when it advances, so the one poller whose
   *  request performed an import isn't the only viewer who ever repaints. */
  cursor: string | null;
  /** Stable machine-readable failures. Independent work continues. */
  issues: string[];
  /** Stable machine-readable work omitted because its budget was exhausted. */
  skipped: string[];
};

export type RunResultSyncOptions = {
  /** Absolute epoch-millisecond deadline supplied by the automation lease. */
  deadlineMs?: number;
  signal?: AbortSignal;
};

const RESULT_SYNC_ISSUE = {
  LEAGUE: "LEAGUE_SYNC_FAILED",
  INHOUSE: "INHOUSE_SYNC_FAILED",
  INHOUSE_NOTIFICATIONS: "INHOUSE_NOTIFICATION_DELIVERY_FAILED",
  DRAFT: "DRAFT_SYNC_FAILED",
  PLAYOFF: "PLAYOFF_SYNC_FAILED",
  REMINDER: "REMINDER_FAILED",
  NOTIFICATIONS: "NOTIFICATION_RETRY_FAILED",
  OUTBOX: "LEAGUE_NOTIFICATION_DELIVERY_FAILED",
  CURSOR: "CURSOR_READ_FAILED",
} as const;

const RESULT_SYNC_SKIPPED = {
  LEAGUE: "LEAGUE_BUDGET_EXHAUSTED",
  INHOUSE: "INHOUSE_BUDGET_EXHAUSTED",
  DRAFT: "DRAFT_BUDGET_EXHAUSTED",
  PLAYOFF: "PLAYOFF_BUDGET_EXHAUSTED",
  REMINDER: "REMINDER_BUDGET_EXHAUSTED",
  NOTIFICATIONS: "NOTIFICATIONS_BUDGET_EXHAUSTED",
  CURSOR: "CURSOR_BUDGET_EXHAUSTED",
} as const;

const MIN_DB_STEP_MS = 100;
const MIN_DISCORD_STEP_MS = 5_500;
const ANNOUNCEMENT_CLAIM_PREFIX = "claim:v2:";

function canStartWork(
  options: RunResultSyncOptions,
  minimumRemainingMs = MIN_DB_STEP_MS,
): boolean {
  if (options.signal?.aborted) return false;
  return (
    options.deadlineMs === undefined ||
    options.deadlineMs - Date.now() >= minimumRemainingMs
  );
}

function logStepFailure(step: string, error: unknown) {
  const code = prismaErrorCode(error) ?? "STEP_FAILED";
  // Never serialize the caught object here: fetch errors may carry a URL and
  // the OpenDota URL can contain its API key. Persisted/operator summaries use
  // the same stable codes and keep credentials out of logs and admin UI.
  console.error(`[result-sync] ${step} failed (${code})`);
}

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
  options: RunResultSyncOptions,
): Promise<{ imported: number; watch: boolean; deadlineReached?: boolean }> {
  if (!canStartWork(options)) {
    return { imported: 0, watch: false, deadlineReached: true };
  }
  const season = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
    }),
  );
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
    if (!canStartWork(options)) {
      return { imported: 0, watch: true, deadlineReached: true };
    }
    if (
      !(await claimSyncThrottle(
        SETTING_KEYS.LEAGUE_AUTO_SYNC_AT,
        AUTO_SYNC.LEAGUE_INTERVAL_SECONDS,
        nowMs,
      ))
    ) {
      return { imported: 0, watch: true };
    }
    const res = await syncLeagueGames(season.id, {
      auto: true,
      deadlineMs: options.deadlineMs,
      signal: options.signal,
    });
    if (res.unreachable || res.deadlineReached) {
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
    return {
      imported: res.imported,
      watch: true,
      ...(res.deadlineReached ? { deadlineReached: true } : {}),
    };
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
  if (!canStartWork(options)) {
    return { imported: 0, watch: true, deadlineReached: true };
  }
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
    if (!canStartWork(options)) {
      await prisma.setting.deleteMany({
        where: {
          key: SETTING_KEYS.ROSTER_AUTO_SYNC_AT,
          value: new Date(nowMs).toISOString(),
        },
      });
      return { imported: 0, watch: true, deadlineReached: true };
    }
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
              lt: autoSyncClaimCutoff(nowMs, m.autoSyncAttempts, dueMinutes(m)),
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
    const res = await autoDetectGamesForMatch(m.id, {
      deadlineMs: options.deadlineMs,
      signal: options.signal,
    });
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
    if (res.deadlineReached) {
      // The claim describes a scan that never completed. Restore the exact
      // speculative match state and global throttle so the next scheduled run
      // can resume immediately instead of backing off incomplete work.
      if (res.imported === 0) {
        // Test seam: a newer worker can commit its own cursor after this scan
        // times out but before the stale rollback. Only our exact claim may be
        // restored; otherwise the old worker erases the newer backoff.
        await raceHook("resultSync.syncDueMatches.beforeDeadlineRollback");
        await prisma.match.updateMany({
          where: {
            id: m.id,
            autoSyncedAt: new Date(nowMs),
            autoSyncAttempts: m.autoSyncAttempts + 1,
          },
          data: {
            autoSyncedAt: m.autoSyncedAt,
            autoSyncAttempts: m.autoSyncAttempts,
          },
        });
      }
      await prisma.setting.deleteMany({
        where: {
          key: SETTING_KEYS.ROSTER_AUTO_SYNC_AT,
          value: new Date(nowMs).toISOString(),
        },
      });
    }
    return {
      imported: res.imported,
      watch: true,
      ...(res.deadlineReached ? { deadlineReached: true } : {}),
    };
  }
  return { imported: 0, watch: true };
}

/**
 * Run the inhouse lazy resolvers from outside the room. While a game is being
 * played, all ten players are in the Dota client — often with /inhouse closed —
 * so the room's own polling stops exactly when the result becomes detectable.
 * The scheduled worker now forms/advances/closes the lobby even when the room
 * is empty. Gated behind one cheap read so idle runs cost almost nothing.
 */
async function syncInhouse(options: RunResultSyncOptions): Promise<{
  recorded: boolean;
  watch: boolean;
  deadlineReached?: boolean;
  notificationFailed?: boolean;
}> {
  if (!canStartWork(options)) {
    return { recorded: false, watch: false, deadlineReached: true };
  }
  let announcementsPending = false;
  let notificationFailed = false;
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
  // Wrapped, alone among the resolvers: the shared automation worker executes
  // this chain, so a bug in a play-money feature must never
  // be able to stop ten people playing Dota (or a league match importing).
  if (canStartWork(options)) {
    try {
      await resolveUnsettledBets();
    } catch (e) {
      logStepFailure("inhouse-bet-sweep", e);
    }
  }

  // Repair the crash window from releases that committed COMPLETED before the
  // durable outbox row existed. Bet settlement runs first because the rebuilt
  // message includes its persisted receipt. Both repairs are best-effort; no
  // notification plumbing may block live lobby state progression.
  if (canStartWork(options)) {
    try {
      const repaired = await reconcileMissingInhouseResultAnnouncements({
        limit: 10,
      });
      announcementsPending = repaired.created > 0;
    } catch (error) {
      logStepFailure("inhouse-announcement-reconciliation", error);
      notificationFailed = true;
    }
  }

  const drainOneAnnouncement = async () => {
    // One webhook attempt TOTAL per worker pass. Active lobby state gets its
    // turn first; a backlog then drains across later leased runs.
    if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
      announcementsPending = true;
      return;
    }
    try {
      const delivery = await deliverInhouseAnnouncements({ limit: 1 });
      announcementsPending = delivery.pending;
      if (delivery.attempted > delivery.delivered) notificationFailed = true;
    } catch (error) {
      logStepFailure("inhouse-announcement-delivery", error);
      announcementsPending = true;
      notificationFailed = true;
    }
  };

  if (!active && queued === 0) {
    // Repaint the board on the way out. This branch is where the queue is
    // ALREADY empty and no lobby is up — which is exactly the state the board
    // is most likely to be lying about, because nothing else runs here: the
    // resolvers below are skipped, and the inhouse room has nobody polling it.
    // The two that bite: a game that just ENDED (the board still reads "game
    // in progress" until something repaints it), and the last player leaving
    // and closing the tab in the same breath. A Discord channel confidently
    // advertising a dead queue is worse than no board at all.
    await drainOneAnnouncement();
    if (canStartWork(options, MIN_DISCORD_STEP_MS)) await syncInhouseBoard();
    return {
      recorded: false,
      watch: announcementsPending,
      ...(notificationFailed ? { notificationFailed: true } : {}),
      ...(!canStartWork(options) ? { deadlineReached: true } : {}),
    };
  }

  // Abandoned READY/IN_PROGRESS teardown runs here too — this is the path
  // that reaches a lobby NOBODY is polling, which is precisely how one gets
  // abandoned in the first place. Without it a dead lobby also pinned every
  // sitewide pinger to the fast `watch` cadence forever (it stays "active").
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    return {
      recorded: false,
      watch: true,
      deadlineReached: true,
      ...(notificationFailed ? { notificationFailed: true } : {}),
    };
  }
  await resolveAbandonedLobby();
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    return {
      recorded: false,
      watch: true,
      deadlineReached: true,
      ...(notificationFailed ? { notificationFailed: true } : {}),
    };
  }
  await maybeFormLobby();
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    return {
      recorded: false,
      watch: true,
      deadlineReached: true,
      ...(notificationFailed ? { notificationFailed: true } : {}),
    };
  }
  await resolveReadyCheck();
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    return {
      recorded: false,
      watch: true,
      deadlineReached: true,
      ...(notificationFailed ? { notificationFailed: true } : {}),
    };
  }
  await resolveCaptainVote();
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    return {
      recorded: false,
      watch: true,
      deadlineReached: true,
      ...(notificationFailed ? { notificationFailed: true } : {}),
    };
  }
  await resolveStalledPick();
  if (!canStartWork(options, 12_500)) {
    return {
      recorded: false,
      watch: true,
      deadlineReached: true,
      ...(notificationFailed ? { notificationFailed: true } : {}),
    };
  }
  const detected = await maybeAutoDetectResult({
    deadlineMs: options.deadlineMs,
    signal: options.signal,
  });
  const recorded = detected.recorded;
  if (detected.deadlineReached) {
    return {
      recorded: false,
      watch: true,
      deadlineReached: true,
      ...(notificationFailed ? { notificationFailed: true } : {}),
    };
  }
  await drainOneAnnouncement();

  const [stillActive, present] = await Promise.all([
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: { id: true },
    }),
    prisma.inhouseQueueEntry.count({
      where: { lastSeenAt: { gte: queuePresentCutoff(Date.now()) } },
    }),
  ]);
  if (canStartWork(options, MIN_DISCORD_STEP_MS)) await syncInhouseBoard();
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
  return {
    recorded,
    watch: !!stillActive || present > 0 || announcementsPending,
    ...(notificationFailed ? { notificationFailed: true } : {}),
    ...(!canStartWork(options) ? { deadlineReached: true } : {}),
  };
}

/**
 * Advance a due auction clock from the scheduled worker.
 *
 * A database-throttled authenticated draft-room poll may call these same
 * idempotent, atomically-claimed resolvers for immediate UI recovery. This
 * cheap preflight keeps the automation worker from opening
 * their transactions unless the newest active season is actually in the Draft
 * phase with a deadline due. A future live clock remains watch-worthy so any
 * visible page polls at the one-minute cadence until the deadline is resolved;
 * paused and completed drafts have no unattended clock to advance.
 */
async function syncDraftClocks(
  nowMs: number,
  options: RunResultSyncOptions,
): Promise<{ advanced: boolean; watch: boolean; deadlineReached?: boolean }> {
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    return { advanced: false, watch: false, deadlineReached: true };
  }
  const season = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: {
        id: true,
        status: true,
        draft: {
          select: {
            status: true,
            bidEndsAt: true,
            nominationEndsAt: true,
          },
        },
      },
    }),
  );
  const draft = season?.draft;
  if (
    !season ||
    season.status !== SEASON_STATUS.DRAFT ||
    !draft ||
    draft.status !== DRAFT_STATUS.IN_PROGRESS
  ) {
    return { advanced: false, watch: false };
  }

  const due =
    (draft.bidEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) <= nowMs ||
    (draft.nominationEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) <= nowMs;
  if (!due) return { advanced: false, watch: true };

  // Keep the draft room's ordering: settle a live lot first, then handle an
  // expired nomination turn. The service claims make this safe when a room
  // poll and several site heartbeats arrive together.
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    return { advanced: false, watch: true, deadlineReached: true };
  }
  const expired = await resolveExpiredNomination(season.id);
  if (!canStartWork(options)) {
    return {
      advanced: expired,
      watch: true,
      deadlineReached: true,
    };
  }
  const stalled = await resolveStalledNomination(season.id);

  // Another request may have won either claim, and a winning resolver may have
  // completed the auction. Re-read instead of returning the preflight status so
  // clients do not fast-poll a draft that is already over.
  const current = await prisma.draft.findUnique({
    where: { seasonId: season.id },
    select: { status: true },
  });
  return {
    advanced: expired || stalled,
    watch: current?.status === DRAFT_STATUS.IN_PROGRESS,
  };
}

type AnnouncementMarkerRow = { key: string; value: string };

/**
 * Select one explicitly recoverable marker without letting a live lease block
 * failed work. Generated claim expiries sort chronologically; the bounded
 * candidate window is defense against malformed hand-written Setting rows.
 */
async function nextRecoverableMarker(
  keyPrefix: string,
  nowMs: number,
): Promise<AnnouncementMarkerRow | null> {
  const failed = await prisma.setting.findFirst({
    where: {
      key: { startsWith: keyPrefix },
      value: { startsWith: ANNOUNCE_FAILED_PREFIX },
    },
    orderBy: { key: "asc" },
    select: { key: true, value: true },
  });
  if (failed) return failed;

  const claims = await prisma.setting.findMany({
    where: {
      key: { startsWith: keyPrefix },
      value: { startsWith: ANNOUNCEMENT_CLAIM_PREFIX },
    },
    orderBy: [{ value: "asc" }, { key: "asc" }],
    take: 16,
    select: { key: true, value: true },
  });
  return (
    claims.find((row) => recoverableAnnouncementMarker(row.value, nowMs)) ??
    null
  );
}

function announcementRecoveryPhase(status: string): boolean {
  return (
    status === SEASON_STATUS.REGULAR_SEASON ||
    status === SEASON_STATUS.PLAYOFFS ||
    status === SEASON_STATUS.COMPLETE
  );
}

/**
 * Recover only results whose completion was stamped by the production
 * migration. Historical COMPLETED rows intentionally retain completedAt=null,
 * so deploying the worker cannot replay an existing season. The anti-join is
 * bounded at the database rather than paging through every already-marked
 * result. Intentional bulk rulings persist suppression markers in their result
 * transaction and are therefore excluded by the same join.
 */
async function recoverMissingSeriesAnnouncement(
  options: RunResultSyncOptions,
): Promise<void> {
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) return;
  const season = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, status: true },
    }),
  );
  if (!season || !announcementRecoveryPhase(season.status)) return;

  const missing = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT match."id"
    FROM "Match" AS match
    LEFT JOIN "Setting" AS marker
      ON marker."key" = ${RESULT_ANNOUNCED_PREFIX} || match."id"
    WHERE match."seasonId" = ${season.id}
      AND match."status" = ${MATCH_STATUS.COMPLETED}
      AND match."completedAt" IS NOT NULL
      AND marker."key" IS NULL
    ORDER BY match."completedAt" ASC, match."id" ASC
    LIMIT 1
  `;
  const id = missing[0]?.id;
  if (!id || !canStartWork(options, MIN_DISCORD_STEP_MS)) return;
  const match = await prisma.match.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      homeTeamId: true,
      awayTeamId: true,
      homeScore: true,
      awayScore: true,
      week: true,
      phase: true,
      forfeit: true,
    },
  });
  if (!match || match.status !== MATCH_STATUS.COMPLETED) return;
  await announceSeriesResultOnce(match);
}

/**
 * The result effect also owns weekly honors, so the same post-commit crash can
 * leave a ready regular-season week with no marker. At least one match in the
 * week must carry the post-migration completion stamp. A cheap distinct-week
 * preflight avoids loading box scores when every eligible week already has a
 * marker; otherwise readiness is computed once for the active season and at
 * most one ready week publishes. There is no fixed candidate window where
 * newer partial weeks can permanently hide an older publishable week.
 */
async function recoverMissingHonorAnnouncement(
  options: RunResultSyncOptions,
): Promise<void> {
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) return;
  const season = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, status: true },
    }),
  );
  if (!season || !announcementRecoveryPhase(season.status)) return;

  const postMigration = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      phase: MATCH_PHASE.REGULAR,
      status: MATCH_STATUS.COMPLETED,
      completedAt: { not: null },
    },
    distinct: ["week"],
    select: { week: true },
  });
  if (postMigration.length === 0 || !canStartWork(options)) return;
  const markerKeys = postMigration.map(
    ({ week }) => `${HONORS_ANNOUNCED_PREFIX}${season.id}:${week}`,
  );
  const markers = await prisma.setting.findMany({
    where: { key: { in: markerKeys } },
    select: { key: true },
  });
  const marked = new Set(markers.map((row) => row.key));
  const missingWeeks = new Set(
    postMigration
      .map((row) => row.week)
      .filter(
        (week) => !marked.has(`${HONORS_ANNOUNCED_PREFIX}${season.id}:${week}`),
      ),
  );
  if (missingWeeks.size === 0 || !canStartWork(options)) return;
  const week = (await getSeasonHonorReadiness(season.id)).find(
    (row) => row.state === HONOR_WEEK_STATE.READY && missingWeeks.has(row.week),
  )?.week;
  if (week !== undefined && canStartWork(options, MIN_DISCORD_STEP_MS)) {
    await maybeAnnounceWeekHonors(season.id, week);
  }
}

/**
 * Retry durable Discord work whose send failed (or whose weekly award was
 * invalidated by a result correction). The failing run is usually the one
 * that completed the match, so no import path can be trusted to re-trigger it;
 * this throttled sweep delegates to each marker owner's compare-and-swap.
 */
async function retryFailedAnnouncements(
  nowMs: number,
  options: RunResultSyncOptions,
): Promise<{ deadlineReached: boolean }> {
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    return { deadlineReached: true };
  }
  if (
    !(await claimSyncThrottle(
      SETTING_KEYS.ANNOUNCE_RETRY_AT,
      AUTO_SYNC.LEAGUE_INTERVAL_SECONDS,
      nowMs,
    ))
  ) {
    return { deadlineReached: false };
  }
  // Inside the same throttle claim — the champion marker is rarer than a
  // series result but strictly more important, so it must not wait on the
  // series queue draining first.
  await retryFailedChampionAnnouncements(options);
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    return { deadlineReached: true };
  }
  await retryPendingHonorAnnouncements({
    limit: 1,
    shouldContinue: () => canStartWork(options, MIN_DISCORD_STEP_MS),
  });
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    return { deadlineReached: true };
  }
  const pendingSeries = await nextRecoverableMarker(
    RESULT_ANNOUNCED_PREFIX,
    nowMs,
  );
  if (!pendingSeries) {
    await recoverMissingSeriesAnnouncement(options);
    if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
      return { deadlineReached: true };
    }
    await recoverMissingHonorAnnouncement(options);
    return { deadlineReached: !canStartWork(options) };
  }
  const matchId = pendingSeries.key.slice(RESULT_ANNOUNCED_PREFIX.length);
  const match = await prisma.match.findFirst({
    where: { id: matchId, status: MATCH_STATUS.COMPLETED },
    select: {
      id: true,
      homeTeamId: true,
      awayTeamId: true,
      homeScore: true,
      awayScore: true,
      week: true,
      phase: true,
      forfeit: true,
    },
  });
  // A deleted or reopened match can never authorize this marker generation.
  // Delete by exact value so a concurrent re-completion's newer claim wins.
  if (!match) {
    await prisma.setting.deleteMany({
      where: { key: pendingSeries.key, value: pendingSeries.value },
    });
  } else if (canStartWork(options, MIN_DISCORD_STEP_MS)) {
    await announceSeriesResultOnce(match);
  } else {
    return { deadlineReached: true };
  }
  return { deadlineReached: !canStartWork(options) };
}

/**
 * The champion's half of the same sweep. Kept separate because the marker is
 * keyed by SEASON, not match, and because announceChampionOnce does its own
 * orphan cleanup (an un-crowned season drops the marker instead of retrying
 * forever). Cheap: one indexed prefix scan, and in the overwhelmingly common
 * case it matches nothing.
 */
async function retryFailedChampionAnnouncements(
  options: RunResultSyncOptions,
): Promise<void> {
  const pending = await nextRecoverableMarker(
    CHAMPION_ANNOUNCED_PREFIX,
    Date.now(),
  );
  if (pending && canStartWork(options, MIN_DISCORD_STEP_MS)) {
    await announceChampionOnce(
      pending.key.slice(CHAMPION_ANNOUNCED_PREFIX.length),
    );
  }
  // At most one champion send per pass. A failure backlog is more urgent than
  // discovering the no-marker configuration case below.
  if (pending) return;

  // No webhook at crowning time deliberately leaves NO marker. That is
  // different from a failed send, but it still needs a trigger once Discord is
  // configured later. Only the active completed season and a post-migration
  // completed final are eligible: an active legacy COMPLETE season can exist
  // during rollout and must not replay its old crown merely because no marker
  // was written by the previous binary.
  const activeChampion = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, status: true, championTeamId: true },
    }),
  );
  if (
    activeChampion?.status === SEASON_STATUS.COMPLETE &&
    activeChampion.championTeamId
  ) {
    const [marker, recoverableFinal] = await Promise.all([
      prisma.setting.findUnique({
        where: { key: championAnnouncedKey(activeChampion.id) },
        select: { key: true },
      }),
      prisma.match.findFirst({
        where: {
          seasonId: activeChampion.id,
          phase: MATCH_PHASE.FINAL,
          status: MATCH_STATUS.COMPLETED,
          winnerTeamId: activeChampion.championTeamId,
          completedAt: { not: null },
        },
        select: { id: true },
      }),
    ]);
    if (
      !marker &&
      recoverableFinal &&
      canStartWork(options, MIN_DISCORD_STEP_MS)
    ) {
      await announceChampionOnce(activeChampion.id);
    }
  }
}

/**
 * Reconcile a committed playoff result whose request ended before its
 * post-commit bracket effect. Advancement is idempotent and transactionally
 * revalidates its source round, so every scheduled pass is a safe way back
 * from a process restart or transient database failure.
 */
async function reconcilePlayoffBracket(): Promise<boolean> {
  const season = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, status: true },
    }),
  );
  if (!season || season.status !== SEASON_STATUS.PLAYOFFS) return false;
  return advancePlayoffBracket(season.id);
}

/** One sync pass: league matches + inhouse + due draft clocks. */
export async function runResultSync(
  options: RunResultSyncOptions = {},
): Promise<ResultSyncOutcome> {
  const nowMs = Date.now();
  const issues: string[] = [];
  const skipped: string[] = [];

  type Settled<T> =
    | { status: "fulfilled"; value: T }
    | { status: "rejected"; reason: unknown }
    | { status: "skipped" };
  const settle = async <T>(
    run: () => Promise<T>,
    skippedCode: string,
  ): Promise<Settled<T>> => {
    if (!canStartWork(options)) {
      skipped.push(skippedCode);
      return { status: "skipped" };
    }
    try {
      return { status: "fulfilled", value: await run() };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  };

  // Core league state starts first and remains independent: one corrupt or
  // unavailable workflow cannot suppress the other two.
  const [leagueResult, inhouseResult, draftResult] = await Promise.all([
    settle(() => syncDueMatches(nowMs, options), RESULT_SYNC_SKIPPED.LEAGUE),
    settle(() => syncInhouse(options), RESULT_SYNC_SKIPPED.INHOUSE),
    settle(() => syncDraftClocks(nowMs, options), RESULT_SYNC_SKIPPED.DRAFT),
  ]);

  let league = { imported: 0, watch: false };
  let inhouse = { recorded: false, watch: false };
  let draft = { advanced: false, watch: false };
  if (leagueResult.status === "fulfilled") {
    league = leagueResult.value;
    if (leagueResult.value.deadlineReached) {
      skipped.push(RESULT_SYNC_SKIPPED.LEAGUE);
    }
  } else if (leagueResult.status === "rejected") {
    issues.push(RESULT_SYNC_ISSUE.LEAGUE);
    logStepFailure("league", leagueResult.reason);
  }
  if (inhouseResult.status === "fulfilled") {
    inhouse = inhouseResult.value;
    if (inhouseResult.value.notificationFailed) {
      issues.push(RESULT_SYNC_ISSUE.INHOUSE_NOTIFICATIONS);
    }
    if (inhouseResult.value.deadlineReached) {
      skipped.push(RESULT_SYNC_SKIPPED.INHOUSE);
    }
  } else if (inhouseResult.status === "rejected") {
    issues.push(RESULT_SYNC_ISSUE.INHOUSE);
    logStepFailure("inhouse", inhouseResult.reason);
  }
  if (draftResult.status === "fulfilled") {
    draft = draftResult.value;
    if (draftResult.value.deadlineReached) {
      skipped.push(RESULT_SYNC_SKIPPED.DRAFT);
    }
  } else if (draftResult.status === "rejected") {
    issues.push(RESULT_SYNC_ISSUE.DRAFT);
    logStepFailure("draft", draftResult.reason);
  }

  let playoff = false;
  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    skipped.push(RESULT_SYNC_SKIPPED.PLAYOFF);
  } else {
    try {
      playoff = await reconcilePlayoffBracket();
    } catch (error) {
      issues.push(RESULT_SYNC_ISSUE.PLAYOFF);
      logStepFailure("playoff", error);
    }
  }

  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    skipped.push(RESULT_SYNC_SKIPPED.REMINDER);
  } else {
    try {
      const season = await getActiveSeason();
      if (season) await maybeAnnounceUpcomingWeek(season);
    } catch (error) {
      issues.push(RESULT_SYNC_ISSUE.REMINDER);
      logStepFailure("reminder", error);
    }
  }

  if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
    skipped.push(RESULT_SYNC_SKIPPED.NOTIFICATIONS);
  } else {
    try {
      // Existing durable work goes first. New reminder/result/champion events
      // share the same ordered queue, so one attempt here advances every
      // league announcement family without letting a fresh event jump ahead.
      const delivery = await deliverPendingLeagueAnnouncements({ limit: 1 });
      if (delivery.attempted > delivery.delivered || delivery.blocked) {
        issues.push(RESULT_SYNC_ISSUE.OUTBOX);
      }
      if (!canStartWork(options, MIN_DISCORD_STEP_MS)) {
        skipped.push(RESULT_SYNC_SKIPPED.NOTIFICATIONS);
      } else {
        const notifications = await retryFailedAnnouncements(nowMs, options);
        if (notifications.deadlineReached) {
          skipped.push(RESULT_SYNC_SKIPPED.NOTIFICATIONS);
        }
      }
    } catch (error) {
      issues.push(RESULT_SYNC_ISSUE.NOTIFICATIONS);
      logStepFailure("notifications", error);
    }
  }

  // Read the cursor AFTER the syncs so a result this very run just landed is
  // already reflected in the value handed back.
  let cursor: string | null = null;
  if (!canStartWork(options)) {
    skipped.push(RESULT_SYNC_SKIPPED.CURSOR);
  } else {
    try {
      cursor = await getSetting(SETTING_KEYS.RESULT_CHANGED_AT);
    } catch (error) {
      issues.push(RESULT_SYNC_ISSUE.CURSOR);
      logStepFailure("cursor", error);
    }
  }
  return {
    imported: league.imported,
    inhouse: inhouse.recorded,
    draft: draft.advanced,
    playoff,
    watch: league.watch || inhouse.watch || draft.watch,
    cursor,
    issues: [...new Set(issues)],
    skipped: [...new Set(skipped)],
  };
}
