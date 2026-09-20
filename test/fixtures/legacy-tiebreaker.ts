import { prisma } from "@/lib/prisma";
import { projectPlayoffField } from "@/lib/playoff-field";
import { tiebreakerSlot } from "@/lib/tiebreakers";
import path from "node:path";
import { assertPostgresTestUrl } from "../../scripts/test-db-safety.mjs";

/** Recreate a published pre-upgrade opening to exercise backward compatibility. */
export async function seedLegacyTiebreaker(seasonId: string) {
  const url = process.env.DATABASE_URL ?? "";
  if (!["test.db", "postseason-e2e-fixture.db"].some((name) => url === `file:${path.resolve("prisma", name)}`)) {
    assertPostgresTestUrl(url);
  }
  const [teams, matches] = await Promise.all([
    prisma.team.findMany({ where: { seasonId } }), prisma.match.findMany({ where: { seasonId } }),
  ]);
  const groups = projectPlayoffField(teams, matches, "legacy").tiebreakers.groups;
  const week = Math.max(...matches.map((m) => m.week)) + 1;
  for (const group of groups) {
    const pairs = group.drawRequired ? [{ home: group.teamIds[0], away: group.teamIds[1] }] : group.pairings;
    await prisma.match.createMany({ data: pairs.map((pair, i) => ({
      seasonId, week, phase: "TIEBREAKER", homeTeamId: pair.home, awayTeamId: pair.away,
      bestOf: group.bestOf, bracketSlot: tiebreakerSlot(group, i), scheduledAt: new Date(Date.now() + 7 * 86400_000),
    })) });
  }
  await prisma.season.update({ where: { id: seasonId }, data: { currentWeek: week } });
}
