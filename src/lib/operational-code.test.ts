import { describe, expect, it } from "vitest";
import { prismaErrorCode } from "./operational-code";

describe("prismaErrorCode", () => {
  it("retains only standard Prisma machine codes", () => {
    expect(prismaErrorCode({ code: "P2034" })).toBe("P2034");
    expect(prismaErrorCode({ code: "P1000" })).toBe("P1000");
  });

  it.each([
    { code: "SECRETLOOKINGTOKEN" },
    { code: "P12345" },
    { code: "p2034" },
    { code: 2034 },
    new Error("postgresql://secret@internal/league"),
  ])("rejects non-Prisma exception metadata %#", (error) => {
    expect(prismaErrorCode(error)).toBeNull();
  });
});
