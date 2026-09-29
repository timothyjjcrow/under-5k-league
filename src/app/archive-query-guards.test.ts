import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/**
 * Archived-board links accept exactly one season id. Next represents a
 * repeated query key as string[]; passing that unchecked into Prisma is a 500,
 * while silently ignoring it shows the wrong season under a malformed URL.
 */
describe("archived season query wiring", () => {
  it.each([
    "src/app/fantasy/page.tsx",
    "src/app/pickem/page.tsx",
    "src/app/players/[id]/page.tsx",
  ])("normalizes and rejects repeated season keys in %s", (path) => {
    const source = read(path);
    expect(source).toContain('from "@/lib/search-params"');
    expect(source).toContain("singleSearchParam(");
    expect(source).toMatch(/=== null\) notFound\(\)/);
    expect(source).toMatch(/season\?: string \| string\[\]/);
  });

  it("rejects repeated season keys in the /recap redirect", () => {
    // A route handler reads the raw URL, so it must ask for EVERY value:
    // searchParams.get() would quietly take the first of a repeated key.
    const source = read("src/app/recap/route.ts");
    expect(source).toContain('searchParams.getAll("season")');
    expect(source).toContain("singleSearchParam(");
    expect(source).toMatch(/=== null\) notFound\(\)/);
    expect(source).not.toMatch(/searchParams\.get\("season"\)/);
  });
});

describe("every page that takes ?season= normalizes it", () => {
  // The pages above were the ones found first; any page that accepts a
  // season id has the same string[] hazard, including ones added later.
  const seasonPages = sourceFiles("src/app/**/page.tsx", 20).filter((f) =>
    /season\?:\s*string/.test(f.text),
  );

  it("finds the season-scoped pages (guard is not vacuous)", () => {
    // Nine today: the three above plus leaders, meta, records, scrims and
    // two admin pages.
    expect(seasonPages.length).toBeGreaterThanOrEqual(8);
  });

  it("routes every one of them through singleSearchParam", () => {
    const unguarded = seasonPages
      .filter(
        (f) =>
          !f.text.includes('from "@/lib/search-params"') ||
          !f.text.includes("singleSearchParam("),
      )
      .map((f) => f.path);
    expect(unguarded).toEqual([]);
  });
});
