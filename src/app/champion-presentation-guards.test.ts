import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("public champion presentation wiring", () => {
  it.each([
    "src/app/page.tsx",
    "src/app/schedule/page.tsx",
    "src/app/teams/page.tsx",
    "src/app/teams/[id]/page.tsx",
    "src/app/recap/page.tsx",
    "src/app/seasons/page.tsx",
    "src/app/seasons/[id]/page.tsx",
    "src/app/hall-of-fame/page.tsx",
    "src/app/players/[id]/page.tsx",
    "src/app/matches/[id]/page.tsx",
    "src/app/features/page.tsx",
  ])("routes %s through the shared champion resolver", (path) => {
    expect(read(path)).toContain("resolveChampionPresentation");
  });

  it("passes only resolved champion ids into every public bracket", () => {
    for (const path of [
      "src/app/page.tsx",
      "src/app/schedule/page.tsx",
      "src/app/recap/page.tsx",
      "src/app/seasons/[id]/page.tsx",
    ]) {
      expect(read(path)).not.toContain(
        "championTeamId={season.championTeamId}",
      );
    }
  });

  it("uses the authoritative final id for the match-detail crown badge", () => {
    const match = read("src/app/matches/[id]/page.tsx");

    expect(match).toContain(
      "match.id === championPresentation.authoritativeFinalId",
    );
    expect(match).toContain("championPresentation.championTeamId");
  });
});
