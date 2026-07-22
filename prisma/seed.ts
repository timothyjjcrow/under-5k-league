import { PrismaClient } from "@prisma/client";
import { approxRankTierFromMmr } from "../src/lib/rank";

const prisma = new PrismaClient();

const HANDLES = [
  "Dendi", "Puppey", "Miracle", "N0tail", "Ceb", "Topson", "Ana", "JerAx",
  "Sumail", "Arteezy", "Fear", "ppd", "Universe", "Fly", "Cr1t", "Zai",
  "Notail", "Kuroky", "Matumbaman", "GH", "w33", "Nisha", "Saksa", "MinD",
  "Yatoro", "Collapse", "Mira", "TORONTOTOKYO", "gpk", "DM",
];

function steamId(i: number) {
  return "765611980000" + String(1000 + i);
}

// Demo MMRs stay under the season's 4500 cap (signups above it are rejected).
function randomMmr() {
  return 1200 + Math.floor(Math.random() * 3301);
}

const HEROES = [
  "Invoker", "Pudge", "Juggernaut", "Shadow Fiend", "Lion", "Crystal Maiden",
  "Anti-Mage", "Rubick", "Earthshaker", "Storm Spirit", "Mirana", "Sniper",
];
const STATEMENTS = [
  "Here to have fun and improve.",
  "Want to climb and take it seriously.",
  "Looking for a chill, communicative team.",
  "Trying to make playoffs this season.",
];
const NOTES = [
  "Flexible on role, good comms.",
  "Best on cores, can flex support.",
  "Reliable — rarely misses games.",
  "Aggressive playstyle, loves to gank.",
  "Comfortable drafting / shotcalling.",
];
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randRoles(): string {
  const all = ["1", "2", "3", "4", "5"];
  const n = 1 + Math.floor(Math.random() * 2);
  return [...all]
    .sort(() => Math.random() - 0.5)
    .slice(0, n)
    .sort()
    .join(",");
}

async function main() {
  console.log("Resetting database…");
  // Order matters for FK constraints.
  await prisma.bid.deleteMany();
  await prisma.standinAssignment.deleteMany();
  await prisma.match.deleteMany();
  await prisma.teamMember.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.team.deleteMany();
  await prisma.registration.deleteMany();
  await prisma.inhouseLobbyPlayer.deleteMany();
  await prisma.inhouseLobby.deleteMany();
  await prisma.inhouseQueueEntry.deleteMany();
  await prisma.season.deleteMany();
  await prisma.user.deleteMany();
  await prisma.setting.deleteMany();

  console.log("Creating admin + season…");
  const admin = await prisma.user.create({
    data: {
      steamId: "76561190000000001",
      name: "Admin",
      role: "ADMIN",
      profileUrl: "https://steamcommunity.com/id/admin",
      rankTier: approxRankTierFromMmr(4200), // matches the signup MMR below
    },
  });

  const season = await prisma.season.create({
    data: {
      name: "Season 1",
      status: "SIGNUPS",
      teamSize: 5,
      minTeams: 4,
      draftBudget: 100,
      maxMmr: 4500,
      isActive: true,
    },
  });

  // Admin also signs up to play (and volunteers to captain).
  await prisma.registration.create({
    data: {
      seasonId: season.id,
      userId: admin.id,
      type: "PLAYER",
      mmr: 4200,
      wantsCaptain: true,
    },
  });

  console.log("Creating players…");
  // 16 more players -> 17 total (needs 20 for 4 teams: shows "3 more needed").
  const players = HANDLES.slice(0, 16);
  const playerSeeds: { id: string; mmr: number }[] = [];
  let idx = 2;
  for (const name of players) {
    // MMR first so the medal on the profile matches the signup number.
    const mmr = randomMmr();
    const user = await prisma.user.create({
      data: {
        steamId: steamId(idx),
        name,
        profileUrl: `https://steamcommunity.com/profiles/${steamId(idx)}`,
        rankTier: approxRankTierFromMmr(mmr),
      },
    });
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        mmr,
        wantsCaptain: Math.random() < 0.25,
        roles: randRoles(),
        favoriteHeroes: [pick(HEROES), pick(HEROES)].join(", "),
        statement: pick(STATEMENTS),
        captainNote: pick(NOTES),
      },
    });
    playerSeeds.push({ id: user.id, mmr });
    idx++;
  }

  console.log("Seeding an inhouse queue (6/10) for demo…");
  // Independent of the league — puts a partial queue on /inhouse out of the box.
  // Heartbeats are seeded ALREADY-AWAY: the rows render (dimmed, "away" chip)
  // so the page looks alive, but they can never be pulled into a REAL lobby —
  // without this, four humans queueing within 90s of a fresh seed would form
  // a lobby around six ghosts. (Also keeps the e2e's lobby formation clean.)
  let joined = Date.now() - 6 * 60_000;
  for (const p of playerSeeds.slice(0, 6)) {
    await prisma.inhouseQueueEntry.create({
      data: {
        userId: p.id,
        mmr: p.mmr,
        joinedAt: new Date(joined),
        lastSeenAt: new Date(Date.now() - 100_000),
      },
    });
    joined += 60_000;
  }

  console.log("Creating standins…");
  for (const name of HANDLES.slice(16, 19)) {
    const mmr = randomMmr();
    const user = await prisma.user.create({
      data: {
        steamId: steamId(idx),
        name,
        profileUrl: `https://steamcommunity.com/profiles/${steamId(idx)}`,
        rankTier: approxRankTierFromMmr(mmr),
      },
    });
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "STANDIN",
        mmr,
      },
    });
    idx++;
  }

  const counts = {
    users: await prisma.user.count(),
    players: await prisma.registration.count({
      where: { type: "PLAYER" },
    }),
    standins: await prisma.registration.count({
      where: { type: "STANDIN" },
    }),
  };
  console.log("Done:", counts);
  console.log("\nAdmin login (dev): /api/auth/dev?name=Admin&steamId=76561190000000001&admin=1");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
