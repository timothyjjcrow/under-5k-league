import { prisma } from "./prisma";
import {
  steamIdToAccountId,
  fetchOpenDotaMatch,
  fetchRecentMatchIds,
  fetchLeagueMatchIds,
  type OpenDotaMatch,
  type OpenDotaPlayer,
} from "./dota";
import { advancePlayoffBracket } from "./playoff-service";
import { maybeAnnounceWeekHonors } from "./honors-service";
import { getWebhookUrl, matchResultMessage, sendDiscordMessage } from "./discord";
import { getSetting, setSetting, stampResultChange } from "./settings";
import { AUTO_SYNC, MATCH_PHASE, MATCH_STATUS } from "./constants";

const DAY_MS = 24 * 60 * 60 * 1000;

export type TeamAccounts = { teamId: string; accountIds: Set<number> };

/** Marker value recording a send that failed — claimable for a retry. */
export const ANNOUNCE_FAILED_PREFIX = "failed:";

/**
 * Announce a decided series to Discord exactly once per match, whichever path
 * completed it (captain import, auto sync, league sync, admin import — and
 * admin recordResult, which claims the same marker before its own send).
 * Atomic Setting-row CREATE, the reminder-service pattern: concurrent
 * completions race to a P2002 instead of double-posting.
 *
 * A FAILED send doesn't release the marker (unlike honors/reminders, nothing
 * naturally re-triggers this match — the run whose send failed is the run
 * that completed it): it stamps the marker `failed:<iso>` instead, and the
 * result-sync retry sweep atomically re-claims exactly those. Only rows this
 * code marked failed are ever retried, so a deploy can't re-announce history.
 */
export async function announceSeriesResultOnce(match: {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  week: number;
  phase: string;
}): Promise<boolean> {
  // Without a webhook, don't burn the once-only marker — if the admin wires
  // Discord up later, results that complete after that still announce.
  if (!(await getWebhookUrl())) return false;
  const marker = `resultAnnounced:${match.id}`;
  try {
    await prisma.setting.create({
      data: { key: marker, value: new Date().toISOString() },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    // Marker exists: only a failed prior send may be retried — the
    // conditional update is the atomic claim (one retrier wins).
    const reclaimed = await prisma.setting.updateMany({
      where: { key: marker, value: { startsWith: ANNOUNCE_FAILED_PREFIX } },
      data: { value: new Date().toISOString() },
    });
    if (reclaimed.count === 0) return false; // already sent (or being sent)
  }
  const [home, away] = await Promise.all([
    prisma.team.findUnique({ where: { id: match.homeTeamId } }),
    prisma.team.findUnique({ where: { id: match.awayTeamId } }),
  ]);
  if (!home || !away) return false;
  const sent = await sendDiscordMessage(
    matchResultMessage({
      homeName: home.name,
      awayName: away.name,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      week: match.week,
      isPlayoff: match.phase !== MATCH_PHASE.REGULAR,
    }),
  );
  if (!sent) {
    // A Discord blip must not permanently eat the announcement — flag the
    // marker for the sync sweep to retry.
    await prisma.setting.updateMany({
      where: { key: marker },
      data: { value: `${ANNOUNCE_FAILED_PREFIX}${new Date().toISOString()}` },
    });
    return false;
  }
  return true;
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

  let radA = 0,
    direA = 0,
    radB = 0,
    direB = 0;
  for (const p of match.players) {
    if (p.account_id == null) continue;
    const isRadiant = p.isRadiant ?? p.player_slot < 128;
    if (teamA.accountIds.has(p.account_id)) isRadiant ? radA++ : direA++;
    if (teamB.accountIds.has(p.account_id)) isRadiant ? radB++ : direB++;
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

type MatchRow = {
  id: string;
  seasonId: string;
  homeTeamId: string;
  awayTeamId: string;
  phase: string;
};

/** Build the account-id sets (roster + standins) for a scheduled match's teams. */
export async function gatherTeamAccounts(match: MatchRow) {
  const [season, members, standins, registrants] = await Promise.all([
    prisma.season.findUnique({ where: { id: match.seasonId } }),
    prisma.teamMember.findMany({
      where: {
        seasonId: match.seasonId,
        teamId: { in: [match.homeTeamId, match.awayTeamId] },
      },
      include: { user: true },
    }),
    prisma.standinAssignment.findMany({
      where: { matchId: match.id },
      include: { standin: true },
    }),
    // Attribution fallback: a player released between playing and importing
    // has no TeamMember row anymore, but their line should still carry their
    // userId (career, fantasy, honors). They stay OUT of the team account
    // sets, so classifyGame remains roster-strict.
    prisma.registration.findMany({
      where: { seasonId: match.seasonId },
      include: { user: true },
    }),
  ]);

  const accountMap = new Map<
    number,
    { userId: string; name: string; teamId: string | null }
  >();
  const homeSet = new Set<number>();
  const awaySet = new Set<number>();

  const add = (
    user: { id: string; name: string; steamId: string; dotaAccountId: number | null },
    teamId: string,
  ) => {
    const acc = user.dotaAccountId ?? steamIdToAccountId(user.steamId);
    if (acc == null) return;
    accountMap.set(acc, { userId: user.id, name: user.name, teamId });
    (teamId === match.homeTeamId ? homeSet : awaySet).add(acc);
  };

  for (const m of members) add(m.user, m.teamId);
  for (const s of standins) add(s.standin, s.teamId);

  // Registered-but-unrostered users map for attribution only (teamId null) —
  // never added to homeSet/awaySet, so classification is unaffected.
  for (const r of registrants) {
    const acc = r.user.dotaAccountId ?? steamIdToAccountId(r.user.steamId);
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
    const mapped = p.account_id != null ? accountMap.get(p.account_id) : undefined;
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

/** Recompute a league match's series score from its imported games. */
export async function recomputeSeries(matchId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { games: true },
  });
  if (!match) return;

  const homeWins = match.games.filter((g) => g.winnerTeamId === match.homeTeamId).length;
  const awayWins = match.games.filter((g) => g.winnerTeamId === match.awayTeamId).length;
  // A series is decided when a team clinches the majority (Bo3 → 2, Bo5 → 3) or
  // when every game has been played (a Bo2 can end 1-1 = a draw).
  const clinchAt = Math.floor(match.bestOf / 2) + 1;
  const clinched = homeWins >= clinchAt || awayWins >= clinchAt;
  const allPlayed = homeWins + awayWins >= match.bestOf;
  const decided = clinched || allPlayed;
  const winnerTeamId = !decided
    ? null
    : homeWins > awayWins
      ? match.homeTeamId
      : awayWins > homeWins
        ? match.awayTeamId
        : null; // drawn series (e.g. a 1-1 best-of-2)

  await prisma.match.update({
    where: { id: matchId },
    data: {
      homeScore: homeWins,
      awayScore: awayWins,
      winnerTeamId,
      status: decided
        ? MATCH_STATUS.COMPLETED
        : match.games.length > 0
          ? MATCH_STATUS.LIVE
          : MATCH_STATUS.SCHEDULED,
    },
  });

  // A freshly decided series announces itself (idempotent claim) — imported
  // results used to reach Discord only when an admin typed the score in.
  if (decided && match.status !== MATCH_STATUS.COMPLETED) {
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

export type ImportResult = { ok: true } | { ok: false; error: string };

/** Fetch a specific Dota match and record it against a scheduled league match. */
export async function importGameForMatch(
  matchId: string,
  dotaMatchId: string,
): Promise<ImportResult> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { games: { select: { id: true } } },
  });
  if (!match) return { ok: false, error: "Unknown league match" };

  // A COMPLETED match with no imported games was recorded manually (score
  // entry / forfeit) — recomputeSeries would silently overwrite that result.
  if (match.status === "COMPLETED" && match.games.length === 0) {
    return {
      ok: false,
      error:
        "This match's result was recorded manually — importing a game would overwrite it",
    };
  }
  // A series only holds bestOf games; a Bo1 with two games is a mis-attribution.
  if (match.games.length >= match.bestOf) {
    return {
      ok: false,
      error: `This best-of-${match.bestOf} already has all ${match.bestOf} of its games`,
    };
  }

  const existing = await prisma.game.findUnique({ where: { dotaMatchId } });
  if (existing) {
    return existing.matchId === matchId
      ? { ok: false, error: "That game is already recorded here" }
      : { ok: false, error: "That game is already recorded for another match" };
  }

  const od = await fetchOpenDotaMatch(dotaMatchId);
  if (!od) {
    return {
      ok: false,
      error: "Could not fetch that match from OpenDota (is the id correct and the match public?)",
    };
  }

  const { accountMap, homeSet, awaySet, teamSize } = await gatherTeamAccounts(match);
  const cls = classifyGame(
    od,
    { teamId: match.homeTeamId, accountIds: homeSet },
    { teamId: match.awayTeamId, accountIds: awaySet },
    Math.min(3, teamSize),
  );
  if (!cls.ok) return { ok: false, error: cls.reason ?? "Game does not match these teams" };

  try {
    await prisma.game.create({
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
  } catch (e) {
    // The dedupe check above races with concurrent imports (an OpenDota fetch
    // sits between check and create) — the unique index is the real arbiter.
    if ((e as { code?: string }).code === "P2002") {
      return { ok: false, error: "That game was just recorded by someone else" };
    }
    throw e;
  }

  await recomputeSeries(matchId);
  // Bump the change cursor so every parked client (not just whoever triggered
  // this import) learns the league moved on its next /api/sync poll.
  await stampResultChange();
  return { ok: true };
}

export type AutoDetectResult = {
  imported: number;
  scanned: number;
  error?: string;
};

/**
 * Auto-detect this match's games by scanning both rosters' recent games and
 * importing any that validate as a game between the two teams. Needs players to
 * have "Expose Public Match Data" enabled in Dota.
 */
export async function autoDetectGamesForMatch(
  matchId: string,
): Promise<AutoDetectResult> {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) return { imported: 0, scanned: 0, error: "Unknown league match" };

  const { homeSet, awaySet, teamSize } = await gatherTeamAccounts(match);
  const accounts = [...homeSet, ...awaySet].slice(0, 12);

  // Count how many of our players share each recent match id.
  const counts = new Map<number, number>();
  for (const acc of accounts) {
    const ids = (await fetchRecentMatchIds(acc, 20)) ?? []; // null = unreachable
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
  // game out of the bestOf cap below.
  const recorded = new Set(
    (
      await prisma.game.findMany({
        where: { dotaMatchId: { in: candidateIds.map(String) } },
        select: { dotaMatchId: true },
      })
    ).map((g) => g.dotaMatchId),
  );

  const minPerSide = Math.min(3, teamSize);
  const valid: { id: number; startTime: number }[] = [];
  for (const id of candidateIds) {
    if (recorded.has(String(id))) continue;
    const od = await fetchOpenDotaMatch(String(id));
    if (!od) continue;
    const cls = classifyGame(
      od,
      { teamId: match.homeTeamId, accountIds: homeSet },
      { teamId: match.awayTeamId, accountIds: awaySet },
      minPerSide,
    );
    if (cls.ok) valid.push({ id, startTime: od.start_time ?? 0 });
  }

  // These teams may meet more than once a season (playoff rematches). When the
  // match has a scheduled night, only games played around it belong to it —
  // otherwise detecting a stale match would happily grab the *other* meeting.
  const windowed = match.scheduledAt
    ? valid.filter((v) => {
        const t = v.startTime * 1000;
        const night = match.scheduledAt!.getTime();
        return t >= night - DAY_MS && t <= night + 6 * DAY_MS;
      })
    : valid;

  // Keep only the most recent `bestOf` games that check out, then import them in
  // play order. A series can't have more games than its length, so this caps the
  // import — and crucially means an *older* game with the same players (a scrim,
  // a prior meeting) is always superseded by the game this match was just played,
  // never mistaken for it.
  const chosen = windowed
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, Math.max(1, match.bestOf))
    .sort((a, b) => a.startTime - b.startTime);

  let imported = 0;
  for (const c of chosen) {
    const r = await importGameForMatch(matchId, String(c.id));
    if (r.ok) imported++;
  }
  return { imported, scanned: accounts.length };
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
  const candidates = await prisma.game.findMany({
    where: { NOT: { players: { contains: '"benchmarks":' } } },
    orderBy: { fetchedAt: "asc" },
    select: { id: true, dotaMatchId: true, players: true },
  });

  let enriched = 0;
  let failed = 0;
  const batch = candidates.slice(0, limit);
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
    remaining: candidates.length - batch.length + failed,
  };
}

export type LeagueSyncResult = {
  imported: number;
  scanned: number;
  error?: string;
};

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
  opts: { auto?: boolean } = {},
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

  const leagueMatchIds = await fetchLeagueMatchIds(season.dotaLeagueId);
  const scheduled = await prisma.match.findMany({
    where: { seasonId },
    include: { games: { select: { id: true } } },
  });

  const skipKey = `leagueSyncSkip:${seasonId}`;
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
  for (const dotaId of leagueMatchIds) {
    const idStr = String(dotaId);
    if (skip.has(idStr)) continue;
    if (await prisma.game.findUnique({ where: { dotaMatchId: idStr } })) continue;
    if (fetches >= maxFetches) break;
    fetches++;
    const od = await fetchOpenDotaMatch(idStr);
    if (!od) continue; // transient fetch failure — retry later, never skip-listed
    await ensureAccounts();

    // classifyGame is roster-based and time-blind, and a single round robin
    // means every playoff pairing is a regular-season rematch — so collect
    // EVERY match these rosters fit, then attribute by kickoff proximity.
    // COMPLETED matches never take a game: a decided series (or an admin's
    // manual/forfeit ruling) must not be silently rewritten by a late import —
    // amending one is an explicit per-match admin action.
    const fits = scheduled.filter((m) => {
      const acc = accountsByMatch.get(m.id);
      if (!acc) return false;
      if (m.games.length >= m.bestOf) return false;
      if (m.status === MATCH_STATUS.COMPLETED) return false;
      return classifyGame(
        od,
        { teamId: m.homeTeamId, accountIds: acc.home },
        { teamId: m.awayTeamId, accountIds: acc.away },
        Math.min(3, acc.teamSize),
      ).ok;
    });
    if (fits.length === 0) {
      newlySkipped.push(idStr);
      continue;
    }

    const gameMs = (od.start_time ?? 0) * 1000;
    const best = fits.reduce((a, b) => {
      const da = a.scheduledAt
        ? Math.abs(gameMs - a.scheduledAt.getTime())
        : Number.MAX_SAFE_INTEGER;
      const db = b.scheduledAt
        ? Math.abs(gameMs - b.scheduledAt.getTime())
        : Number.MAX_SAFE_INTEGER;
      return db < da ? b : a;
    });

    const r = await importGameForMatch(best.id, idStr);
    if (r.ok) {
      imported++;
      // Keep the in-memory game counts honest for later league games.
      best.games.push({ id: idStr });
    } else {
      // A refused import (recorded for another match, full series, manual
      // result) won't succeed next run either — stop refetching it.
      newlySkipped.push(idStr);
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
  return { imported, scanned: leagueMatchIds.length };
}
