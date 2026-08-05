import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const authorityFiles = [
  "src/app/actions/admin.ts",
  "src/app/actions/availability.ts",
  "src/lib/reschedule-service.ts",
  "src/lib/result-sync-service.ts",
];

describe("active-season authority reads", () => {
  it.each(authorityFiles)("never picks one active season with findFirst in %s", (file) => {
    const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
    expect(source).not.toMatch(
      /season\.findFirst\(\{[\s\S]{0,300}?isActive:\s*true/,
    );
  });
});
