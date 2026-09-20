import { execFileSync } from "node:child_process";
import { prisma } from "@/lib/prisma";
import { assertExpectedFixtureDatabase } from "@/lib/fixture-database";
import { roundRobin } from "@/lib/schedule";
import { seedLegacyTiebreaker } from "./legacy-tiebreaker";

async function main() {
  assertExpectedFixtureDatabase(
    process.env.DATABASE_URL ?? "",
    ["postseason"],
    "stage the playoff-cut tiebreaker browser fixture",
  );
  // The full postseason suite ends by opening a new, empty active season.
  // Rebuild this test's baseline every time so neither that handoff nor a
  // previous tiebreaker test can supply its teams, settings or results.
  // Keep the exact dedicated-database guard above the destructive reseed.
  execFileSync(process.execPath, ["--import", "tsx", "e2e-postseason/seed.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, FIXTURE_MODE: "playoffs", FIXTURE_TEAMS: "8" },
    stdio: "pipe",
  });
  const season = await prisma.season.findFirstOrThrow({
    where: { isActive: true },
  });
  const teams = await prisma.team.findMany({
    where: { seasonId: season.id },
    orderBy: { draftOrder: "asc" },
    take: process.argv.includes("--all") ? 8 : 6,
  });
  if (teams.length !== (process.argv.includes("--all") ? 8 : 6))
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
        const tied = process.argv.includes("--all") || (threeTeamTie
          ? [homeRank, awayRank].every((rank) => rank >= 2 && rank <= 4)
          : [homeRank, awayRank].sort().join(",") === "3,4");
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
  if (process.argv.includes("--legacy")) await seedLegacyTiebreaker(season.id);
  console.log(
    threeTeamTie
      ? `Tiebreaker fixture ready: ${teams.slice(2, 5).map((team) => team.name).join(", ")} tied for third through fifth.`
      : `Tiebreaker fixture ready: ${teams[3].name} and ${teams[4].name} tied for the fourth playoff place.`,
  );
  if (process.argv.includes("--live")) {
    const live = await prisma.match.findFirstOrThrow({
      where: {
        seasonId: season.id,
        homeTeamId: { in: ids.slice(3, 5) },
        awayTeamId: { in: ids.slice(3, 5) },
      },
    });
    await prisma.match.update({
      where: { id: live.id },
      data: { status: "LIVE", homeScore: 1, awayScore: 0, winnerTeamId: null },
    });
    console.log(JSON.stringify({
      liveMatchId: live.id,
      homeTeamId: live.homeTeamId,
      awayTeamId: live.awayTeamId,
    }));
  }
}

main().finally(() => prisma.$disconnect());
