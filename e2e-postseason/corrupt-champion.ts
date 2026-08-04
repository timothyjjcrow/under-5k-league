import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/postseason-e2e-fixture/i.test(url)) {
    throw new Error(
      `Refusing to corrupt champion: ${url || "(unset)"} is not the postseason fixture DB.`,
    );
  }

  const season = await prisma.season.findFirst({
    where: { isActive: true, status: SEASON_STATUS.COMPLETE },
    select: { id: true },
  });
  if (!season) throw new Error("The fixture has no active completed season.");

  const final = await prisma.match.findFirst({
    where: {
      seasonId: season.id,
      phase: MATCH_PHASE.FINAL,
      status: MATCH_STATUS.COMPLETED,
      winnerTeamId: { not: null },
    },
    orderBy: { week: "desc" },
  });
  if (!final?.winnerTeamId) {
    throw new Error("The completed fixture has no decided grand final.");
  }

  const losingFinalist =
    final.winnerTeamId === final.homeTeamId
      ? final.awayTeamId
      : final.homeTeamId;
  await prisma.season.update({
    where: { id: season.id },
    data: { championTeamId: losingFinalist },
  });
  console.log(`Stored losing finalist ${losingFinalist} as the test champion.`);
}

main().finally(() => prisma.$disconnect());
