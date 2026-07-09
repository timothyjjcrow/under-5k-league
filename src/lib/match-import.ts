import { prisma } from "./prisma";
import {
  steamIdToAccountId,
  fetchOpenDotaMatch,
  fetchRecentMatchIds,
  fetchLeagueMatchIds,
  type OpenDotaMatch,
} from "./dota";
import { advancePlayoffBracket } from "./playoff-service";
import { MATCH_PHASE, MATCH_STATUS } from "./constants";

export type TeamAccounts = { teamId: string; accountIds: Set<number> };

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
  const [season, members, standins] = await Promise.all([
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
  ]);

  const accountMap = new Map<number, { userId: string; name: string; teamId: string }>();
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

  return { accountMap, homeSet, awaySet, teamSize: season?.teamSize ?? 5 };
}

function buildPlayers(
  match: OpenDotaMatch,
  accountMap: Map<number, { userId: string; name: string; teamId: string }>,
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

  // Advance the playoff bracket only once the series has a decided winner.
  if (match.phase !== MATCH_PHASE.REGULAR && decided && winnerTeamId) {
    await advancePlayoffBracket(match.seasonId);
  }
}

export type ImportResult = { ok: true } | { ok: false; error: string };

/** Fetch a specific Dota match and record it against a scheduled league match. */
export async function importGameForMatch(
  matchId: string,
  dotaMatchId: string,
): Promise<ImportResult> {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) return { ok: false, error: "Unknown league match" };

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

  await recomputeSeries(matchId);
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
    const ids = await fetchRecentMatchIds(acc, 20);
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  // Games shared by several of our players are candidates; validate each against
  // the two rosters before committing.
  const candidateIds = [...counts.entries()]
    .filter(([, c]) => c >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => id);

  const minPerSide = Math.min(3, teamSize);
  const valid: { id: number; startTime: number }[] = [];
  for (const id of candidateIds) {
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

  // Keep only the most recent `bestOf` games that check out, then import them in
  // play order. A series can't have more games than its length, so this caps the
  // import — and crucially means an *older* game with the same players (a scrim,
  // a prior meeting) is always superseded by the game this match was just played,
  // never mistaken for it.
  const chosen = valid
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
 */
export async function syncLeagueGames(
  seasonId: string,
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
  const scheduled = await prisma.match.findMany({ where: { seasonId } });

  // Precompute each scheduled match's team account sets once.
  const accountsByMatch = new Map<
    string,
    { home: Set<number>; away: Set<number>; teamSize: number }
  >();
  for (const m of scheduled) {
    const { homeSet, awaySet, teamSize } = await gatherTeamAccounts(m);
    accountsByMatch.set(m.id, { home: homeSet, away: awaySet, teamSize });
  }

  let imported = 0;
  for (const dotaId of leagueMatchIds) {
    const idStr = String(dotaId);
    if (await prisma.game.findUnique({ where: { dotaMatchId: idStr } })) continue;
    const od = await fetchOpenDotaMatch(idStr);
    if (!od) continue;

    for (const m of scheduled) {
      const acc = accountsByMatch.get(m.id);
      if (!acc) continue;
      const cls = classifyGame(
        od,
        { teamId: m.homeTeamId, accountIds: acc.home },
        { teamId: m.awayTeamId, accountIds: acc.away },
        Math.min(3, acc.teamSize),
      );
      if (cls.ok) {
        const r = await importGameForMatch(m.id, idStr);
        if (r.ok) imported++;
        break;
      }
    }
  }
  return { imported, scanned: leagueMatchIds.length };
}
