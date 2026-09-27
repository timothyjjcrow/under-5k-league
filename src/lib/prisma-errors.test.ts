import { describe, expect, it } from "vitest";
import {
  isRecordNotFound,
  isSerializationConflict,
  isUniqueViolation,
} from "./prisma-errors";

// Shaped like Prisma's PrismaClientKnownRequestError: an Error carrying
// `code` and optional `meta`.
function prismaError(code: string, meta?: Record<string, unknown>) {
  return Object.assign(new Error(`Prisma ${code}`), { code, meta });
}

const notPrismaErrors: unknown[] = [
  null,
  undefined,
  "P2034",
  2034,
  new Error("P2034 in a message is not a code"),
  { code: 2034 },
  { code: "p2034" },
];

describe("isSerializationConflict", () => {
  it("recognises Prisma's serialization failure", () => {
    expect(isSerializationConflict(prismaError("P2034"))).toBe(true);
    expect(isSerializationConflict({ code: "P2034" })).toBe(true);
  });

  it("recognises a raw query's serialization failure (P2010 + SQLSTATE 40001)", () => {
    expect(
      isSerializationConflict(prismaError("P2010", { code: "40001" })),
    ).toBe(true);
  });

  it("does not treat other raw-query failures as a conflict", () => {
    expect(isSerializationConflict(prismaError("P2010"))).toBe(false);
    expect(
      isSerializationConflict(prismaError("P2010", { code: "23505" })),
    ).toBe(false);
    expect(isSerializationConflict({ code: "P2010", meta: null })).toBe(false);
    // SQLSTATE 40001 only means "retry" when Prisma reports it as a raw query.
    expect(
      isSerializationConflict(prismaError("P2002", { code: "40001" })),
    ).toBe(false);
  });

  it("is false for unique violations and missing rows", () => {
    expect(isSerializationConflict(prismaError("P2002"))).toBe(false);
    expect(isSerializationConflict(prismaError("P2025"))).toBe(false);
  });

  it.each(notPrismaErrors)("never throws on non-Prisma input %#", (error) => {
    expect(isSerializationConflict(error)).toBe(false);
  });
});

describe("isUniqueViolation", () => {
  it("recognises P2002 only", () => {
    expect(isUniqueViolation(prismaError("P2002"))).toBe(true);
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation(prismaError("P2034"))).toBe(false);
    expect(isUniqueViolation(prismaError("P2025"))).toBe(false);
  });

  it.each(notPrismaErrors)("never throws on non-Prisma input %#", (error) => {
    expect(isUniqueViolation(error)).toBe(false);
  });
});

describe("isRecordNotFound", () => {
  it("recognises P2025 only", () => {
    expect(isRecordNotFound(prismaError("P2025"))).toBe(true);
    expect(isRecordNotFound(prismaError("P2002"))).toBe(false);
    expect(isRecordNotFound(prismaError("P2034"))).toBe(false);
  });

  it.each(notPrismaErrors)("never throws on non-Prisma input %#", (error) => {
    expect(isRecordNotFound(error)).toBe(false);
  });
});
