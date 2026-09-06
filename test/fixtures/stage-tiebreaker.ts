import { prisma } from "@/lib/prisma";
import { assertExpectedFixtureDatabase } from "@/lib/fixture-database";
import { roundRobin } from "@/lib/schedule";

async function main() {
  assertExpectedFixtureDatabase(
    process.env.DATABASE_URL ?? "",
    ["postseason"],
    "stage the playoff-cut tiebreaker browser fixture",
  );
  const season = await prisma.season.findFirstOrThrow({
    where: { isActive: true },
  });
  const teams = await prisma.team.findMany({
    where: { seasonId: season.id },
    orderBy: { draftOrder: "asc" },
    take: 6,
  });
  if (teams.length !== 6)
    throw new Error("The tiebreaker browser fixture requires six teams.");
  const ids = teams.map((team) => team.id);
  const threeTeamTie = process.argv.includes("--three");
  const rank = new Map(ids.map((id, index) => [id, index]));
  const firstNight = new Date(Date.now() - 28 * 86400_000);
  const rounds = roundRobin(ids);
  await prisma.$transaction(async (tx) => {
    await tx.match.deleteMany({ where: { seasonId: season.id } });
    await tx.team.updateMany({
      where: { seasonId: season.id },
      data: { withdrawn: true },
    });
    await tx.team.updateMany({
      where: { id: { in: ids } },
      data: { withdrawn: false },
    });
    await tx.season.update({
      where: { id: season.id },
      data: {
        status: "REGULAR_SEASON",
        championTeamId: null,
        currentWeek: rounds.length,
        firstMatchNight: firstNight,
      },
    });
    for (const [index, round] of rounds.entries()) {
      for (const pairing of round) {
        const homeRank = rank.get(pairing.home)!;
        const awayRank = rank.get(pairing.away)!;
        // Fourth and fifth beat sixth, lose to the top three, and draw each
        // other: equal points, game differential, wins and head-to-head.
        const tied = threeTeamTie
          ? [homeRank, awayRank].every((rank) => rank >= 2 && rank <= 4)
          : [homeRank, awayRank].sort().join(",") === "3,4";
        const homeWins = homeRank < awayRank;
        await tx.match.create({
          data: {
            seasonId: season.id,
            week: index + 1,
            phase: "REGULAR",
            bestOf: 2,
            homeTeamId: pairing.home,
            awayTeamId: pairing.away,
            status: "COMPLETED",
            homeScore: tied ? 1 : homeWins ? 2 : 0,
            awayScore: tied ? 1 : homeWins ? 0 : 2,
            winnerTeamId: tied ? null : homeWins ? pairing.home : pairing.away,
            scheduledAt: new Date(firstNight.getTime() + index * 7 * 86400_000),
          },
        });
      }
    }
  });
  console.log(
    threeTeamTie
      ? `Tiebreaker fixture ready: ${teams.slice(2, 5).map((team) => team.name).join(", ")} tied for third through fifth.`
      : `Tiebreaker fixture ready: ${teams[3].name} and ${teams[4].name} tied for the fourth playoff place.`,
  );
}

main().finally(() => prisma.$disconnect());
