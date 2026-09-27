import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";

const playersPage = readFileSync(
  path.resolve(process.cwd(), "src/app/players/page.tsx"),
  "utf8",
);
const playerProfile = readFileSync(
  path.resolve(process.cwd(), "src/app/players/[id]/page.tsx"),
  "utf8",
);

describe("player-directory contact visibility wiring", () => {
  it("does not equate any signed-in account with directory contact access", () => {
    expect(playersPage).toContain(
      "showContact={viewerCanViewLeagueDirectory}",
    );
    // Nowhere, not just on /players: any surface that hands contact details
    // to every signed-in account skips the member/subject/admin policy.
    expect(
      sourceFiles(["src/app/**/*.tsx", "src/components/**/*.tsx"], 80)
        .filter((f) => f.text.includes("showContact={!!viewer}"))
        .map((f) => f.path),
    ).toEqual([]);
  });

  it("runs standin contact through the same subject/member/admin policy", () => {
    expect(playersPage).toMatch(
      /canViewLeagueContact\(\s*viewer,\s*s\.userId,\s*viewerHasActiveRegistration/,
    );
    expect(playersPage).not.toMatch(
      /standins\.map[\s\S]*?\{viewer \? \(/,
    );
  });

  it("keeps profile contact and the private-match-data flag behind the shared policy", () => {
    expect(playerProfile).toContain(
      "const canSeeLeagueContact = canViewLeagueContact(",
    );
    expect(playerProfile).toMatch(
      /canSeeLeagueContact && user\.fhUnavailable === true/,
    );
    expect(playerProfile).toMatch(
      /canSeeLeagueContact \? \(\s*<DiscordTag/,
    );
  });
});
