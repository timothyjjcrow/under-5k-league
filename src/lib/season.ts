import { Prisma } from "@prisma/client";
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
  // SERIALIZABLE: "exactly one active season" has no DB constraint behind it
  // (Season.isActive is a plain Boolean), so under READ COMMITTED two
  // concurrent activations each archive what they can see and each activate
  // their own — leaving TWO active seasons, after which different readers
  // disagree about which league they are looking at. Both transactions write
  // every currently-active row, so SSI aborts one of them.
  try {
    await prisma.$transaction(
      [
        prisma.season.updateMany({
          where: { isActive: true },
          data: { isActive: false },
        }),
        prisma.season.update({
          where: { id: seasonId },
          data: { isActive: true },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if ((e as { code?: string }).code === "P2034") {
      return { ok: false, error: "Another season was just activated — reload." };
    }
    throw e;
  }
  return { ok: true, name: season.name };
}
