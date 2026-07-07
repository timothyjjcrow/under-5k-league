import { beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./factories";

// Every integration test starts from an empty database.
beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});
