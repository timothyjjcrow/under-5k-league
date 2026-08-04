import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const playersPage = readFileSync(
  path.resolve(process.cwd(), "src/app/players/page.tsx"),
  "utf8",
);

describe("player-directory contact visibility wiring", () => {
  it("does not equate any signed-in account with directory contact access", () => {
    expect(playersPage).toContain(
      "showContact={viewerCanViewLeagueDirectory}",
    );
    expect(playersPage).not.toContain("showContact={!!viewer}");
  });

  it("runs standin contact through the same subject/member/admin policy", () => {
    expect(playersPage).toMatch(
      /canViewLeagueContact\(\s*viewer,\s*s\.userId,\s*viewerHasActiveRegistration/,
    );
    expect(playersPage).not.toMatch(
      /standins\.map[\s\S]*?\{viewer \? \(/,
    );
  });
});
