import { prisma } from "./prisma";
import { createPublicSnapshot } from "./public-cache";

// Only the public existence flag persists. Active-season authorization,
// sessions, and membership continue to read fresh within each render.
export const getPublicHasHistory = createPublicSnapshot(
  "public-navigation-history-v1",
  async () => (await prisma.season.findFirst({
    where: { isActive: false },
    select: { id: true },
  })) !== null,
);
