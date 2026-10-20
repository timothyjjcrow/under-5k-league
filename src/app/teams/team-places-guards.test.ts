import { describe, expect, it } from "vitest";
import {
  sourceFiles,
  stripLineComments,
  type SourceFile,
} from "../../../test/support/source-files";

// In a group season the field's `standings` is group A's table followed by
// group B's, so a row's index is no place, and a frozen bracket's seed number
// is no name (A1 is seed 1, B1 seed 2). The pages that print a team's place
// or seed read them through the season-groups helpers, whose tests pin the
// words ("2nd in Group A", "#2 of 6 in Group A", "Seed A1").

const code = (file: SourceFile) => stripLineComments(file.text);

describe("team places and seeds on the team, player and match pages", () => {
  const files = sourceFiles(
    ["src/app/teams/**/*.tsx", "src/app/players/**/*.tsx", "src/app/matches/**/*.tsx"],
    20,
  );
  const page = (path: string) => {
    const file = files.find((f) => f.path === path);
    if (!file) throw new Error(`${path} moved: re-point this guard`);
    return code(file);
  };

  it("never takes a place from an index of the league's rows", () => {
    for (const file of files) {
      expect(code(file), file.path).not.toMatch(/standings\.(?:findIndex|indexOf)\(/);
      expect(code(file), file.path).not.toMatch(
        /standings\.map\(\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\[\s*\w+\.teamId\s*,\s*\w+\s*\+\s*1\s*\]\s*\)/,
      );
    }
  });

  it("orders, places and seeds the Teams cards by group", () => {
    const list = page("src/app/teams/page.tsx");
    // Order: A1, B1, A2, B2…; the printed place is the group's.
    expect(list).toMatch(/placeOrder\(field\)/);
    expect(list).toMatch(/placeInTable\(field, /);
    expect(list).toMatch(/placeLabel\(place\)/);
    expect(list).toMatch(/bracketSeedLabels\(seedOf, /);
  });

  it("badges a team's page with its group place and bracket seed", () => {
    const team = page("src/app/teams/[id]/page.tsx");
    expect(team).toMatch(/placeInTable\(playoffField, id\)/);
    // The badge beside the name and the line under it after the seeding.
    expect(team.match(/rankOfLabel\(place\)/g)).toHaveLength(2);
    expect(team).toMatch(/bracketSeedLabels\(seeds, /);
  });

  it("gives the profile's rank tile the group's place", () => {
    const profile = page("src/app/players/[id]/page.tsx");
    expect(profile).toMatch(/tablePlaceOf\(field, team\.id\)/);
    expect(profile).toMatch(/groupKey: teamPlace\?\.groupKey/);
  });
});
