import { describe, expect, it } from "vitest";
import { prismaLogLevels } from "./prisma-log-policy";

describe("Prisma log policy", () => {
  it("never enables direct Prisma stdout errors in production", () => {
    expect(prismaLogLevels("production")).toEqual([]);
  });

  it("keeps useful local diagnostics without adding test noise", () => {
    expect(prismaLogLevels("development")).toEqual(["error", "warn"]);
    expect(prismaLogLevels("test")).toEqual([]);
  });
});
