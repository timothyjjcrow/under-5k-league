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

describe("match page captain tools order and anchors", () => {
  const tools = PAGE.slice(PAGE.indexOf("id={MATCH_ANCHOR.tools}"));

  it("puts the cards that need an answer before lobby setup and reporting", () => {
    const reschedule = tools.indexOf("<RescheduleSection match={match} />");
    const standins = tools.indexOf("<StandinSection");
    const report = tools.indexOf("<ReportResultSection");
    expect(reschedule).toBeGreaterThan(-1);
    expect(standins).toBeGreaterThan(reschedule);
    expect(report).toBeGreaterThan(standins);
    expect(tools).toMatch(
      /<div id=\{MATCH_ANCHOR\.report\} className="scroll-mt-24">\s*<ReportResultSection/,
    );
  });

  it("gives every card a deep link lands on its own id", () => {
    // Discord's player-out message and the dashboard's Respond link land here.
    expect(PAGE).toContain("<Card id={MATCH_ANCHOR.standins}");
    // The editable card, the locked card and the spectator strip.
    expect(PAGE.match(/id=\{MATCH_ANCHOR\.reschedule\}/g)).toHaveLength(3);
    expect(PAGE).toContain("href={`#${MATCH_ANCHOR.standins}`}");
    expect(PAGE).toContain("href={`#${MATCH_ANCHOR.reschedule}`}");
  });
});

describe("match page captain contact", () => {
  it("shows Discord handles only through the shared contact policy", () => {
    // Two chips: the Matchup card's captain line and Captain tools'
    // "Opposing captain" line. Each is gated by canViewLeagueContact.
    expect(PAGE.match(/<DiscordTag\b/g)).toHaveLength(2);
    expect(PAGE).toMatch(
      /const captainContact = \(captainId: string\) =>\s*canViewLeagueContact\(/,
    );
    expect(PAGE).toContain(
      "captainRow?.user.discordName && captainContact(captainId)",
    );
    expect(PAGE).toMatch(/showContact=\{canViewLeagueContact\(\s*viewer,/);
    expect(PAGE).toMatch(/\{showContact \? \(\s*captain\.discordName \? \(\s*<DiscordTag/);
  });
});

