import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";

// The active season is resolved by getActiveSeason (singleActiveSeason), which
// fails closed when more than one row is marked active. A
// `season.findFirst({ where: { isActive: true } })` anywhere else would
// silently pick one of them instead. That shortcut can land in any action,
// service or page, so the guard reads all of them rather than a list of known
// callers.
const authorityFiles = sourceFiles(
  ["src/app/**/*.{ts,tsx}", "src/lib/**/*.ts", "src/components/**/*.{ts,tsx}"],
  250,
);

describe("active-season authority reads", () => {
  it("reads the files it used to name, among the rest", () => {
    const paths = authorityFiles.map((f) => f.path);
    for (const file of [
      "src/app/actions/admin.ts",
      "src/app/actions/availability.ts",
      "src/lib/availability-service.ts",
      "src/lib/reschedule-service.ts",
      "src/lib/result-sync-service.ts",
    ]) {
      expect(paths).toContain(file);
    }
  });

  it("never picks one active season with findFirst", () => {
    const offenders = authorityFiles
      .filter((f) =>
        /season\.findFirst\(\{[\s\S]{0,300}?isActive:\s*true/.test(f.text),
      )
      .map((f) => f.path);
    expect(
      offenders,
      "resolve the active season with getActiveSeason, which refuses to guess between two active rows",
    ).toEqual([]);
  });
});
