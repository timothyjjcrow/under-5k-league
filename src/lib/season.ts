import { prisma } from "./prisma";
import type { Season } from "@prisma/client";

/** The single active season (most recent that hasn't been archived). */
export async function getActiveSeason(): Promise<Season | null> {
  return prisma.season.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
  });
}

export type ReactivateResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Make an archived season the active one again — the escape hatch for the one
 * irreversible admin fat-finger left: a mis-clicked "Create season" archives
 * the live season, the accidental new season can't be deleted while active,
 * and nothing else ever writes isActive back. Atomically archives whatever is
 * currently active and activates the target, so there is never zero or two
 * active seasons mid-flight. (Guards live here, service-style, so this is
 * integration-testable without auth — the admin action is a thin wrapper.)
 */
export async function reactivateSeason(
  seasonId: string,
): Promise<ReactivateResult> {
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) return { ok: false, error: "Unknown season" };
  if (season.isActive) {
    return { ok: false, error: "That season is already the active one" };
  }
  await prisma.$transaction([
    prisma.season.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    }),
    prisma.season.update({
      where: { id: seasonId },
      data: { isActive: true },
    }),
  ]);
  return { ok: true, name: season.name };
}

// Re-exported from the pure, prisma-free capacity module so callers can keep
// importing from "@/lib/season" while the math stays unit-testable in isolation.
export { capacityInfo, type CapacityInfo } from "./capacity";
