import { describe, expect, it } from "vitest";
import {
  sourceFile,
  stripLineComments,
} from "../../../../test/support/source-files";

/**
 * Source contracts for the match page's captain tools. The page is a server
 * component with no render test (no jsdom), so the rules that keep a captain
 * from pressing a control that can only error are pinned here.
 */
const PAGE = stripLineComments(sourceFile("src/app/matches/[id]/page.tsx").text);

describe("match page standins card", () => {
  it("offers Remove only before the series has a game", () => {
    // removeStandinGuarded refuses once games are imported, so the button
    // would only ever open a confirm and then fail.
    expect(PAGE).toContain("seriesStarted={games.length > 0}");
    expect(PAGE).toMatch(
      /a\.teamId !== myTeamId \? null : seriesStarted \? \([\s\S]*?Locked: series already started[\s\S]*?captainRemoveStandin/,
    );
  });

  it("keeps standins the server would refuse out of reach, with the reason", () => {
    // Same bookings the server checks: this season's unplayed fixtures.
    expect(PAGE).toMatch(
      /standinUserId: \{ in: pool\.map\(\(r\) => r\.userId\) \},\s*match: \{\s*seasonId: match\.seasonId,\s*status: \{ not: MATCH_STATUS\.COMPLETED \},/,
    );
    expect(PAGE).toContain(
      "blocked: standinPickerBlock(r.userId, pickerTarget, bookingRows)",
    );
    expect(PAGE).toMatch(
      /<option key=\{r\.userId\} value=\{r\.userId\} disabled=\{!!blocked\}>/,
    );
  });

  it("leads the Covers list with uncovered out players, pre-selecting a lone one", () => {
    expect(PAGE).toMatch(/const cover = coverChoices\(\s*roster,/);
    // Remounted when the pre-selection changes: an uncontrolled select keeps
    // its first defaultValue otherwise.
    expect(PAGE).toMatch(
      /<select\s+key=\{cover\.preselect \?\? ""\}\s+name="replacingUserId"[\s\S]*?defaultValue=\{cover\.preselect \?\? ""\}/,
    );
    expect(PAGE).toContain("(can&apos;t make it)");
  });
});
