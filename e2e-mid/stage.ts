// Stage the fixture states seed-fixture doesn't cover: a LIVE mid-series
// match inside the auto-sync window (the chip the schedule/dashboard specs
// assert), with the rest of the open week retimed to tonight so this-week
// surfaces stay populated. Guarded like every fixture writer: refuses any
// DATABASE_URL that doesn't look like a throwaway fixture DB.
import { AUTO_SYNC } from "@/lib/constants";
import { prisma } from "@/lib/prisma";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("fixture")) {
    throw new Error(`Refusing to stage: ${url || "(unset)"} isn't a fixture DB`);
  }
  const open = await prisma.match.findMany({
    where: { status: { not: "COMPLETED" } },
    orderBy: { week: "asc" },
  });
  if (open.length === 0) throw new Error("fixture has no open matches to stage");

  await prisma.match.update({
    where: { id: open[0].id },
    data: {
      status: "LIVE",
      homeScore: 1,
      awayScore: 0,
      scheduledAt: new Date(Date.now() - 90 * 60_000),
      // In the auto-sync window on purpose (the specs assert watch-mode UI),
      // but parked at MAX BACKOFF: the real <ResultSyncPing> runs in the test
      // browser against the real /api/sync, and without this every page view
      // of every run would claim the match and roster-scan REAL OpenDota
      // (junk lookups of real early Steam accounts, the dev's API key from
      // .env attached, and a flake tail-risk if a fetch ever validated).
      // 240s << BACKOFF_DOUBLINGS ≈ 4.3h — unclaimable for the whole run.
      autoSyncedAt: new Date(),
      autoSyncAttempts: AUTO_SYNC.BACKOFF_DOUBLINGS,
    },
  });
  for (const m of open.slice(1)) {
    await prisma.match.update({
      where: { id: m.id },
      data: { scheduledAt: new Date(Date.now() + 3 * 3600_000) },
    });
  }
  console.log(`staged: 1 LIVE match + ${open.length - 1} tonight`);
}

main().finally(() => prisma.$disconnect());
