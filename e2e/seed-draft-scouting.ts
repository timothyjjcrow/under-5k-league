// Give two seeded signups a pub scouting snapshot, so the draft specs can
// open the room's scouting cards (src/components/draft-player-card.tsx) on
// real content. prisma/seed.ts gives every signup favorite heroes and a note
// but no `User.pubStats`, and a change under prisma/ forces a database
// release, so the snapshot is staged here, after `npm run db:seed`.
//
// Each snapshot is what a refresh would store: the W/L window, the all-time
// top heroes and the scouting counts folded by the app's own
// `summarizePubMatches` from about 40 OpenDota-shaped ranked rows on the
// league's home servers. Topson plays mid, Dendi a roaming 4.
//
// Guarded like every fixture writer: it accepts only this suite's exact
// SQLite file (playwright.config.ts E2E_DB_URL), never another database.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/prisma";
import { summarizePubMatches } from "../src/lib/pub-scout";
import { approxRankTierFromMmr } from "../src/lib/rank";

const E2E_DB_PATH = path.resolve(process.cwd(), "prisma/e2e.db");

function assertE2eDatabase(url: string) {
  let actual: string | null = null;
  try {
    const parsed = new URL(url);
    actual = parsed.protocol === "file:" ? fileURLToPath(parsed) : null;
  } catch {
    actual = null;
  }
  if (actual !== E2E_DB_PATH) {
    throw new Error(
      `Refusing to seed draft scouting: DATABASE_URL is not ${E2E_DB_PATH}.`,
    );
  }
}

type Plan = {
  name: string;
  /** prisma/seed.ts steamId(idx): Dendi is idx 2, Topson idx 7. */
  steamId: string;
  /** Hero ids and how many of the 40 rows each takes, most first. */
  heroes: [number, number][];
  role: "mid" | "support";
  /** The W/L window (OpenDota /wl?limit=100) and all-time totals. */
  recentWins: number;
  recentLosses: number;
  totalGames: number;
  topHeroes: { heroId: number; games: number; wins: number }[];
};

const PLANS: Plan[] = [
  {
    name: "Topson",
    steamId: "7656119800001007",
    // Invoker, Storm Spirit, Puck, Void Spirit
    heroes: [
      [74, 16],
      [17, 11],
      [13, 8],
      [126, 5],
    ],
    role: "mid",
    recentWins: 22,
    recentLosses: 18,
    totalGames: 4180,
    topHeroes: [
      { heroId: 74, games: 612, wins: 331 },
      { heroId: 17, games: 455, wins: 240 },
      { heroId: 13, games: 301, wins: 152 },
      { heroId: 11, games: 288, wins: 149 },
      { heroId: 126, games: 190, wins: 101 },
    ],
  },
  {
    name: "Dendi",
    steamId: "7656119800001002",
    // Pudge, Earthshaker, Rubick, Lion
    heroes: [
      [14, 15],
      [7, 12],
      [86, 8],
      [26, 5],
    ],
    role: "support",
    recentWins: 21,
    recentLosses: 19,
    totalGames: 2960,
    topHeroes: [
      { heroId: 14, games: 702, wins: 362 },
      { heroId: 7, games: 410, wins: 214 },
      { heroId: 86, games: 233, wins: 119 },
      { heroId: 26, games: 180, wins: 88 },
      { heroId: 74, games: 95, wins: 44 },
    ],
  },
];

const HOUR = 3_600;

/** ~40 ranked All Pick rows, newest first, the newest a day before `nowSecs`. */
function matchRows(
  plan: Plan,
  rankTier: number,
  clusters: [number, number],
  nowSecs: number,
) {
  // Interleaved in proportion, as a real hero pool reads: the k-th of a
  // hero's n games sits at (k + 0.5) / n through the window.
  const heroIds = plan.heroes
    .flatMap(([id, n]) =>
      Array.from({ length: n }, (_, k) => ({ id, at: (k + 0.5) / n })),
    )
    .sort((a, b) => a.at - b.at || a.id - b.id)
    .map((h) => h.id);
  const total = heroIds.length;
  const wins = plan.recentWins;
  return heroIds.map((heroId, i) => {
    // 7 and 40 share no factor, so (i * 7) % 40 visits every slot once:
    // exactly `wins` of the rows are wins, spread through the window.
    const won = (i * 7) % total < wins;
    const minutes = 30 + ((i * 5) % 17);
    const mid = plan.role === "mid";
    return {
      hero_id: heroId,
      player_slot: i % 2 === 0 ? 1 : 129,
      radiant_win: i % 2 === 0 ? won : !won,
      kills: mid ? 7 + (i % 6) : 3 + (i % 4),
      deaths: mid ? 3 + (i % 5) : 6 + (i % 4),
      assists: mid ? 8 + (i % 7) : 14 + (i % 9),
      gold_per_min: mid ? 540 + ((i * 13) % 140) : 280 + ((i * 11) % 80),
      last_hits: Math.round(minutes * (mid ? 6.2 + (i % 4) * 0.4 : 1.2 + (i % 3) * 0.3)),
      duration: minutes * 60 + ((i * 17) % 60),
      game_mode: 22,
      lobby_type: 7,
      party_size: i % 5 === 0 ? 2 : 1,
      // The lobby's average medal sits around their signup, a star either way.
      average_rank: Math.max(11, rankTier + ((i % 3) - 1)),
      cluster: i % 4 === 0 ? clusters[1] : clusters[0],
      leaver_status: 0,
      start_time: nowSecs - 24 * HOUR - i * 9 * HOUR - ((i * 37) % 60) * 60,
      // Mid: lane 2, the odd safe-lane game. Support: offlane (pos 4), some
      // roaming, the odd safe-lane game (pos 5).
      lane_role: mid ? (i % 8 === 0 ? 1 : 2) : i % 6 === 0 ? 1 : 3,
      is_roaming: !mid && i % 4 === 1,
    };
  });
}

async function main() {
  assertE2eDatabase(process.env.DATABASE_URL ?? "");
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true },
  });
  if (!season) throw new Error("seed-draft-scouting: no active season");
  const nowMs = Date.now();
  const nowSecs = Math.floor(nowMs / 1000);
  // The league's home servers: US East (cluster 12x) or Europe West (13x).
  const clusters: [number, number] =
    process.env.NEXT_PUBLIC_LEAGUE_REGION === "eu" ? [133, 136] : [122, 123];

  for (const plan of PLANS) {
    const user = await prisma.user.findUnique({
      where: { steamId: plan.steamId },
      select: {
        id: true,
        name: true,
        registrations: {
          where: { seasonId: season.id },
          select: { mmr: true },
        },
      },
    });
    // Fail loudly: a renamed or re-numbered seed player would otherwise
    // leave the draft specs asserting on a card with nothing to show.
    if (!user || user.name !== plan.name || user.registrations.length !== 1) {
      throw new Error(
        `seed-draft-scouting: ${plan.name} (${plan.steamId}) is not a seeded signup`,
      );
    }
    const rows = matchRows(
      plan,
      approxRankTierFromMmr(user.registrations[0].mmr),
      clusters,
      nowSecs,
    );
    const stats = {
      recentWins: plan.recentWins,
      recentLosses: plan.recentLosses,
      totalGames: plan.totalGames,
      lastPlayedAt: rows[0].start_time,
      topHeroes: plan.topHeroes,
      scout: summarizePubMatches(rows),
    };
    await prisma.user.update({
      where: { id: user.id },
      data: { pubStats: JSON.stringify(stats), pubStatsAt: new Date(nowMs) },
    });
  }
  console.log(
    `Seeded draft scouting for ${PLANS.map((p) => p.name).join(" and ")}.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
