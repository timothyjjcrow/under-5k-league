import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS } from "@/lib/constants";

// Moves the open playoff series' kickoff to KICKOFF_OFFSET_MIN minutes from
// now and prints its id, so the watch-link test can stand before and inside
// the "Live now" window without waiting for a real clock.
async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/postseason-e2e-fixture/i.test(url)) {
    throw new Error(
      `Refusing to move a kickoff: ${url || "(unset)"} is not the postseason fixture DB.`,
    );
  }
  const offset = Number(process.env.KICKOFF_OFFSET_MIN);
  if (!Number.isFinite(offset)) {
    throw new Error("Set KICKOFF_OFFSET_MIN to the minutes from now.");
  }

  const match = await prisma.match.findFirst({
    where: {
      season: { isActive: true },
      phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
      status: { not: MATCH_STATUS.COMPLETED },
    },
    orderBy: [{ bracketSlot: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!match) throw new Error("The fixture has no open playoff series.");

  await prisma.match.update({
    where: { id: match.id },
    data: { scheduledAt: new Date(Date.now() + offset * 60_000) },
  });
  process.stdout.write(JSON.stringify({ matchId: match.id }));
}

main().finally(() => prisma.$disconnect());
