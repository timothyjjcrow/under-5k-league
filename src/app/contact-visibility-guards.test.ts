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
const profileHeader = readFileSync(
  path.resolve(process.cwd(), "src/components/profile-header.tsx"),
  "utf8",
);
const scrimPage = readFileSync(
  path.resolve(process.cwd(), "src/app/scrims/[id]/page.tsx"),
  "utf8",
);
const homePage = readFileSync(
  path.resolve(process.cwd(), "src/app/page.tsx"),
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
    // Standins share the pool table, so their rows are built by the same
    // per-row mapping (and the same contact check) as full players.
    expect(playersPage).toMatch(
      /const poolRegistrations = \[\.\.\.players, \.\.\.standins\]/,
    );
    expect(playersPage).toMatch(
      /poolRegistrations\.map\(\(p\) => \(\{[\s\S]*?canViewLeagueContact\(\s*viewer,\s*p\.userId,\s*viewerHasActiveRegistration/,
    );
    expect(playersPage).not.toMatch(
      /standins\.map[\s\S]*?\{viewer \? \(/,
    );
  });

  it("shows a scrim's captain handles only through the shared policy", () => {
    expect(scrimPage).toMatch(/canViewLeagueContact\(\s*viewer,\s*userId,/);
    expect(scrimPage).toContain(
      "showContact={contactFor(scrim.hostTeam.captainId)}",
    );
    expect(scrimPage).toContain(
      "showContact={contactFor(scrim.opponentTeam.captainId)}",
    );
    expect(scrimPage).toMatch(/showContact \? \(\s*captain\.discordName/);
  });

  it("keeps profile contact and the private-match-data flag behind the shared policy", () => {
    // The page decides with the shared policy and hands the answer to the
    // header, which renders the members-only tokens behind it.
    expect(playerProfile).toContain(
      "const canSeeLeagueContact = canViewLeagueContact(",
    );
    expect(playerProfile).toMatch(
      /<ProfileHeader[\s\S]*?canSeeLeagueContact=\{canSeeLeagueContact\}/,
    );
    expect(profileHeader).toMatch(
      /canSeeLeagueContact && user\.fhUnavailable === true/,
    );
    expect(profileHeader).toMatch(
      /canSeeLeagueContact \? \(\s*<DiscordTag/,
    );
    expect(profileHeader).toMatch(/canSeeLeagueContact && !user\.discordName/);
  });
});

describe("home team line contact visibility wiring", () => {
  it("reads a captain's handle only through the shared policy", () => {
    const loader = homePage.slice(
      homePage.indexOf("async function captainContact("),
      homePage.indexOf("function YourTeamLine("),
    );
    expect(loader).toMatch(
      /!canViewLeagueContact\(viewer, captainId, viewerHasActiveRegistration\)/,
    );
    expect(loader).toMatch(/return null;[\s\S]*prisma\.user\.findUnique/);
    // The line renders the handle from that loader and nothing else.
    expect(homePage).toMatch(
      /captainContact\?\.discordName \? \(\s*<DiscordTag/,
    );
  });
});
