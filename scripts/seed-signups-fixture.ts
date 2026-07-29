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
  await prisma.teamMember.deleteMany({});
  await prisma.team.deleteMany({});
  await prisma.registration.deleteMany({});
  await prisma.season.deleteMany({});
  await prisma.user.deleteMany({});

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

  for (let i = 0; i < PLAYER_COUNT; i++) {
    const user = await prisma.user.create({
      data: {
        steamId: `7656119800000${String(i).padStart(4, "0")}`,
        name: i === 0 ? "x" : `Player ${i + 1}`,
        role: i === 0 ? "ADMIN" : "USER",
      },
    });
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        mmr: 1500 + i * 60,
        wantsCaptain: i < Number(process.env.CAPTAINS ?? 0) || i % 6 === 0,
        roles: ["1", "2", "3", "4", "5"][i % 5],
        status: "ACTIVE",
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
