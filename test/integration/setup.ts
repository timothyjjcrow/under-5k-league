import { beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetInhouseRoomPollForTests } from "@/lib/inhouse-room-memo";
import { ensureSqlitePartialUniqueIndexes, resetDb } from "./factories";

// Every integration test starts from an empty database.
beforeEach(async () => {
  await resetDb();
  await ensureSqlitePartialUniqueIndexes();
  // The room poll's per-process board memo would otherwise carry one test's
  // board checks into the next.
  resetInhouseRoomPollForTests();
});

afterAll(async () => {
  await prisma.$disconnect();
});
