// Season awards / superlatives computed from box-score data. Pure + testable —
// feeds the season recap page. All resolution of names/heroes/matches happens in
// the UI; this module only decides *who/what* wins each award.

export type AwardGameLine = {
  userId: string;
  heroId: number;
  isRadiant: boolean;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number | null;
  gpm: number | null;
};

export type AwardGame = {
  matchId: string;
  radiantWin: boolean;
  radiantScore: number;
  direScore: number;
  lines: AwardGameLine[];
};

export type Award = {
  key: string;
  title: string;
  emoji: string;
  blurb: string; // what the award measures
  value: string; // headline stat for the winner
  detail?: string; // optional secondary stat
  userId?: string; // player award winner
  heroId?: number; // hero award subject
  matchId?: string; // match award subject
};

type Agg = {
  userId: string;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  gpmSum: number;
  gpmGames: number;
};

const kdaOf = (a: Agg) => (a.kills + a.assists) / Math.max(1, a.deaths);
const avgGpmOf = (a: Agg) => (a.gpmGames > 0 ? a.gpmSum / a.gpmGames : 0);

/**
 * Compute the season's award slate from every recorded game. Returns only
 * awards that have a real winner (skips ones with no qualifying data), in a
 * stable display order.
 */
export function computeSeasonAwards(games: AwardGame[]): Award[] {
  if (games.length === 0) return [];

  const byUser = new Map<string, Agg>();
  const heroCount = new Map<number, number>();
  let stomp: { matchId: string; diff: number; hi: number; lo: number } | null =
    null;

  for (const g of games) {
    const diff = Math.abs(g.radiantScore - g.direScore);
    if (!stomp || diff > stomp.diff) {
      stomp = {
        matchId: g.matchId,
        diff,
        hi: Math.max(g.radiantScore, g.direScore),
        lo: Math.min(g.radiantScore, g.direScore),
      };
    }
    for (const line of g.lines) {
      heroCount.set(line.heroId, (heroCount.get(line.heroId) ?? 0) + 1);
      const a =
        byUser.get(line.userId) ??
        ({
          userId: line.userId,
          games: 0,
          wins: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
          gpmSum: 0,
          gpmGames: 0,
        } satisfies Agg);
      a.games += 1;
      if (line.isRadiant === g.radiantWin) a.wins += 1;
      a.kills += line.kills;
      a.deaths += line.deaths;
      a.assists += line.assists;
      if (line.gpm != null) {
        a.gpmSum += line.gpm;
        a.gpmGames += 1;
      }
      byUser.set(line.userId, a);
    }
  }

  const aggs = [...byUser.values()];
  const maxGames = Math.max(1, ...aggs.map((a) => a.games));
  const minGames = Math.min(3, maxGames);
  const awards: Award[] = [];

  // Pick the top player by `score` (ties → more games, then userId for stability).
  const pick = (
    cands: Agg[],
    score: (a: Agg) => number,
    make: (a: Agg) => Omit<Award, "userId">,
  ) => {
    let best: Agg | null = null;
    let bestScore = -Infinity;
    for (const a of cands) {
      const s = score(a);
      if (
        s > bestScore ||
        (s === bestScore &&
          best !== null &&
          (a.games > best.games ||
            (a.games === best.games && a.userId < best.userId)))
      ) {
        best = a;
        bestScore = s;
      }
    }
    if (best && bestScore > 0) awards.push({ ...make(best), userId: best.userId });
  };

  const qualified = aggs.filter((a) => a.games >= minGames);

  // "1 win", "2 wins" — award strings read like prose, so pluralize.
  const n = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;

  pick(
    aggs,
    (a) => a.wins * 1000 + kdaOf(a),
    (a) => ({
      key: "mvp",
      title: "MVP",
      emoji: "🏆",
      blurb: "Most wins across the season",
      value: n(a.wins, "win"),
      detail: `${kdaOf(a).toFixed(1)} KDA · ${n(a.games, "game")}`,
    }),
  );
  pick(
    aggs,
    (a) => a.kills,
    (a) => ({
      key: "killLeader",
      title: "Kill Leader",
      emoji: "⚔️",
      blurb: "Most total kills",
      value: n(a.kills, "kill"),
      detail: `${(a.kills / a.games).toFixed(1)} per game`,
    }),
  );
  pick(
    aggs,
    (a) => a.assists,
    (a) => ({
      key: "playmaker",
      title: "Playmaker",
      emoji: "🤝",
      blurb: "Most total assists",
      value: n(a.assists, "assist"),
      detail: `${(a.assists / a.games).toFixed(1)} per game`,
    }),
  );
  pick(
    qualified,
    (a) => avgGpmOf(a),
    (a) => ({
      key: "farmKing",
      title: "Farm King",
      emoji: "💰",
      blurb: `Highest avg GPM (min ${n(minGames, "game")})`,
      value: `${Math.round(avgGpmOf(a))} GPM`,
      detail: n(a.games, "game"),
    }),
  );
  pick(
    qualified,
    (a) => kdaOf(a),
    (a) => ({
      key: "bestKda",
      title: "Best KDA",
      emoji: "🎯",
      blurb: `Highest KDA ratio (min ${n(minGames, "game")})`,
      value: `${kdaOf(a).toFixed(1)} KDA`,
      detail: n(a.games, "game"),
    }),
  );
  pick(
    aggs,
    (a) => a.games,
    (a) => ({
      key: "workhorse",
      title: "Workhorse",
      emoji: "🐎",
      blurb: "Most games played",
      value: n(a.games, "game"),
      detail: `${a.wins}–${a.games - a.wins}`,
    }),
  );

  // Most-picked hero across the league.
  let topHero: { heroId: number; count: number } | null = null;
  for (const [heroId, count] of heroCount) {
    if (
      !topHero ||
      count > topHero.count ||
      (count === topHero.count && heroId < topHero.heroId)
    ) {
      topHero = { heroId, count };
    }
  }
  if (topHero) {
    awards.push({
      key: "signatureHero",
      title: "Signature Hero",
      emoji: "🔥",
      blurb: "The league's most-picked hero",
      value: n(topHero.count, "pick"),
      heroId: topHero.heroId,
    });
  }

  // Single most lopsided game (kill differential).
  if (stomp && stomp.diff > 0) {
    awards.push({
      key: "biggestStomp",
      title: "Biggest Stomp",
      emoji: "💥",
      blurb: "The most lopsided game of the season",
      value: `${stomp.hi}–${stomp.lo}`,
      detail: `+${stomp.diff} kills`,
      matchId: stomp.matchId,
    });
  }

  return awards;
}
