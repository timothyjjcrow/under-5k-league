// Throwaway fixture: a SIGNUPS season, the one phase seed-fixture.ts has no
// mode for (its three modes all start at REGULAR_SEASON or later). Seeds PAST
// the minimum by default, which is the state the dashboard used to render as
// "37 / 30 players to start" over a pegged progress bar — signups are uncapped,
// so that is the state the league actually sits in for most of signup week.
//
//   DATABASE_URL="file:$PWD/prisma/signups-fixture.db" npx prisma db push
//   DATABASE_URL="file:$PWD/prisma/signups-fixture.db" PLAYERS=37 CAPTAINS=7 \
//     npx tsx scripts/seed-signups-fixture.ts
//
// Then serve it: the `signups-fixture` entry in .claude/launch.json runs
// `next dev -p 3111` against this DB with dev login on (/api/auth/dev?admin=1).
//
// PLAYERS (default 37) and CAPTAINS (default 0) set the shape. CAPTAINS also
// drives /admin's Start-draft seat math: pool = PLAYERS - CAPTAINS, seats =
// CAPTAINS x (teamSize - 1), so PLAYERS = 5 x CAPTAINS is the exact-fit case.
//
// Refuses any DATABASE_URL without "fixture" in it (seed-fixture's guard) —
// the generated Prisma client's baked .env silently points at dev.db.
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("fixture")) {
  throw new Error(`Refusing to seed ${url} — pass a fixture DATABASE_URL`);
}

const prisma = new PrismaClient();

const PLAYER_COUNT = Number(process.env.PLAYERS ?? 37);

async function main() {
  // A fixture DB is reused across runs, so the reset has to reach everything a
  // browsing session can create — not just what this script writes. /inhouse is
  // reachable from every phase (the nav link is season-independent), so a poke
  // at the queue leaves lobbies, credit accounts and ledger rows behind.
  //
  // InhouseCreditEntry and AdminAction carry NO foreign key on purpose (a
  // staking record and an audit record outlive the account — see the model
  // comments in schema.prisma) and NewsPost's author is SetNull, so
  // `user.deleteMany()` cascades none of the three and they have to be named.
  // Left out, a reseeded "empty" fixture still shows a Cred board with betting
  // history on it.
  await prisma.inhouseCreditEntry.deleteMany({});
  await prisma.adminAction.deleteMany({});
  await prisma.newsPost.deleteMany({});
  await prisma.inhouseLobbyPlayer.deleteMany({});
  await prisma.inhouseLobby.deleteMany({});
  await prisma.inhouseQueueEntry.deleteMany({});
  await prisma.bid.deleteMany({});
  await prisma.standinAssignment.deleteMany({});
  await prisma.match.deleteMany({});
  await prisma.teamMember.deleteMany({});
  await prisma.draft.deleteMany({});
  await prisma.team.deleteMany({});
  await prisma.registration.deleteMany({});
  await prisma.season.deleteMany({});
  await prisma.user.deleteMany({});
  // Relationless key-value store — a stale webhook URL or honors marker would
  // otherwise outlive every season this fixture pretends to be.
  await prisma.setting.deleteMany({});

  const season = await prisma.season.create({
    data: {
      name: "Season 7",
      status: "SIGNUPS",
      minTeams: 6,
      teamSize: 5,
      isActive: true,
      matchSchedule: "Wednesdays, 8pm ET",
      draftAt: new Date(Date.now() + 5 * 24 * 3600 * 1000),
    },
  });

  // Pub-scouting variety: most players carry a snapshot (recent W/L, lifetime
  // games, last-played), a few have none (private data / never synced), and
  // one in seven is a quiet account — the pool's "last played Nmo ago" flag.
  const nowSecs = Math.floor(Date.now() / 1000);
  const pubStatsFor = (i: number): string | null => {
    if (i % 5 === 3) return null; // never synced / private
    const quiet = i % 7 === 2;
    const wins = 38 + ((i * 7) % 25); // 38..62 of 100
    return JSON.stringify({
      recentWins: wins,
      recentLosses: 100 - wins,
      totalGames: 300 + i * 173,
      lastPlayedAt: nowSecs - (quiet ? 100 : i % 10) * 86_400,
      topHeroes: [
        { heroId: 1 + (i % 30), games: 120, wins: 60 },
        { heroId: 31 + (i % 30), games: 90, wins: 41 },
      ],
    });
  };
  const STATEMENTS = [
    "Trying to break out of Archon this year.",
    "Here to learn pos 4 properly — I always solo queue.",
    "Won my bracket last season, running it back.",
    "",
  ];
  const NOTES = [
    "Comfortable on 20 heroes, will fill any lane.",
    "Techies Anonymous, $4 minimum bid please.",
    "",
    "",
  ];
  const HEROES = ["Lion, Mirana", "Pudge, Axe, Techies", "", "Invoker"];

  const poolUsers: { id: string }[] = [];
  for (let i = 0; i < PLAYER_COUNT; i++) {
    const pub = pubStatsFor(i);
    const user = await prisma.user.create({
      data: {
        steamId: `7656119800000${String(i).padStart(4, "0")}`,
        name: i === 0 ? "x" : `Player ${i + 1}`,
        role: i === 0 ? "ADMIN" : "USER",
        pubStats: pub,
        pubStatsAt: pub ? new Date() : null,
        // The pool's three Discord states: OAuth-linked (✓), typed-only,
        // and nothing (the "no Discord" marker). Linked ⊂ named.
        discordName: i % 3 === 0 ? `player${i + 1}` : "",
        discordId:
          i % 6 === 0 ? `90000000000010${String(i).padStart(2, "0")}` : null,
      },
    });
    poolUsers.push(user);
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        mmr: 1500 + i * 60,
        wantsCaptain: i < Number(process.env.CAPTAINS ?? 0) || i % 6 === 0,
        roles: ["1", "2", "3", "4", "5"][i % 5],
        status: "ACTIVE",
        statement: STATEMENTS[i % STATEMENTS.length],
        captainNote: NOTES[i % NOTES.length],
        favoriteHeroes: HEROES[i % HEROES.length],
      },
    });
  }

  // Completed inhouse lobbies so the pool's Inhouse column/sort render: the
  // first ten players clear the provisional floor (5+ games), players 11-12
  // rotate in for a taste (provisional). Winners alternate with a bias so the
  // ladder spreads.
  const lobbyCount = 8;
  for (let g = 0; g < lobbyCount; g++) {
    const roster = [...poolUsers.slice(0, 10)];
    if (poolUsers.length > 11 && g % 3 === 0) {
      roster[8] = poolUsers[10];
      roster[9] = poolUsers[11];
    }
    await prisma.inhouseLobby.create({
      data: {
        status: "COMPLETED",
        winnerTeam: g % 3 === 0 ? 2 : 1,
        radiantTeam: 1,
        radiantScore: 20 + g,
        direScore: 14 + ((g * 3) % 12),
        createdAt: new Date(Date.now() - (lobbyCount - g) * 2 * 86_400_000),
        players: {
          create: roster.map((u, idx) => ({
            userId: u.id,
            team: idx % 2 === 0 ? 1 : 2,
            mmr: 2000 + idx * 100,
          })),
        },
      },
    });
  }

  // Optional captains + their teams, so /admin's Start draft confirm can be
  // read in a real state (its seat math needs Team rows to count against).
  const captainCount = Number(process.env.CAPTAINS ?? 0);
  if (captainCount > 0) {
    const volunteers = await prisma.registration.findMany({
      where: { seasonId: season.id, type: "PLAYER", wantsCaptain: true },
      take: captainCount,
      orderBy: { mmr: "desc" },
    });
    for (const [i, reg] of volunteers.entries()) {
      const team = await prisma.team.create({
        data: {
          seasonId: season.id,
          name: `Team ${i + 1}`,
          captainId: reg.userId,
          draftOrder: i,
          budget: 100,
        },
      });
      await prisma.teamMember.create({
        data: {
          seasonId: season.id,
          teamId: team.id,
          userId: reg.userId,
          isCaptain: true,
          price: 0,
        },
      });
    }
  }

  // A couple of standins so the Standins stat isn't 0.
  for (let i = 0; i < 3; i++) {
    const user = await prisma.user.create({
      data: {
        steamId: `7656119800009${String(i).padStart(3, "0")}`,
        name: `Standin ${i + 1}`,
      },
    });
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "STANDIN",
        mmr: 2000,
        status: "ACTIVE",
      },
    });
  }

  console.log(`Seeded ${PLAYER_COUNT} players in SIGNUPS (minTeams 6, teamSize 5)`);
}

main().finally(() => prisma.$disconnect());
