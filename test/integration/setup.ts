import { beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { ensureSqlitePartialUniqueIndexes, resetDb } from "./factories";

// Every integration test starts from an empty database.
beforeEach(async () => {
  await resetDb();
  await ensureSqlitePartialUniqueIndexes();
});

afterAll(async () => {
  await prisma.$disconnect();
});
