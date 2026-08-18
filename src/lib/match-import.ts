import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  fetchOpenDotaMatch,
  fetchRecentMatchIds,
  fetchLeagueMatchIds,
  canStartOpenDotaFetch,
  openDotaBudgetExpired,
  type OpenDotaMatch,
  type OpenDotaPlayer,
  type OpenDotaFetchOptions,
} from "./dota";
import { effectiveDotaAccountId } from "./dota-account";
import { advancePlayoffBracket } from "./playoff-service";
import { raceHook } from "./race-hook";
import { markWeekHonorsStale, maybeAnnounceWeekHonors } from "./honors-service";
import {
  getWebhookUrl,
  matchResultMessage,
  sendDiscordMessage,
} from "./discord";
import {
  ANNOUNCE_FAILED_PREFIX,
  getSetting,
  leagueSyncSkipKey,
  resultAnnouncedKey,
  setSetting,
  SETTING_KEYS,
  weekReminderKey,
  claimProviderCooldown,
} from "./settings";
import {
  AUTO_SYNC,
  DOTA_MATCH_KIND,
  MATCH_PHASE,
  MATCH_STATUS,
  SCRIM_STATUS,
} from "./constants";
import { matchResultsOpen } from "./league-lifecycle";
import {
  announcementDedupeKey,
  claimAnnouncementMarker,
  invalidatePendingAnnouncementMarkers,
  markAnnouncementFailed,
  markAnnouncementSent,
  recoverableAnnouncementMarker,
  releaseAnnouncementClaim,
} from "./announcement-marker";
import { invalidateAutomationGateBestEffort } from "./automation-gate-invalidation";
import {
  eligibleScrimMeetingKickoffs,
  isWithinScrimResultWindow,
} from "./scrim-window";

export type TeamAccounts = { teamId: string; accountIds: Set<number> };

/** Marker value recording a send that failed — claimable for a retry. */
// Re-exported for the call sites that already import it from here; the
// definition lives in settings.ts beside the keys it qualifies (see the note
// there — importing it back from this module made a require cycle).
export { ANNOUNCE_FAILED_PREFIX };

/**
 * Announce a decided series to Discord exactly once per match, whichever path
 * completed it (captain import, auto sync, league sync, admin import — and
 * admin recordResult, which claims the same marker before its own send).
 * The marker claim has an expiring lease: concurrent completions still elect
 * one sender, while a process death before enqueue can be recovered. Its event
 * id survives a failed/stale retry and is also the durable outbox dedupe key,
 * closing the enqueue-before-marker-finalize crash gap.
 *
 * A FAILED send doesn't release the marker (unlike honors/reminders, nothing
 * naturally re-triggers this match — the run whose send failed is the run
 * that completed it): it stamps a fenced `failed:v2:<event>:<time>` marker,
 * and the result-sync retry sweep atomically re-claims those plus expired
 * leases. Markerless recovery is restricted to active-season rows carrying
 * the post-migration completion stamp, so historical sent/results never replay.
 */
export async function announceSeriesResultOnce(match: {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  week: number;
  phase: string;
  forfeit?: boolean;
}): Promise<boolean> {
  const marker = resultAnnouncedKey(match.id);

  // An installation with no league webhook is an intentional silent mode, not
  // an announcement backlog. Persist that decision beside the committed
  // result so configuring Discord later cannot replay a season's old scores.
  // The same-value update locks/revalidates the Match row in this transaction:
  // if Reopen wins first, no marker is inserted; if this wins first, Reopen's
  // transactional marker delete runs afterwards.
  if (!(await getWebhookUrl())) {
    // Test seam: a result can be reopened after the caller decided it needed
    // an announcement but before silent-mode suppression claims the row.
    await raceHook(
      "match-import.announceSeriesResultOnce.beforeSilentModeClaim",
    );
    // PostgreSQL's default READ COMMITTED isolation is deliberate here. The
    // same-value Match UPDATE still takes the row lock that orders this command
    // against Reopen, while a marker changed on another row between our read
    // and CAS re-evaluates to zero instead of aborting the whole post-commit
    // effect with P2034. SERIALIZABLE made that intended CAS indistinguishable
    // from a deadlock even though no cross-row snapshot invariant is needed.
    await prisma.$transaction(async (tx) => {
      const current = await tx.match.updateMany({
        where: { id: match.id, status: MATCH_STATUS.COMPLETED },
        data: { status: MATCH_STATUS.COMPLETED },
      });
      if (current.count !== 1) return;
      const value = `suppressed:no-webhook:${new Date().toISOString()}`;
      const existing = await tx.setting.findUnique({
        where: { key: marker },
        select: { value: true },
      });
      if (!existing) {
        await tx.$executeRaw`
            INSERT INTO "Setting" ("key", "value")
            VALUES (${marker}, ${value})
            ON CONFLICT ("key") DO NOTHING
          `;
      } else if (recoverableAnnouncementMarker(existing.value)) {
        // A failed/expired generation must not remain at the head of the
        // retry sweep forever after an administrator disables Discord.
        await raceHook(
          "match-import.announceSeriesResultOnce.beforeSilentMarkerRetire",
        );
        await tx.setting.updateMany({
          where: { key: marker, value: existing.value },
          data: { value },
        });
      }
    });
    return false;
  }

  const claim = await claimAnnouncementMarker(marker);
  if (!claim) return false;

  // Post-commit effects can resume after an administrator has already reopened
  // or corrected the result. Never let that stale caller manufacture a fresh,
  // source-authorized event from its old in-memory score. The durable outbox
  // performs the second marker check immediately before transport; this read
  // closes the earlier claim-from-a-stale-snapshot gap.
  const current = await prisma.match.findUnique({
    where: { id: match.id },
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
  if (!current || current.status !== MATCH_STATUS.COMPLETED) {
    await releaseAnnouncementClaim(claim);
    return false;
  }
  const [home, away] = await Promise.all([
    prisma.team.findUnique({ where: { id: current.homeTeamId } }),
    prisma.team.findUnique({ where: { id: current.awayTeamId } }),
  ]);
  if (!home || !away) {
    // Practically unreachable while the match exists (Match→Team is
    // FK-RESTRICT), but a bare return here used to burn the marker. Fenced
    // failure finalization keeps it retryable without overwriting a rival
    // generation; orphan cleanup handles a match deleted mid-flight.
    await markAnnouncementFailed(claim);
    return false;
  }
  const sent = await sendDiscordMessage(
    matchResultMessage({
      homeName: home.name,
      awayName: away.name,
      homeScore: current.homeScore,
      awayScore: current.awayScore,
      week: current.week,
      isPlayoff: current.phase !== MATCH_PHASE.REGULAR,
      forfeit: current.forfeit,
    }),
    undefined,
    {
      dedupeKey: announcementDedupeKey("series", claim),
      marker: { key: claim.key, eventId: claim.eventId },
    },
  );
  if (!sent) {
    // A Discord blip must not permanently eat the announcement — flag the
    // marker for the sync sweep to retry.
    await markAnnouncementFailed(claim);
    return false;
  }
  return markAnnouncementSent(claim);
}

export type GameClassification = {
  ok: boolean;
  reason?: string;
  radiantTeamId: string | null;
  direTeamId: string | null;
  winnerTeamId: string | null;
};

/**
 * Decide whether a fetched Dota game is a match between our two teams, and if so
 * which side each team played and who won. Pure so it can be unit-tested with
 * fixtures. Requires at least `minPerSide` known players from each team, on
 * opposite sides — tolerating a couple of unknown accounts (smurfs/standins).
 */
export function classifyGame(
  match: OpenDotaMatch,
  teamA: TeamAccounts,
  teamB: TeamAccounts,
  minPerSide = 3,
): GameClassification {
  const fail = (reason: string): GameClassification => ({
    ok: false,
    reason,
    radiantTeamId: null,
    direTeamId: null,
    winnerTeamId: null,
  });

  // Legacy profile versions allowed unproved Dota-account overrides. Owner
  // login now retires those claims, but historical data can still put one
  // effective account on both rosters until that owner next authenticates.
  // Fail closed before counting or attributing a box score: one player can
  // never be evidence for both competing teams.
  for (const accountId of teamA.accountIds) {
    if (teamB.accountIds.has(accountId)) {
      return fail(
        "A Dota account is linked to players on both teams — correct the account links before importing",
      );
    }
  }

  let radA = 0,
    direA = 0,
    radB = 0,
    direB = 0;
  for (const p of match.players) {
    if (p.account_id == null) continue;
    const isRadiant = p.isRadiant ?? p.player_slot < 128;
    if (teamA.accountIds.has(p.account_id)) {
      if (isRadiant) radA++;
      else direA++;
    }
    if (teamB.accountIds.has(p.account_id)) {
      if (isRadiant) radB++;
      else direB++;
    }
  }

  const aRadiant = radA >= direA;
  const bRadiant = radB >= direB;
  const aCount = aRadiant ? radA : direA;
  const bCount = bRadiant ? radB : direB;

  if (aCount === 0 || bCount === 0)
    return fail("Both teams' players were not found in this game");
  if (aRadiant === bRadiant)
    return fail("Both teams appear on the same side — not a league match");
  if (aCount < minPerSide || bCount < minPerSide)
    return fail("Not enough rostered players from each team in this game");

  const radiantTeamId = aRadiant ? teamA.teamId : teamB.teamId;
  const direTeamId = aRadiant ? teamB.teamId : teamA.teamId;
  const winnerTeamId = match.radiant_win ? radiantTeamId : direTeamId;
  return { ok: true, radiantTeamId, direTeamId, winnerTeamId };
}

/** Max gap between consecutive games of one series. A real Bo2/Bo3 is played
 *  back-to-back; a bigger gap means a different session entirely (a scrim, a
 *  prior meeting, a rematch for fun the next day). */
export const SERIES_SESSION_GAP_MS = 4 * 60 * 60 * 1000;
/** A Bo2 is commonly two separately-created Bo1 lobbies. Allow a longer
 * between-lobby break when those are the only two candidates. If an extra
 * candidate exists, keep the tighter session boundary so an earlier warm-up
 * cannot be swept into the official series. Fixture-window and closest-meeting
 * checks still run before this selection. */
export const BO2_SERIES_SESSION_GAP_MS = 8 * 60 * 60 * 1000;

/** How long one roster scan may spend fetching candidate games. */
export const SCAN_BUDGET_MS = 25_000;

/** How far either side of its kickoff a game may sit and still belong to a
 *  match. Generous backwards because amateur teams often play early without
 *  filing a reschedule; mis-attribution is prevented by `claimsGame` below,
 *  not by keeping this window tight. */
export const DETECT_WINDOW_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;
export const DETECT_WINDOW_AFTER_MS = 6 * 24 * 60 * 60 * 1000;

/** Candidate eligibility for one scheduled league fixture. */
export function isWithinLeagueResultWindow(
  startTimeSeconds: number,
  scheduledAtMs: number,
): boolean {
  const gameStartMs = Number(startTimeSeconds) * 1000;
  return (
    Number.isFinite(gameStartMs) &&
    gameStartMs > 0 &&
    gameStartMs >= scheduledAtMs - DETECT_WINDOW_BEFORE_MS &&
    gameStartMs <= scheduledAtMs + DETECT_WINDOW_AFTER_MS
  );
}

/**
 * Candidate-specific arbitration set. A nearby meeting only competes when the
 * candidate is inside that meeting's own result window; proximity alone cannot
 * assign a game to an event that would refuse to import it.
 */
export function eligibleCompetingMeetingKickoffs(
  startTimeSeconds: number,
  meetings: {
    league: readonly number[];
    scrims: readonly number[];
  },
): number[] {
  return [
    ...meetings.league.filter((kickoffMs) =>
      isWithinLeagueResultWindow(startTimeSeconds, kickoffMs),
    ),
    ...eligibleScrimMeetingKickoffs(startTimeSeconds, meetings.scrims),
  ];
}

/**
 * May THIS match claim a game, given the other unplayed meetings between the
 * same two teams?
 *
 * Two teams meet more than once (a double round robin, or a playoff rematch),
 * and an unimported fixture stays a live candidate forever. Windowing alone let
 * the wrong meeting win: a regular-season game played the day before a playoff
 * kickoff sat inside the playoff match's window, so the bracket advanced on a
 * regular-season result. A game belongs to whichever meeting it is closest to.
 *
 * Ties refuse the claim — with two meetings equidistant there is no honest
 * answer, and the admin/captain can still import by match id.
 */
export function claimsGame(
  gameStartMs: number,
  thisKickoffMs: number,
  otherKickoffsMs: number[],
): boolean {
  const mine = Math.abs(gameStartMs - thisKickoffMs);
  return otherKickoffsMs.every((o) => Math.abs(gameStartMs - o) > mine);
}

export type SeriesCandidate = {
  id: number;
  /** OpenDota start_time, in SECONDS. */
  startTime: number;
  winnerTeamId: string | null;
};

/**
 * Choose which of the candidate games actually make up this series.
 *
 * This used to take the most RECENT `bestOf` games, which silently recorded the
 * wrong result whenever two teams played an extra game after the series: a Bo2
 * that went 2-0 plus one for fun was imported as games 2+3 and recorded 1-1, a
 * draw, with no error anywhere (standings, tiebreaks, pick'em grading and the
 * Discord post all took the wrong result).
 *
 * Instead: split the candidates into sessions on a >4h gap, take the session
 * with the most games (ties go to the most recent, which preserves the original
 * "a stale scrim never beats the night just played" property), then walk that
 * session in PLAY order and stop as soon as one side has clinched. The bonus
 * game after a decided series is never part of the record.
 */
export function pickSeriesGames<T extends SeriesCandidate>(
  candidates: T[],
  bestOf: number,
): T[] {
  if (candidates.length === 0) return [];
  const sorted = [...candidates].sort((a, b) => a.startTime - b.startTime);

  const sessions: T[][] = [];
  let cur: T[] = [sorted[0]!];
  const sessionGapMs =
    bestOf === 2 && sorted.length === 2
      ? BO2_SERIES_SESSION_GAP_MS
      : SERIES_SESSION_GAP_MS;
  for (let i = 1; i < sorted.length; i++) {
    const gapMs = (sorted[i]!.startTime - sorted[i - 1]!.startTime) * 1000;
    if (gapMs > sessionGapMs) {
      sessions.push(cur);
      cur = [sorted[i]!];
    } else {
      cur.push(sorted[i]!);
    }
  }
  sessions.push(cur);

  let best = sessions[0]!;
  for (const s of sessions) {
    if (
      s.length > best.length ||
      (s.length === best.length && s[0]!.startTime > best[0]!.startTime)
    ) {
      best = s;
    }
  }

  const cap = Math.max(1, bestOf);
  const need = Math.floor(cap / 2) + 1; // wins that decide the series
  const wins = new Map<string, number>();
  const out: T[] = [];
  for (const g of best) {
    if (out.length >= cap) break;
    out.push(g);
    if (!g.winnerTeamId) continue; // a draw/void game decides nothing
    const n = (wins.get(g.winnerTeamId) ?? 0) + 1;
    wins.set(g.winnerTeamId, n);
    if (n >= need) break; // clinched — anything after this is a bonus game
  }
  return out;
}

type MatchRow = {
  id: string;
  seasonId: string;
  homeTeamId: string;
  awayTeamId: string;
  phase: string;
};

/** Build the account-id sets (roster + standins) for a scheduled match's teams. */
export async function gatherTeamAccounts(match: MatchRow) {
  // Select-narrowed: this runs on every import AND every auto-sync roster
  // scan, and only the identity fields read by `add` are selected.
  const userSelect = {
    id: true,
    name: true,
    steamId: true,
    dotaAccountIdV2: true,
    legacyDotaAccountId: true,
  } as const;
  const [season, members, standins, registrants] = await Promise.all([
    prisma.season.findUnique({
      where: { id: match.seasonId },
      select: { teamSize: true },
    }),
    prisma.teamMember.findMany({
      where: {
        seasonId: match.seasonId,
        teamId: { in: [match.homeTeamId, match.awayTeamId] },
      },
      select: { teamId: true, user: { select: userSelect } },
    }),
    prisma.standinAssignment.findMany({
      where: { matchId: match.id },
      select: { teamId: true, standin: { select: userSelect } },
    }),
    // Attribution fallback: a player released between playing and importing
    // has no TeamMember row anymore, but their line should still carry their
    // userId (career, fantasy, honors). They stay OUT of the team account
    // sets, so classifyGame remains roster-strict.
    prisma.registration.findMany({
      where: { seasonId: match.seasonId },
      select: { user: { select: userSelect } },
    }),
  ]);

  const accountMap = new Map<
    number,
    { userId: string; name: string; teamId: string | null }
  >();
  const homeSet = new Set<number>();
  const awaySet = new Set<number>();

  const add = (
    user: {
      id: string;
      name: string;
      steamId: string;
      dotaAccountIdV2: number | null;
      legacyDotaAccountId: number | null;
    },
    teamId: string,
  ) => {
    const acc = effectiveDotaAccountId(user);
    if (acc == null) return;
    accountMap.set(acc, { userId: user.id, name: user.name, teamId });
    (teamId === match.homeTeamId ? homeSet : awaySet).add(acc);
  };

  for (const m of members) add(m.user, m.teamId);
  for (const s of standins) add(s.standin, s.teamId);

  // Registered-but-unrostered users map for attribution only (teamId null) —
  // never added to homeSet/awaySet, so classification is unaffected.
  for (const r of registrants) {
    const acc = effectiveDotaAccountId(r.user);
    if (acc == null || accountMap.has(acc)) continue;
    accountMap.set(acc, { userId: r.user.id, name: r.user.name, teamId: null });
  }

  return { accountMap, homeSet, awaySet, teamSize: season?.teamSize ?? 5 };
}

/**
 * Keep only benchmark entries whose percentile is a real number — OpenDota
 * occasionally sends nulls/objects with missing pct, and an empty map is
 * stored as null so old and new lines degrade the same way. Exported for tests.
 */
export function sanitizeBenchmarks(
  raw: OpenDotaPlayer["benchmarks"],
): Record<string, { raw: number | null; pct: number }> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, { raw: number | null; pct: number }> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!v || typeof v.pct !== "number" || !Number.isFinite(v.pct)) continue;
    out[key] = {
      raw: typeof v.raw === "number" && Number.isFinite(v.raw) ? v.raw : null,
      // OpenDota pct is 0..1; clamp defensively so stored data is always sane.
      pct: Math.min(1, Math.max(0, v.pct)),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Shape a fetched game's players into the stored box-score JSON lines. */
export function buildPlayers(
  match: OpenDotaMatch,
  accountMap: Map<
    number,
    { userId: string; name: string; teamId: string | null }
  >,
) {
  return match.players.map((p) => {
    const isRadiant = p.isRadiant ?? p.player_slot < 128;
    const mapped =
      p.account_id != null ? accountMap.get(p.account_id) : undefined;
    return {
      accountId: p.account_id,
      heroId: p.hero_id,
      isRadiant,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      personaname: p.personaname ?? null,
      netWorth: p.net_worth ?? null,
      gpm: p.gold_per_min ?? null,
      lastHits: p.last_hits ?? null,
      xpm: p.xp_per_min ?? null,
      denies: p.denies ?? null,
      level: p.level ?? null,
      heroDamage: p.hero_damage ?? null,
      towerDamage: p.tower_damage ?? null,
      heroHealing: p.hero_healing ?? null,
      benchmarks: sanitizeBenchmarks(p.benchmarks),
      userId: mapped?.userId ?? null,
      teamId: mapped?.teamId ?? null,
    };
  });
}

export type PlayerStat = ReturnType<typeof buildPlayers>[number];

/**
 * Thrown from inside importGameForMatch's write transaction when the series
 * changed under it during the OpenDota fetch. A throw, not a return: the
 * callback's resolution would COMMIT, and the point is to roll back.
 */
class ImportRaceError extends Error {}

// PostgreSQL can abort this Serializable write when a reminder is claimed or
// finalized at the same moment the first game moves a fixture out of
// SCHEDULED. Retrying only the database command is safe: the OpenDota payload
// has already been fetched and classified, while every lifecycle/capacity
// guard is re-read inside each attempt. Keep the cap small so a genuinely hot
// fixture returns control instead of extending an automation invocation.
const IMPORT_TRANSACTION_MAX_ATTEMPTS = 3;

export type SeriesProjection = {
  homeScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  status: string;
  decided: boolean;
};

/** The Match row is a projection of its imported games, never a second source
 * of truth. Kept pure so insert, delete, repair, and tests share one rule. */
export function deriveSeriesProjection(
  match: {
    homeTeamId: string;
    awayTeamId: string;
    bestOf: number;
  },
  games: { winnerTeamId: string | null }[],
): SeriesProjection {
  const homeScore = games.filter(
    (game) => game.winnerTeamId === match.homeTeamId,
  ).length;
  const awayScore = games.filter(
    (game) => game.winnerTeamId === match.awayTeamId,
  ).length;
  const clinchAt = Math.floor(match.bestOf / 2) + 1;
  const decided =
    homeScore >= clinchAt ||
    awayScore >= clinchAt ||
    homeScore + awayScore >= match.bestOf;
  return {
    homeScore,
    awayScore,
    decided,
    winnerTeamId: !decided
      ? null
      : homeScore > awayScore
        ? match.homeTeamId
        : awayScore > homeScore
          ? match.awayTeamId
          : null,
    status: decided
      ? MATCH_STATUS.COMPLETED
      : games.length > 0
        ? MATCH_STATUS.LIVE
        : MATCH_STATUS.SCHEDULED,
  };
}

const readMatch = (matchId: string) =>
  prisma.match.findUnique({ where: { id: matchId }, include: { games: true } });

/** Recompute a league match's series score from its imported games. */
export async function recomputeSeries(matchId: string) {
  // COMPARE-AND-SWAP, retried: the score is DERIVED from the game list, so a
  // caller that read a smaller list must never overwrite a fresher result.
  // Games 2 and 3 of a Bo3 can be imported by two requests at once (a captain
  // report and an auto-sync scan, or two /api/sync pings), and with a blind
  // `update({ where: { id } })` the stale caller wrote LAST: the series
  // reverted to 1-1 LIVE with three games recorded, having already announced
  // itself and advanced the bracket. Nothing repaired it either — auto-sync
  // only rescans for NEW games, and there were none left to find.
  //
  // On a lost swap we re-read and recompute rather than skipping, because
  // "who wrote last" does not tell us who read more games; recomputing from
  // the current rows converges on the truth whichever caller wins.
  let match!: NonNullable<Awaited<ReturnType<typeof readMatch>>>;
  let homeWins = 0;
  let awayWins = 0;
  let decided = false;
  let winnerTeamId: string | null = null;
  let won = false;

  for (let attempt = 0; attempt < 3 && !won; attempt++) {
    const fresh = await readMatch(matchId);
    if (!fresh) return;
    match = fresh;
    // Seam: a rival import landing between this read and the swap below — the
    // interleaving the CAS exists for, and one `Promise.all` cannot steer,
    // because both racers have to read a DIFFERENT game list and the loser has
    // to write second. Fires once per attempt; the retry re-reads.
    await raceHook("match-import.recomputeSeries.beforeSwap");

    const projection = deriveSeriesProjection(match, match.games);
    homeWins = projection.homeScore;
    awayWins = projection.awayScore;
    decided = projection.decided;
    winnerTeamId = projection.winnerTeamId;
    const status = projection.status;
    // Nothing to write and nothing to announce — the row already says this.
    if (
      match.homeScore === homeWins &&
      match.awayScore === awayWins &&
      match.status === status &&
      match.winnerTeamId === winnerTeamId
    ) {
      return;
    }
    won = await prisma.$transaction(async (tx) => {
      const swap = await tx.match.updateMany({
        where: {
          id: matchId,
          homeScore: match.homeScore,
          awayScore: match.awayScore,
          status: match.status,
        },
        data: {
          homeScore: homeWins,
          awayScore: awayWins,
          winnerTeamId,
          status,
          // A meaningful post-deploy COMPLETE→COMPLETE correction must become
          // recoverable even when the untouched historical row had the
          // migration's deliberate completedAt=null sentinel.
          completedAt: decided ? new Date() : null,
        },
      });
      if (swap.count !== 1) return false;

      // Result state and every queued message derived from the old state move
      // together. A crash can no longer leave an obsolete reminder/result/
      // honors marker authorized after the winning score projection commits.
      if (
        match.scheduledAt &&
        match.status === MATCH_STATUS.SCHEDULED &&
        status !== MATCH_STATUS.SCHEDULED
      ) {
        await invalidatePendingAnnouncementMarkers(
          tx,
          weekReminderKey(
            match.seasonId,
            match.week,
            match.scheduledAt.getTime(),
          ),
        );
      }
      if (!decided || match.status === MATCH_STATUS.COMPLETED) {
        await tx.setting.deleteMany({
          where: { key: resultAnnouncedKey(matchId) },
        });
      }
      if (
        match.phase === MATCH_PHASE.REGULAR &&
        match.status === MATCH_STATUS.COMPLETED
      ) {
        await markWeekHonorsStale(tx, match.seasonId, match.week);
      }
      return true;
    });
  }
  // Three lost swaps means another caller is actively rewriting this series;
  // its own recompute carries the announce and the bracket advance, so
  // dropping out here loses nothing.
  if (!won) return;

  // A freshly decided series announces itself (idempotent claim) — imported
  // results used to reach Discord only when an admin typed the score in.
  if (decided) {
    await announceSeriesResultOnce({
      id: match.id,
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      homeScore: homeWins,
      awayScore: awayWins,
      week: match.week,
      phase: match.phase,
    });
  }

  // Advance the playoff bracket only once the series has a decided winner.
  if (match.phase !== MATCH_PHASE.REGULAR && decided && winnerTeamId) {
    await advancePlayoffBracket(match.seasonId);
  }
  // Once a regular week's last series wraps, its honors go out (idempotent).
  if (match.phase === MATCH_PHASE.REGULAR && decided) {
    await maybeAnnounceWeekHonors(match.seasonId, match.week);
  }
}

export type ImportResult =
  | ({ ok: true; downstreamPending?: boolean } & SeriesProjection)
  | { ok: false; error: string; deadlineReached?: boolean };

export type ImportGameOptions = {
  /** Re-assert captaincy in the decisive write snapshot after OpenDota I/O. */
  expectedCaptainId?: string;
  /** Captain-entered IDs must belong to this fixture, not an old scrim/rematch. */
  enforceFixtureWindow?: boolean;
  /** Authenticated manual caller. Omit for bounded automation-owned imports. */
  providerActorId?: string;
  /** Automation-only absolute budget. Manual callers omit both fields. */
  deadlineMs?: number;
  signal?: AbortSignal;
};

/** Fetch a specific Dota match and record it against a scheduled league match. */
export async function importGameForMatch(
  matchId: string,
  dotaMatchId: string,
  options: ImportGameOptions = {},
): Promise<ImportResult> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      games: { select: { id: true } },
      season: { select: { isActive: true, status: true } },
      homeTeam: { select: { captainId: true } },
      awayTeam: { select: { captainId: true } },
    },
  });
  if (!match) return { ok: false, error: "Unknown league match" };

  if (
    !match.season.isActive ||
    !matchResultsOpen(match.season.status, match.phase)
  ) {
    return {
      ok: false,
      error:
        "Results are locked for this fixture in the league's current phase",
    };
  }
  if (
    options.expectedCaptainId &&
    match.homeTeam.captainId !== options.expectedCaptainId &&
    match.awayTeam.captainId !== options.expectedCaptainId
  ) {
    return {
      ok: false,
      error: "You no longer captain either team in this match",
    };
  }

  // A decided series is closed to further imports, because recomputeSeries
  // would silently rewrite the standing result. This used to check
  // `games.length === 0`, which only caught the pure manual-entry case: a Bo3
  // that team B forfeited after game 1 is COMPLETED 2-0 with ONE game, so
  // `games.length < bestOf` let a later import through and quietly replaced the
  // admin's forfeit ruling. Auto-sync and league sync already skip COMPLETED
  // matches; this closes the manual paths (admin "Add game", captain report).
  if (match.status === MATCH_STATUS.COMPLETED) {
    return {
      ok: false,
      error:
        match.games.length === 0
          ? "This match's result was recorded manually — reopen it first if you want to import its games"
          : "This series is already final — remove one of its games first if you need to correct it",
    };
  }
  // A series only holds bestOf games; a Bo1 with two games is a mis-attribution.
  if (match.games.length >= match.bestOf) {
    return {
      ok: false,
      error: `This best-of-${match.bestOf} already has all ${match.bestOf} of its games`,
    };
  }

  const [existing, existingScrim, existingClaim] = await Promise.all([
    prisma.game.findUnique({ where: { dotaMatchId } }),
    prisma.scrimGame.findUnique({ where: { dotaMatchId } }),
    prisma.dotaMatchClaim.findUnique({ where: { dotaMatchId } }),
  ]);
  if (existing) {
    return existing.matchId === matchId
      ? { ok: false, error: "That game is already recorded here" }
      : { ok: false, error: "That game is already recorded for another match" };
  }
  if (existingScrim || existingClaim) {
    return {
      ok: false,
      error:
        existingClaim?.kind === DOTA_MATCH_KIND.SCRIM || existingScrim
          ? "That game is already recorded as a scrim"
          : "That game is already reserved for another scheduled event",
    };
  }

  const fetchOptions: OpenDotaFetchOptions = {
    deadlineMs: options.deadlineMs,
    signal: options.signal,
  };
  if (!canStartOpenDotaFetch(fetchOptions)) {
    return {
      ok: false,
      error: "Automatic result sync reached its work deadline",
      deadlineReached: true,
    };
  }
  if (options.providerActorId) {
    const providerClaim = await claimProviderCooldown(
      "open-dota-match-import",
      options.providerActorId,
      `fixture:${match.id}`,
    );
    if (providerClaim === "cooldown") {
      return {
        ok: false,
        error:
          "A Dota match ID was checked for this fixture recently — wait about a minute before trying another ID",
      };
    }
    if (providerClaim === "unavailable") {
      return {
        ok: false,
        error:
          "Couldn't safely start the OpenDota lookup — wait a minute and try again",
      };
    }
  }
  const od = await fetchOpenDotaMatch(dotaMatchId, fetchOptions);
  if (!od) {
    if (openDotaBudgetExpired(fetchOptions)) {
      return {
        ok: false,
        error: "Automatic result sync reached its work deadline",
        deadlineReached: true,
      };
    }
    return {
      ok: false,
      error:
        "Could not fetch that match from OpenDota (is the id correct and the match public?)",
    };
  }

  if (options.enforceFixtureWindow) {
    if (!match.scheduledAt) {
      return {
        ok: false,
        error:
          "This fixture has no kickoff time, so the site cannot verify which meeting this game belongs to — ask an admin to import it",
      };
    }
    const gameStartMs = Number(od.start_time) * 1000;
    const kickoffMs = match.scheduledAt.getTime();
    if (!isWithinLeagueResultWindow(od.start_time, kickoffMs)) {
      return {
        ok: false,
        error:
          "That Dota game is outside this fixture's result window — ask an admin if the kickoff was recorded incorrectly",
      };
    }
    const [otherMeetings, scrimMeetings] = await Promise.all([
      prisma.match.findMany({
        where: {
          seasonId: match.seasonId,
          id: { not: match.id },
          scheduledAt: { not: null },
          OR: [
            {
              homeTeamId: match.homeTeamId,
              awayTeamId: match.awayTeamId,
            },
            {
              homeTeamId: match.awayTeamId,
              awayTeamId: match.homeTeamId,
            },
          ],
        },
        select: { scheduledAt: true },
      }),
      prisma.scrim.findMany({
        where: {
          seasonId: match.seasonId,
          status: {
            in: [
              SCRIM_STATUS.SCHEDULED,
              SCRIM_STATUS.LIVE,
              SCRIM_STATUS.COMPLETED,
            ],
          },
          OR: [
            {
              hostTeamId: match.homeTeamId,
              opponentTeamId: match.awayTeamId,
            },
            {
              hostTeamId: match.awayTeamId,
              opponentTeamId: match.homeTeamId,
            },
          ],
        },
        select: { scheduledAt: true },
      }),
    ]);
    if (
      !claimsGame(
        gameStartMs,
        kickoffMs,
        eligibleCompetingMeetingKickoffs(od.start_time, {
          league: otherMeetings.map((other) => other.scheduledAt!.getTime()),
          scrims: scrimMeetings.map((other) => other.scheduledAt.getTime()),
        }),
      )
    ) {
      return {
        ok: false,
        error:
          "That Dota game is closer to another meeting between these teams — import it there instead",
      };
    }
  }

  const { accountMap, homeSet, awaySet, teamSize } =
    await gatherTeamAccounts(match);
  const cls = classifyGame(
    od,
    { teamId: match.homeTeamId, accountIds: homeSet },
    { teamId: match.awayTeamId, accountIds: awaySet },
    Math.min(3, teamSize),
  );
  if (!cls.ok)
    return {
      ok: false,
      error: cls.reason ?? "Game does not match these teams",
    };

  let committed:
    | {
        projection: SeriesProjection;
        priorStatus: string;
        seasonId: string;
        homeTeamId: string;
        awayTeamId: string;
        week: number;
        phase: string;
      }
    | undefined;
  for (
    let attempt = 0;
    attempt < IMPORT_TRANSACTION_MAX_ATTEMPTS && !committed;
    attempt++
  ) {
    try {
      // The two guards above (not COMPLETED, under bestOf) were evaluated on a
      // snapshot taken BEFORE an OpenDota round trip of up to 8s — long enough
      // for an admin forfeit ruling or a rival import to close the series or
      // fill its last slot. `dotaMatchId` being unique stops the same game
      // landing twice, but nothing stopped a DIFFERENT game being added to a
      // series that had since finished, and the recomputeSeries below would then
      // rewrite the standing result.
      //
      // So re-check inside the write, at SERIALIZABLE: both racers read this
      // match's game rows and both insert into that set, which is the rw-conflict
      // SSI aborts one of (P2034 below). Throwing rather than returning keeps
      // the rollback honest, and the errors match the pre-fetch wording.
      committed = await prisma.$transaction(
        async (tx) => {
          const fresh = await tx.match.findUnique({
            where: { id: matchId },
            select: {
              id: true,
              seasonId: true,
              homeTeamId: true,
              awayTeamId: true,
              phase: true,
              week: true,
              scheduledAt: true,
              status: true,
              bestOf: true,
              games: { select: { winnerTeamId: true } },
              homeTeam: { select: { captainId: true } },
              awayTeam: { select: { captainId: true } },
              season: {
                select: {
                  isActive: true,
                  status: true,
                  fantasyLockedAt: true,
                  // Read Draft as part of the lifecycle snapshot. Abort writes
                  // it while deleting the schedule, giving PostgreSQL SSI the
                  // cross-aggregate conflict needed to pick one winner.
                  draft: { select: { status: true } },
                },
              },
            },
          });
          if (!fresh) throw new ImportRaceError("Unknown league match");
          if (
            !fresh.season.isActive ||
            !matchResultsOpen(fresh.season.status, fresh.phase)
          ) {
            throw new ImportRaceError(
              "The league phase or schedule changed — reload before importing",
            );
          }
          if (
            options.expectedCaptainId &&
            fresh.homeTeam.captainId !== options.expectedCaptainId &&
            fresh.awayTeam.captainId !== options.expectedCaptainId
          ) {
            throw new ImportRaceError(
              "You no longer captain either team in this match",
            );
          }
          if (fresh.status === MATCH_STATUS.COMPLETED) {
            throw new ImportRaceError(
              "This series is already final — remove one of its games first if you need to correct it",
            );
          }
          if (fresh.games.length >= fresh.bestOf) {
            throw new ImportRaceError(
              `This best-of-${fresh.bestOf} already has all ${fresh.bestOf} of its games`,
            );
          }
          // One global claim arbitrates official games and casual scrims. The
          // two result tables deliberately stay separate so scrim stats can
          // never leak into league roll-ups, but this shared unique key keeps
          // the same Valve match from being counted once in each system.
          await tx.dotaMatchClaim.create({
            data: {
              dotaMatchId: String(od.match_id),
              kind: DOTA_MATCH_KIND.LEAGUE,
              contextId: matchId,
            },
          });
          await tx.game.create({
            data: {
              matchId,
              dotaMatchId: String(od.match_id),
              radiantWin: od.radiant_win,
              durationSecs: od.duration,
              startTime: od.start_time,
              radiantScore: od.radiant_score ?? 0,
              direScore: od.dire_score ?? 0,
              radiantTeamId: cls.radiantTeamId,
              direTeamId: cls.direTeamId,
              winnerTeamId: cls.winnerTeamId,
              players: JSON.stringify(buildPlayers(od, accountMap)),
            },
          });
          // Fantasy is a one-way competitive lock. Stamping the Season row in
          // the same Serializable command as the first imported game gives the
          // roster action an overlapping read/write boundary with import: either
          // the roster commits before the game, or it sees/loses cleanly to this
          // marker. The timestamp is never cleared by game correction, because
          // performance information has already been exposed at that point.
          if (!fresh.season.fantasyLockedAt) {
            await tx.season.updateMany({
              where: { id: fresh.seasonId, fantasyLockedAt: null },
              data: { fantasyLockedAt: new Date() },
            });
          }
          const projection = deriveSeriesProjection(fresh, [
            ...fresh.games,
            { winnerTeamId: cls.winnerTeamId },
          ]);
          // Game + derived series row + freshness cursor are one command. A
          // process exit can delay Discord/bracket effects, but it can no longer
          // leave a recorded Game attached to a stale 0-0 SCHEDULED match that
          // every future scanner skips as "already imported".
          await tx.match.update({
            where: { id: matchId },
            data: {
              homeScore: projection.homeScore,
              awayScore: projection.awayScore,
              winnerTeamId: projection.winnerTeamId,
              status: projection.status,
              completedAt: projection.decided ? new Date() : null,
              forfeit: false,
              autoSyncAttempts: 0,
            },
          });
          if (
            fresh.scheduledAt &&
            fresh.status === MATCH_STATUS.SCHEDULED &&
            projection.status !== MATCH_STATUS.SCHEDULED
          ) {
            // Test seam: a reminder finalizing after this Serializable command
            // took its snapshot is the production conflict that requires the
            // bounded retry around this transaction.
            await raceHook(
              "match-import.importGame.beforeReminderInvalidation",
            );
            await invalidatePendingAnnouncementMarkers(
              tx,
              weekReminderKey(
                fresh.seasonId,
                fresh.week,
                fresh.scheduledAt.getTime(),
              ),
            );
          }
          const changedAt = new Date().toISOString();
          await tx.setting.upsert({
            where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
            create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value: changedAt },
            update: { value: changedAt },
          });
          return {
            projection,
            priorStatus: fresh.status,
            seasonId: fresh.seasonId,
            homeTeamId: fresh.homeTeamId,
            awayTeamId: fresh.awayTeamId,
            week: fresh.week,
            phase: fresh.phase,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      if (e instanceof ImportRaceError) return { ok: false, error: e.message };
      // The dedupe check above races with concurrent imports (an OpenDota
      // fetch sits between check and create) — the unique index is the real
      // arbiter.
      if ((e as { code?: string }).code === "P2002") {
        return {
          ok: false,
          error: "That game was just recorded by someone else",
        };
      }
      if ((e as { code?: string }).code === "P2034") {
        // A reminder marker can be the conflicting writer even when no rival
        // imported this game. Start a new Serializable snapshot so reminder
        // invalidation remains atomic with the game/result mutation. A true
        // rival import is then observed by the guards or unique constraint.
        if (attempt + 1 < IMPORT_TRANSACTION_MAX_ATTEMPTS) continue;
        return {
          ok: false,
          error:
            "This fixture changed while the game was being recorded — try again",
        };
      }
      throw e;
    }
  }

  if (!committed)
    throw new Error("Import committed without a series projection");

  // Signal immediately after each durable game write. Auto-detect and league
  // sync can import several games in a loop; if a later iteration or
  // post-commit effect fails, earlier imports must still wake/rebuild the gate.
  invalidateAutomationGateBestEffort();

  // External effects are deliberately post-commit: OpenDota data and the
  // series projection are durable even if Discord or bracket reconciliation
  // has a transient failure. The heartbeat re-runs playoff advancement, while
  // failed announcement markers remain claimable by its retry sweep.
  const effects: Promise<unknown>[] = [];
  if (
    committed.projection.decided &&
    committed.priorStatus !== MATCH_STATUS.COMPLETED
  ) {
    effects.push(
      announceSeriesResultOnce({
        id: matchId,
        homeTeamId: committed.homeTeamId,
        awayTeamId: committed.awayTeamId,
        homeScore: committed.projection.homeScore,
        awayScore: committed.projection.awayScore,
        week: committed.week,
        phase: committed.phase,
      }),
    );
  }
  if (
    committed.phase !== MATCH_PHASE.REGULAR &&
    committed.projection.decided &&
    committed.projection.winnerTeamId
  ) {
    effects.push(advancePlayoffBracket(committed.seasonId));
  }
  if (committed.phase === MATCH_PHASE.REGULAR && committed.projection.decided) {
    effects.push(maybeAnnounceWeekHonors(committed.seasonId, committed.week));
  }
  const settled = await Promise.allSettled(effects);
  return {
    ok: true,
    ...committed.projection,
    ...(settled.some((effect) => effect.status === "rejected")
      ? { downstreamPending: true }
      : {}),
  };
}

export type AutoDetectResult = {
  imported: number;
  scanned: number;
  error?: string;
  /** At least one roster lookup couldn't reach OpenDota, so "found nothing"
   *  proves nothing. Callers use this to avoid counting the scan as empty. */
  unreachable?: boolean;
  /** The unattended worker stopped before starting more network work. */
  deadlineReached?: boolean;
};

/**
 * Auto-detect this match's games by scanning both rosters' recent games and
 * importing any that validate as a game between the two teams. Needs players to
 * have "Expose Public Match Data" enabled in Dota.
 */
/**
 * Games an admin explicitly REMOVED, remembered so the background importers
 * stop re-adding them.
 *
 * `removeGame` is the panel's own repair path for a mis-attributed import, and
 * without this memory it did not work at all during the window it exists for.
 * BOTH import paths decide "already recorded" from the Game rows themselves —
 * `autoDetectGamesForMatch`'s `recorded` set and `syncLeagueGames`' unique-id
 * check — so deleting the row simply made the game a fresh candidate again, and
 * the next `/api/sync` ping re-imported it. That ping comes from any page view,
 * including the admin's own tab, so the correction was typically undone inside a
 * minute — silently, because the removal had already toasted success.
 *
 * Bounded like the league skip list. The admin's MANUAL detect / league-sync
 * buttons pass `ignoreSkips`, so a deliberate re-import is still one click: this
 * only ever stops the AUTOMATIC paths from reversing a deliberate removal.
 */
const importSkipKey = (seasonId: string) => `importSkip:${seasonId}`;

export async function loadImportSkips(seasonId: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(
      (await getSetting(importSkipKey(seasonId))) ?? "[]",
    );
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    // corrupt skip memory — start fresh rather than fail the caller
    return new Set();
  }
}

/**
 * Record a removal. Callers must do this BEFORE deleting the Game row, not
 * after: the unique `dotaMatchId` is what makes the gap safe. With the row still
 * present a racing import is refused by the constraint, so writing the skip
 * first leaves no window in which the game is both importable and unremembered.
 */
export async function rememberImportSkip(
  seasonId: string,
  dotaMatchId: string,
) {
  const skips = await loadImportSkips(seasonId);
  if (skips.has(dotaMatchId)) return;
  skips.add(dotaMatchId);
  await setSetting(
    importSkipKey(seasonId),
    JSON.stringify([...skips].slice(-AUTO_SYNC.LEAGUE_SKIP_MEMORY)),
  );
}

export async function autoDetectGamesForMatch(
  matchId: string,
  opts: {
    ignoreSkips?: boolean;
    expectedCaptainId?: string;
    deadlineMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<AutoDetectResult> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      season: { select: { isActive: true, status: true } },
      homeTeam: { select: { captainId: true } },
      awayTeam: { select: { captainId: true } },
    },
  });
  if (!match) return { imported: 0, scanned: 0, error: "Unknown league match" };
  if (
    !match.season.isActive ||
    !matchResultsOpen(match.season.status, match.phase)
  ) {
    return {
      imported: 0,
      scanned: 0,
      error:
        "Results are locked for this fixture in the league's current phase",
    };
  }
  if (
    opts.expectedCaptainId &&
    match.homeTeam.captainId !== opts.expectedCaptainId &&
    match.awayTeam.captainId !== opts.expectedCaptainId
  ) {
    return {
      imported: 0,
      scanned: 0,
      error: "You no longer captain either team in this match",
    };
  }

  const { homeSet, awaySet, teamSize } = await gatherTeamAccounts(match);
  const accounts = [...homeSet, ...awaySet].slice(0, 12);
  const fetchOptions: OpenDotaFetchOptions = {
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
  };
  const bounded = opts.deadlineMs !== undefined || opts.signal !== undefined;
  const budgetStopped = () => bounded && !canStartOpenDotaFetch(fetchOptions);

  // Count how many of our players share each recent match id.
  const counts = new Map<number, number>();
  let unreachable = false;
  for (const acc of accounts) {
    if (budgetStopped()) {
      return {
        imported: 0,
        scanned: counts.size,
        unreachable,
        deadlineReached: true,
      };
    }
    const ids = await fetchRecentMatchIds(acc, 20, fetchOptions); // null = unreachable
    if (ids === null) {
      if (budgetStopped() || openDotaBudgetExpired(fetchOptions)) {
        return {
          imported: 0,
          scanned: counts.size,
          unreachable,
          deadlineReached: true,
        };
      }
      unreachable = true;
      continue;
    }
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  // Games shared by several of our players are candidates; validate each against
  // the two rosters before committing.
  const candidateIds = [...counts.entries()]
    .filter(([, c]) => c >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => id);

  // Already-recorded games must not occupy candidate slots — otherwise a
  // recorded rematch (e.g. the playoff meeting) starves the older unrecorded
  // game out of the bestOf cap below. Admin-removed games are treated the same
  // way: a deliberate removal is a decision this scan must not overturn.
  const candidateIdStrings = candidateIds.map(String);
  const [recordedLeagueGames, recordedScrimGames, recordedClaims] =
    await Promise.all([
      prisma.game.findMany({
        where: { dotaMatchId: { in: candidateIdStrings } },
        select: { dotaMatchId: true },
      }),
      prisma.scrimGame.findMany({
        where: { dotaMatchId: { in: candidateIdStrings } },
        select: { dotaMatchId: true },
      }),
      prisma.dotaMatchClaim.findMany({
        where: { dotaMatchId: { in: candidateIdStrings } },
        select: { dotaMatchId: true },
      }),
    ]);
  const recorded = new Set([
    ...recordedLeagueGames.map((g) => g.dotaMatchId),
    ...recordedScrimGames.map((g) => g.dotaMatchId),
    ...recordedClaims.map((g) => g.dotaMatchId),
    ...(opts.ignoreSkips ? [] : await loadImportSkips(match.seasonId)),
  ]);

  const minPerSide = Math.min(3, teamSize);
  const valid: SeriesCandidate[] = [];
  // Wall-clock budget: each candidate is a separate OpenDota round trip (8s
  // timeout each), so a slow API turned one scan into minutes of work and the
  // serverless function was killed before it could return. Stopping early is
  // safe — the match stays claimable and the next run picks up where this left
  // off (already-imported games are skipped by the `recorded` set above).
  const scanDeadline = Date.now() + SCAN_BUDGET_MS;
  for (const id of candidateIds) {
    if (Date.now() > scanDeadline || budgetStopped()) break;
    if (recorded.has(String(id))) continue;
    const od = await fetchOpenDotaMatch(String(id), fetchOptions);
    if (!od) {
      if (budgetStopped() || openDotaBudgetExpired(fetchOptions)) break;
      continue;
    }
    const cls = classifyGame(
      od,
      { teamId: match.homeTeamId, accountIds: homeSet },
      { teamId: match.awayTeamId, accountIds: awaySet },
      minPerSide,
    );
    if (cls.ok) {
      valid.push({
        id,
        startTime: od.start_time ?? 0,
        winnerTeamId: cls.winnerTeamId,
      });
    }
  }

  if (budgetStopped() || openDotaBudgetExpired(fetchOptions)) {
    return {
      imported: 0,
      scanned: accounts.length,
      unreachable,
      deadlineReached: true,
    };
  }

  // These teams may meet more than once a season (double round robin, playoff
  // rematch), and an unimported fixture stays a live candidate forever. Keep
  // only games inside this match's window AND closer to it than to any other
  // unplayed meeting between the same two sides — see `claimsGame`.
  const competingMeetings = match.scheduledAt
    ? await Promise.all([
        prisma.match.findMany({
          where: {
            seasonId: match.seasonId,
            id: { not: match.id },
            status: { not: MATCH_STATUS.COMPLETED },
            scheduledAt: { not: null },
            OR: [
              { homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId },
              { homeTeamId: match.awayTeamId, awayTeamId: match.homeTeamId },
            ],
          },
          select: { scheduledAt: true },
        }),
        prisma.scrim.findMany({
          where: {
            seasonId: match.seasonId,
            status: {
              in: [
                SCRIM_STATUS.SCHEDULED,
                SCRIM_STATUS.LIVE,
                SCRIM_STATUS.COMPLETED,
              ],
            },
            OR: [
              {
                hostTeamId: match.homeTeamId,
                opponentTeamId: match.awayTeamId,
              },
              {
                hostTeamId: match.awayTeamId,
                opponentTeamId: match.homeTeamId,
              },
            ],
          },
          select: { scheduledAt: true },
        }),
      ]).then(([matches, scrims]) => ({
        league: matches.map((m) => m.scheduledAt!.getTime()),
        scrims: scrims.map((s) => s.scheduledAt.getTime()),
      }))
    : { league: [], scrims: [] };

  const windowed = match.scheduledAt
    ? valid.filter((v) => {
        const t = v.startTime * 1000;
        const night = match.scheduledAt!.getTime();
        if (!isWithinLeagueResultWindow(v.startTime, night)) return false;
        const otherKickoffs = eligibleCompetingMeetingKickoffs(
          v.startTime,
          competingMeetings,
        );
        return claimsGame(t, night, otherKickoffs);
      })
    : valid;

  const chosen = pickSeriesGames(windowed, match.bestOf);

  let imported = 0;
  for (const c of chosen) {
    if (budgetStopped()) break;
    const r = await importGameForMatch(matchId, String(c.id), {
      expectedCaptainId: opts.expectedCaptainId,
      deadlineMs: opts.deadlineMs,
      signal: opts.signal,
    });
    if (r.ok) imported++;
    else if (r.deadlineReached) break;
  }
  return {
    imported,
    scanned: accounts.length,
    unreachable,
    ...(budgetStopped() || openDotaBudgetExpired(fetchOptions)
      ? { deadlineReached: true }
      : {}),
  };
}

export type EnrichResult = {
  enriched: number;
  failed: number;
  remaining: number;
};

/**
 * Backfill report-card fields (benchmarks, XPM, damage numbers…) onto games
 * imported before those fields were stored. Re-fetches each game from OpenDota
 * by its unique dotaMatchId and merges the new per-player fields into the
 * stored JSON — attribution (userId/teamId) and recorded results are never
 * touched. Every processed line gains a `benchmarks` key (null when OpenDota
 * has none), which is also the "already enriched" marker, so runs are
 * idempotent. Bounded per run so one click can't burn the API budget; run
 * again to continue where it left off.
 */
export async function enrichStoredGames(limit = 12): Promise<EnrichResult> {
  // The `"benchmarks":` key only ever appears as a line's own field — a
  // player whose persona name is literally `benchmarks` serializes with a
  // comma after it, so the colon keeps the marker probe honest.
  // Count + bounded fetch, never the whole table: the rows exist only to
  // process `limit` of them, and the count alone feeds `remaining` — on a
  // legacy DB the old unbounded findMany read every un-enriched game's
  // box-score JSON per button press to process 12.
  const unenriched = { NOT: { players: { contains: '"benchmarks":' } } };
  const [total, batch] = await Promise.all([
    prisma.game.count({ where: unenriched }),
    prisma.game.findMany({
      where: unenriched,
      orderBy: { fetchedAt: "asc" },
      take: limit,
      select: { id: true, dotaMatchId: true, players: true },
    }),
  ]);

  let enriched = 0;
  let failed = 0;
  // A failed game keeps its stored JSON but moves to the back of the
  // fetchedAt-ordered queue — otherwise a dozen permanently-unfetchable games
  // at the head would starve every later run of this bounded batch.
  const requeue = (id: string) =>
    prisma.game.update({ where: { id }, data: { fetchedAt: new Date() } });
  for (const game of batch) {
    let lines: PlayerStat[];
    try {
      const parsed = JSON.parse(game.players);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      lines = parsed as PlayerStat[];
    } catch {
      failed++; // malformed JSON — leave it alone rather than guess
      await requeue(game.id);
      continue;
    }

    const od = await fetchOpenDotaMatch(game.dotaMatchId);
    if (!od) {
      failed++;
      await requeue(game.id);
      continue;
    }

    // Match OpenDota players to stored lines: by account id when we have one,
    // else by (side, hero) — unique within a game since heroes can't repeat.
    const bySlot = (p: OpenDotaPlayer) => p.isRadiant ?? p.player_slot < 128;
    const merged = lines.map((line) => {
      const odPlayer =
        line.accountId != null
          ? od.players.find((p) => p.account_id === line.accountId)
          : od.players.find(
              (p) => bySlot(p) === line.isRadiant && p.hero_id === line.heroId,
            );
      return {
        ...line,
        xpm: line.xpm ?? odPlayer?.xp_per_min ?? null,
        denies: line.denies ?? odPlayer?.denies ?? null,
        level: line.level ?? odPlayer?.level ?? null,
        heroDamage: line.heroDamage ?? odPlayer?.hero_damage ?? null,
        towerDamage: line.towerDamage ?? odPlayer?.tower_damage ?? null,
        heroHealing: line.heroHealing ?? odPlayer?.hero_healing ?? null,
        benchmarks: sanitizeBenchmarks(odPlayer?.benchmarks),
      };
    });

    await prisma.game.update({
      where: { id: game.id },
      data: { players: JSON.stringify(merged) },
    });
    enriched++;
  }

  return {
    enriched,
    failed,
    remaining: total - batch.length + failed,
  };
}

export type LeagueSyncResult = {
  imported: number;
  scanned: number;
  error?: string;
  /** OpenDota didn't answer — the caller may retry sooner than usual. */
  unreachable?: boolean;
  /** The unattended worker stopped before starting more network work. */
  deadlineReached?: boolean;
};

// Stay below SQLite's conservative bind-parameter ceiling while also keeping
// a typo'd league id from turning one lookup into an unbounded SQL statement.
// PostgreSQL supports the same Prisma `in` shape, so both providers share the
// batching path.
const LEAGUE_GAME_LOOKUP_BATCH_SIZE = 500;

/**
 * Pull every game from the season's registered Valve league id (via OpenDota)
 * and import the ones that match a scheduled league match. This is the cleanest
 * path once the league is registered in the Dota client: league games are
 * tagged with the league id, so no per-player public match data is required.
 *
 * `auto: true` (the result-sync path, fired unattended every few minutes)
 * bounds the run: at most LEAGUE_MAX_FETCHES_PER_RUN unknown ids are fetched
 * (a typo'd league id can list thousands), and ids that fetched but didn't
 * import are remembered in a per-season skip list so they're never refetched —
 * without it every never-importable league game (scrims in the league lobby,
 * games of manually-recorded matches) costs a fetch per run forever. The
 * admin's manual button runs unbounded and ignores the skip list, because a
 * skipped game can become importable after a roster/standin change.
 */
export async function syncLeagueGames(
  seasonId: string,
  opts: { auto?: boolean; deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<LeagueSyncResult> {
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) return { imported: 0, scanned: 0, error: "No season" };
  if (!season.dotaLeagueId) {
    return {
      imported: 0,
      scanned: 0,
      error: "Set a Dota league id for this season first",
    };
  }

  // Deadlines are an unattended-worker concern. Admin/manual sync preserves
  // its existing unbounded behavior even if a future caller passes options by
  // mistake without opting into `auto`.
  const fetchOptions: OpenDotaFetchOptions = opts.auto
    ? { deadlineMs: opts.deadlineMs, signal: opts.signal }
    : {};
  const budgetStopped = () =>
    !!opts.auto && !canStartOpenDotaFetch(fetchOptions);
  if (budgetStopped()) {
    return { imported: 0, scanned: 0, deadlineReached: true };
  }

  const leagueMatchIds = await fetchLeagueMatchIds(
    season.dotaLeagueId,
    fetchOptions,
  );
  if (leagueMatchIds === null) {
    if (budgetStopped() || openDotaBudgetExpired(fetchOptions)) {
      return { imported: 0, scanned: 0, deadlineReached: true };
    }
    // Per-game fetch failures below stay `continue` (transient per-id); a
    // null LIST means the feed itself was unreachable — say so instead of
    // reporting a success-shaped "imported 0 of 0".
    return {
      imported: 0,
      scanned: 0,
      unreachable: true,
      error: "OpenDota is unreachable right now — try again in a minute",
    };
  }
  const [scheduled, scheduledScrims] = await Promise.all([
    prisma.match.findMany({
      where: { seasonId },
      include: { games: { select: { id: true } } },
    }),
    prisma.scrim.findMany({
      where: {
        seasonId,
        status: {
          in: [
            SCRIM_STATUS.SCHEDULED,
            SCRIM_STATUS.LIVE,
            SCRIM_STATUS.COMPLETED,
          ],
        },
        opponentTeamId: { not: null },
      },
      include: {
        participants: {
          select: { teamId: true, dotaAccountId: true },
        },
      },
    }),
  ]);

  const skipKey = leagueSyncSkipKey(seasonId);
  let skipList: string[] = [];
  if (opts.auto) {
    try {
      const parsed = JSON.parse((await getSetting(skipKey)) ?? "[]");
      if (Array.isArray(parsed)) skipList = parsed.map(String);
    } catch {
      // corrupt skip memory — start fresh rather than fail the sync
    }
  }
  const skip = new Set(skipList);
  // Admin removals are honoured by the automatic feed too, but kept OUT of
  // `skipList` so the write-back below can't fold them into the league's own
  // rolling memory (they have separate lifetimes and separate override buttons).
  if (opts.auto) {
    for (const id of await loadImportSkips(seasonId)) skip.add(id);
  }
  const newlySkipped: string[] = [];

  // Building account sets is O(matches × roster queries) — do it only once a
  // fetched game actually needs classifying, so a steady-state auto run
  // (everything known or skipped) touches no roster tables at all.
  const accountsByMatch = new Map<
    string,
    { home: Set<number>; away: Set<number>; teamSize: number }
  >();
  let accountsReady = false;
  const ensureAccounts = async () => {
    if (accountsReady) return;
    for (const m of scheduled) {
      const { homeSet, awaySet, teamSize } = await gatherTeamAccounts(m);
      accountsByMatch.set(m.id, { home: homeSet, away: awaySet, teamSize });
    }
    accountsReady = true;
  };

  const maxFetches = opts.auto
    ? AUTO_SYNC.LEAGUE_MAX_FETCHES_PER_RUN
    : Number.POSITIVE_INFINITY;
  let fetches = 0;
  let imported = 0;
  let deadlineReached = false;
  // Phase 1 — fetch, classify, and BUFFER per fixture instead of importing per
  // feed id. The feed lists newest-first, so a "one for fun" game after a
  // decided night used to import BEFORE the real games (the series wasn't
  // COMPLETED yet, so nothing refused it) and a 2-0 went into the record as
  // 2-1 — wrong gameDiff tiebreak, bogus box score, wrong Discord post. Only
  // the roster-scan path had `pickSeriesGames`' session-split + clinch-stop;
  // buffering lets this path run the same filter per match below.
  const candidatesByMatch = new Map<
    string,
    {
      id: number;
      idStr: string;
      startTime: number;
      winnerTeamId: string | null;
    }[]
  >();
  feed: for (
    let offset = 0;
    offset < leagueMatchIds.length;
    offset += LEAGUE_GAME_LOOKUP_BATCH_SIZE
  ) {
    const batch = leagueMatchIds.slice(
      offset,
      offset + LEAGUE_GAME_LOOKUP_BATCH_SIZE,
    );
    // `dotaMatchId` is globally unique, not season-scoped. Query the same
    // global key the old per-id findUnique used, but collapse up to 500 reads
    // into one. De-duplicating SQL parameters does not de-duplicate feed
    // processing, so ordering, retry, and skip-list behaviour stay unchanged.
    const idsToCheck = [
      ...new Set(batch.map(String).filter((id) => !skip.has(id))),
    ];
    const recorded = new Set<string>();
    if (idsToCheck.length > 0) {
      const [leagueGames, scrimGames, claims] = await Promise.all([
        prisma.game.findMany({
          where: { dotaMatchId: { in: idsToCheck } },
          select: { dotaMatchId: true },
        }),
        prisma.scrimGame.findMany({
          where: { dotaMatchId: { in: idsToCheck } },
          select: { dotaMatchId: true },
        }),
        prisma.dotaMatchClaim.findMany({
          where: { dotaMatchId: { in: idsToCheck } },
          select: { dotaMatchId: true },
        }),
      ]);
      for (const row of [...leagueGames, ...scrimGames, ...claims]) {
        recorded.add(row.dotaMatchId);
      }
    }

    for (const dotaId of batch) {
      const idStr = String(dotaId);
      if (skip.has(idStr)) continue;
      if (recorded.has(idStr)) continue;
      if (fetches >= maxFetches) break feed;
      if (budgetStopped()) {
        deadlineReached = true;
        break feed;
      }
      fetches++;
      const od = await fetchOpenDotaMatch(idStr, fetchOptions);
      if (!od) {
        if (budgetStopped() || openDotaBudgetExpired(fetchOptions)) {
          deadlineReached = true;
          break feed;
        }
        continue; // transient fetch failure — retry later, never skip-listed
      }
      await ensureAccounts();

      // classifyGame is roster-based and time-blind, and a single round robin
      // means every playoff pairing is a regular-season rematch — so collect
      // EVERY match these rosters fit, then attribute by kickoff proximity.
      // COMPLETED matches never take a game: a decided series (or an admin's
      // manual/forfeit ruling) must not be silently rewritten by a late import —
      // amending one is an explicit per-match admin action.
      const fits: {
        m: (typeof scheduled)[number];
        winnerTeamId: string | null;
      }[] = [];
      for (const m of scheduled) {
        const acc = accountsByMatch.get(m.id);
        if (!acc) continue;
        if (m.games.length >= m.bestOf) continue;
        if (m.status === MATCH_STATUS.COMPLETED) continue;
        const cls = classifyGame(
          od,
          { teamId: m.homeTeamId, accountIds: acc.home },
          { teamId: m.awayTeamId, accountIds: acc.away },
          Math.min(3, acc.teamSize),
        );
        if (cls.ok) fits.push({ m, winnerTeamId: cls.winnerTeamId });
      }

      // A scrim may deliberately use the season's Valve league ticket. That
      // puts it in this official feed, so classify it against booked scrim
      // lineups too and let the closest scheduled event own the candidate.
      // Ties fail closed in favour of neither automatic official import.
      const scrimFits = scheduledScrims.flatMap((scrim) => {
        if (!scrim.opponentTeamId) return [];
        if (
          !isWithinScrimResultWindow(od.start_time, scrim.scheduledAt.getTime())
        ) {
          return [];
        }
        const host = new Set(
          scrim.participants
            .filter((p) => p.teamId === scrim.hostTeamId)
            .map((p) => p.dotaAccountId),
        );
        const away = new Set(
          scrim.participants
            .filter((p) => p.teamId === scrim.opponentTeamId)
            .map((p) => p.dotaAccountId),
        );
        const cls = classifyGame(
          od,
          { teamId: scrim.hostTeamId, accountIds: host },
          { teamId: scrim.opponentTeamId, accountIds: away },
          3,
        );
        return cls.ok ? [{ scrim }] : [];
      });
      if (fits.length === 0) {
        // A real booked scrim belongs to the scrim importer, but this official
        // league-ticket scanner has already classified it conclusively. Keep
        // that id in this scanner's private skip memory so it does not spend
        // the provider budget again. The scrim scanner/manual import do not
        // read leagueSyncSkip and remain free to claim the game.
        if (scrimFits.length > 0) {
          newlySkipped.push(idStr);
          skip.add(idStr);
          continue;
        }
        newlySkipped.push(idStr);
        continue;
      }

      const gameMs = (od.start_time ?? 0) * 1000;
      const best = fits.reduce((a, b) => {
        const da = a.m.scheduledAt
          ? Math.abs(gameMs - a.m.scheduledAt.getTime())
          : Number.MAX_SAFE_INTEGER;
        const db = b.m.scheduledAt
          ? Math.abs(gameMs - b.m.scheduledAt.getTime())
          : Number.MAX_SAFE_INTEGER;
        return db < da ? b : a;
      });
      const officialDistance = best.m.scheduledAt
        ? Math.abs(gameMs - best.m.scheduledAt.getTime())
        : Number.MAX_SAFE_INTEGER;
      const scrimOwnsCandidate = scrimFits.some(
        ({ scrim }) =>
          Math.abs(gameMs - scrim.scheduledAt.getTime()) <= officialDistance,
      );
      if (scrimOwnsCandidate) {
        newlySkipped.push(idStr);
        skip.add(idStr);
        continue;
      }
      const list = candidatesByMatch.get(best.m.id) ?? [];
      list.push({
        id: Number(idStr),
        idStr,
        startTime: od.start_time ?? 0,
        winnerTeamId: best.winnerTeamId,
      });
      candidatesByMatch.set(best.m.id, list);
    }
  }

  // Phase 2 — per match, keep only the real series (biggest session, clinch
  // stop) and import it in PLAY order. Play order is itself a backstop: each
  // import runs recomputeSeries, so once the series decides, the funnel's own
  // COMPLETED/bestOf re-checks refuse anything a partial buffer let through
  // (e.g. the match already held a roster-scanned game this buffer can't see
  // the clinch math of).
  for (const [matchId, candidates] of candidatesByMatch) {
    const match = scheduled.find((m) => m.id === matchId);
    if (!match) continue;
    const chosen = pickSeriesGames(candidates, match.bestOf);
    const chosenIds = new Set(chosen.map((c) => c.idStr));
    for (const c of [...chosen].sort((a, b) => a.startTime - b.startTime)) {
      if (budgetStopped()) {
        deadlineReached = true;
        break;
      }
      const r = await importGameForMatch(matchId, c.idStr, fetchOptions);
      if (r.ok) {
        imported++;
      } else if (r.deadlineReached) {
        deadlineReached = true;
        break;
      } else {
        // A refused import (recorded for another match, full series, manual
        // result) won't succeed next run either — stop refetching it.
        newlySkipped.push(c.idStr);
      }
    }
    if (deadlineReached) break;
    for (const c of candidates) {
      // The bonus/warmup games pickSeriesGames dropped: fetched, classified,
      // and deliberately not imported — remember them so the automatic feed
      // never refetches a game it has already judged. The manual admin button
      // ignores the skip list, so a wrongly-dropped game stays importable.
      if (!chosenIds.has(c.idStr)) newlySkipped.push(c.idStr);
    }
  }
  if (opts.auto && newlySkipped.length > 0) {
    await setSetting(
      skipKey,
      JSON.stringify(
        [...skipList, ...newlySkipped].slice(-AUTO_SYNC.LEAGUE_SKIP_MEMORY),
      ),
    );
  }
  return {
    imported,
    scanned: leagueMatchIds.length,
    ...(deadlineReached ? { deadlineReached: true } : {}),
  };
}
