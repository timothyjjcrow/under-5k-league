import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...path: string[]) => readFileSync(join(__dirname, ...path), "utf8");
const HOME = read("page.tsx");
const LAYOUT = read("layout.tsx");

describe("shared-shell query efficiency", () => {
  it("checks for archived seasons without counting every archived row", () => {
    expect(LAYOUT).toMatch(/prisma\.season\.findFirst\(\{/);
    expect(LAYOUT).not.toMatch(/prisma\.season\.count\(\{/);
    expect(LAYOUT).toContain("const hasHistory = archivedSeason != null;");
  });
});

describe("homepage query efficiency", () => {
  it("reuses the season game count for the hero and fantasy lock", () => {
    expect(HOME.match(/prisma\.game\.count\(\{/g)).toHaveLength(1);
    expect(HOME).toContain("gamesOnRecord={gamesOnRecord}");
    expect(HOME).toMatch(/gamesOnRecord: number;/);
  });
});
