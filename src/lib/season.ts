import { prisma } from "./prisma";
import type { Season } from "@prisma/client";

/** The single active season (most recent that hasn't been archived). */
export async function getActiveSeason(): Promise<Season | null> {
  return prisma.season.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
  });
}

// Re-exported from the pure, prisma-free capacity module so callers can keep
// importing from "@/lib/season" while the math stays unit-testable in isolation.
export { capacityInfo, type CapacityInfo } from "./capacity";
