import { prisma } from "@/lib/prisma";
import { MATCH_STATUS } from "@/lib/constants";

export const SIDE_GAME_STEAM_ID = "76561190000992001";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/postseason-e2e-fixture/i.test(url)) {
    throw new Error(
      `Refusing to seed side games: ${url || "(unset)"} is not the postseason fixture DB.`,
    );
  }

  const season = await prisma.season.findFirstOrThrow({
    where: { isActive: true },
  });
  const members = await prisma.teamMember.findMany({
    where: { seasonId: season.id },
    orderBy: { id: "asc" },
    select: { userId: true },
  });
  const playerIds = [...new Set(members.map((member) => member.userId))].slice(
    0,
    5,
  );
  if (playerIds.length < 5) {
    throw new Error("Postseason fixture needs five drafted Fantasy players.");
  }

  const manager = await prisma.user.upsert({
    where: { steamId: SIDE_GAME_STEAM_ID },
    create: {
      steamId: SIDE_GAME_STEAM_ID,
      name: "Side Game Viewer",
      role: "USER",
    },
    update: { name: "Side Game Viewer", role: "USER" },
  });
  const roster = await prisma.fantasyRoster.upsert({
    where: {
      seasonId_userId: { seasonId: season.id, userId: manager.id },
    },
    create: { seasonId: season.id, userId: manager.id },
    update: {},
  });
  await prisma.$transaction([
    prisma.fantasyPick.deleteMany({ where: { rosterId: roster.id } }),
    prisma.fantasyPick.createMany({
      data: playerIds.map((userId) => ({ rosterId: roster.id, userId })),
    }),
    prisma.season.update({
      where: { id: season.id },
      data: { fantasyLockedAt: new Date() },
    }),
  ]);

  const [graded, voided] = await Promise.all([
    prisma.match.findFirst({
      where: {
        seasonId: season.id,
        status: MATCH_STATUS.COMPLETED,
        winnerTeamId: { not: null },
      },
      orderBy: [{ week: "asc" }, { id: "asc" }],
    }),
    prisma.match.findFirst({
      where: {
        seasonId: season.id,
        status: MATCH_STATUS.COMPLETED,
        winnerTeamId: null,
      },
      orderBy: [{ week: "asc" }, { id: "asc" }],
    }),
  ]);
  if (!graded || !graded.winnerTeamId || !voided) {
    throw new Error(
      "Postseason fixture needs both a decided result and a regular-season draw.",
    );
  }
  await prisma.$transaction([
    prisma.prediction.upsert({
      where: {
        matchId_userId: { matchId: graded.id, userId: manager.id },
      },
      create: {
        matchId: graded.id,
        userId: manager.id,
        pickedTeamId: graded.winnerTeamId,
      },
      update: { pickedTeamId: graded.winnerTeamId },
    }),
    prisma.prediction.upsert({
      where: {
        matchId_userId: { matchId: voided.id, userId: manager.id },
      },
      create: {
        matchId: voided.id,
        userId: manager.id,
        pickedTeamId: voided.homeTeamId,
      },
      update: { pickedTeamId: voided.homeTeamId },
    }),
  ]);

  console.log(
    `Seeded Fantasy five plus graded/void Pick'em history for ${season.name}.`,
  );
}

main().finally(() => prisma.$disconnect());
