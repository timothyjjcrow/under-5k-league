import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/**
 * Archived-board links accept exactly one season id. Next represents a
 * repeated query key as string[]; passing that unchecked into Prisma is a 500,
 * while silently ignoring it shows the wrong season under a malformed URL.
 */
describe("archived season query wiring", () => {
  it.each([
    "src/app/recap/page.tsx",
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
});
