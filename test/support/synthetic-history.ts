// A deterministic league history in the stored shape, for tests that measure
// what the public cache holds. Each box-score line is a full line as
// buildPlayers (src/lib/match-import.ts) writes it today: provider slot,
// six items, backpack, neutral slots, nine OpenDota benchmarks, persona name
// and ids, so a game weighs what a real one does in the cache envelope.

/** cuid-shaped ids (25 characters), like Prisma's defaults. */
const id = (kind: string, n: number) =>
  `c${kind}${n.toString(36).padStart(23 - kind.length, "0")}x`;

/** A small seeded generator (mulberry32): the same history on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BENCHMARK_KEYS = [
  "gold_per_min", "xp_per_min", "kills_per_min", "last_hits_per_min",
  "hero_damage_per_min", "hero_healing_per_min", "tower_damage",
  "stuns_per_min", "lhten",
];

export type SyntheticHistory = ReturnType<typeof syntheticHistory>;

/**
 * `games` league games over `seasons` seasons of ten teams, best-of-two
 * regular fixtures, about 60 players a season with most returning. Shapes:
 * `games` is fetchPublicGameSnapshot's row, `matches` carries every column
 * the careers and context readers select, `teams` the names.
 */
export function syntheticHistory({ games: gameCount = 500, seasons: seasonCount = 5, seed = 7 } = {}) {
  const rand = random(seed);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const perSeason = Math.ceil(gameCount / seasonCount);
  const seasons: { id: string; name: string }[] = [];
  const teams: { id: string; name: string; seasonId: string }[] = [];
  const matches: {
    id: string; seasonId: string; week: number; phase: string;
    homeTeamId: string; awayTeamId: string; status: string; winnerTeamId: string | null;
  }[] = [];
  const games: {
    id: string; matchId: string; startTime: number; fetchedAtMs: number;
    radiantWin: boolean; durationSecs: number; radiantScore: number;
    direScore: number; players: string;
  }[] = [];
  let userSerial = 0;
  const accountOf = new Map<string, number>();
  let pool: string[] = [];
  let gameSerial = 0;
  let matchSerial = 0;
  for (let s = 0; s < seasonCount; s++) {
    const seasonId = id("s", s);
    seasons.push({ id: seasonId, name: `Season ${s + 1}` });
    // About 70% of last season's players come back; the rest are new.
    pool = pool.filter(() => rand() < 0.7);
    while (pool.length < 60) {
      const userId = id("u", userSerial);
      accountOf.set(userId, userSerial++);
      pool.push(userId);
    }
    const rosters: string[][] = [];
    for (let t = 0; t < 10; t++) {
      teams.push({ id: id("t", s * 10 + t), name: `Season ${s + 1} Team ${t + 1}`, seasonId });
      rosters.push(pool.slice(t * 6, t * 6 + 6));
    }
    const seasonGames = Math.min(perSeason, gameCount - games.length);
    for (let g = 0; g < seasonGames; g += 2) {
      const home = int(0, 9);
      const away = (home + int(1, 9)) % 10;
      const matchId = id("m", matchSerial++);
      const homeTeamId = teams[s * 10 + home].id;
      const awayTeamId = teams[s * 10 + away].id;
      let homeWins = 0;
      const played = Math.min(2, seasonGames - g);
      for (let n = 0; n < played; n++) {
        const radiantWin = rand() < 0.5;
        if (radiantWin) homeWins++;
        const heroes = new Set<number>();
        while (heroes.size < 10) heroes.add(int(1, 138));
        const heroIds = [...heroes];
        // Five of each roster's six play; the sixth sits this game out.
        const sitting = [int(0, 5), int(0, 5)];
        const sides = [
          rosters[home].filter((_, i) => i !== sitting[0]),
          rosters[away].filter((_, i) => i !== sitting[1]),
        ];
        const startTime = 1_760_000_000 + s * 9_000_000 + gameSerial * 3_600;
        const lines = Array.from({ length: 10 }, (_, i) => {
          const radiant = i < 5;
          const userId = sides[radiant ? 0 : 1][i % 5];
          return {
            providerPlayerSlot: radiant ? i : 128 + i - 5,
            items: Array.from({ length: 6 }, () => int(0, 1200)),
            backpack: Array.from({ length: 3 }, () => int(0, 1200)),
            neutral: int(1500, 1700),
            neutralEnchantment: null,
            accountId: 100_000_000 + accountOf.get(userId)!,
            heroId: heroIds[i],
            isRadiant: radiant,
            kills: int(0, 20),
            deaths: int(0, 14),
            assists: int(0, 30),
            personaname: `player ${userId.slice(-8)}`,
            netWorth: int(5_000, 35_000),
            gpm: int(200, 800),
            lastHits: int(20, 450),
            xpm: int(250, 900),
            denies: int(0, 25),
            level: int(10, 30),
            heroDamage: int(3_000, 60_000),
            towerDamage: int(0, 12_000),
            heroHealing: int(0, 9_000),
            benchmarks: Object.fromEntries(BENCHMARK_KEYS.map((key) => [
              key, { raw: Math.round(rand() * 10_000) / 10, pct: Math.round(rand() * 1000) / 1000 },
            ])),
            userId,
            teamId: radiant ? homeTeamId : awayTeamId,
          };
        });
        games.push({
          id: id("g", gameSerial++),
          matchId,
          startTime,
          fetchedAtMs: (startTime + 4_000) * 1000,
          radiantWin,
          durationSecs: int(1_200, 3_600),
          radiantScore: int(5, 50),
          direScore: int(5, 50),
          players: JSON.stringify(lines),
        });
      }
      matches.push({
        id: matchId, seasonId, week: Math.floor(g / 10) + 1, phase: "REGULAR",
        homeTeamId, awayTeamId, status: "COMPLETED",
        winnerTeamId: homeWins * 2 > played ? homeTeamId : homeWins * 2 < played ? awayTeamId : null,
      });
    }
  }
  return { seasons, teams, matches, games };
}
