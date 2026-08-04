import { prisma } from "@/lib/prisma";
import { SEASON_STATUS } from "@/lib/constants";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/postseason-e2e-fixture/i.test(url)) {
    throw new Error(
      `Refusing to remove games: ${url || "(unset)"} is not the postseason fixture DB.`,
    );
  }

  const completed = await prisma.season.findFirst({
    where: {
      isActive: true,
      status: SEASON_STATUS.COMPLETE,
      championTeamId: { not: null },
    },
    select: { id: true },
  });
  if (!completed) {
    throw new Error("The fixture has no completed champion season.");
  }

  const matches = await prisma.match.findMany({
    where: { seasonId: completed.id },
    select: { id: true },
  });
  const removed = await prisma.game.deleteMany({
    where: { matchId: { in: matches.map((match) => match.id) } },
  });
  console.log(`Removed ${removed.count} imported games.`);
}

main().finally(() => prisma.$disconnect());
