import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("public champion presentation wiring", () => {
  it.each([
    "src/app/page.tsx",
    "src/app/schedule/page.tsx",
    "src/app/teams/page.tsx",
    "src/app/teams/[id]/page.tsx",
    "src/app/seasons/page.tsx",
    "src/app/seasons/[id]/page.tsx",
    "src/app/hall-of-fame/page.tsx",
    "src/app/players/[id]/page.tsx",
    "src/app/matches/[id]/page.tsx",
  ])("routes %s through the shared champion resolver", (path) => {
    expect(read(path)).toContain("resolveChampionPresentation");
  });

  it("passes only resolved champion ids into every public bracket", () => {
    // Every public page and component, not a list of today's bracket pages:
    // a bracket added to (or moved into) another file is covered too. /admin
    // is not public and legitimately shows the raw stored champion, and so do
    // the admin-only components it shares with the match page's Admin tools
    // (the result row's title-retraction gate reads the stored champion, as
    // the correction actions do).
    const publicUi = sourceFiles(
      ["src/app/**/*.tsx", "src/components/**/*.tsx"],
      80,
    ).filter(
      (f) =>
        !f.path.startsWith("src/app/admin/") &&
        !f.path.startsWith("src/components/admin-"),
    );
    // Four public <Bracket> call sites today (the dashboard has two, then
    // /schedule and /seasons/[id]); fewer means the scan broke.
    const bracketCalls = publicUi.reduce(
      (n, f) => n + (f.text.match(/<Bracket\s/g)?.length ?? 0),
      0,
    );
    expect(bracketCalls).toBeGreaterThanOrEqual(4);
    expect(
      publicUi
        .filter((f) => f.text.includes("championTeamId={season.championTeamId}"))
        .map((f) => f.path),
    ).toEqual([]);
  });

  it("uses the authoritative final id for the match-detail crown badge", () => {
    const match = read("src/app/matches/[id]/page.tsx");

    expect(match).toContain(
      "match.id === championPresentation.authoritativeFinalId",
    );
    expect(match).toContain("championPresentation.championTeamId");
  });
});
