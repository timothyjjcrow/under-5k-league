import { PrismaClient } from "@prisma/client";
import { prismaLogLevels } from "./prisma-log-policy";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: prismaLogLevels(process.env.NODE_ENV),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
