import { prisma } from "@/lib/prisma";
import { SEASON_STATUS } from "@/lib/constants";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/postseason-e2e-fixture/i.test(url)) {
    throw new Error(
      `Refusing to archive: ${url || "(unset)"} is not the postseason fixture DB.`,
    );
  }

  const completed = await prisma.season.findFirst({
    where: {
      isActive: true,
      status: SEASON_STATUS.COMPLETE,
      championTeamId: { not: null },
    },
  });
  if (!completed) {
    throw new Error(
      "The completed postseason fixture has no active champion season.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.season.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    });
    await tx.season.create({
      data: {
        name: "Season 10 (fixture)",
        status: SEASON_STATUS.SIGNUPS,
        isActive: true,
        minTeams: completed.minTeams,
        teamSize: completed.teamSize,
        regularBestOf: completed.regularBestOf,
        playoffBestOf: completed.playoffBestOf,
        finalBestOf: completed.finalBestOf,
      },
    });
  });

  console.log(`Archived ${completed.name}; Season 10 (fixture) is active.`);
}

main().finally(() => prisma.$disconnect());
