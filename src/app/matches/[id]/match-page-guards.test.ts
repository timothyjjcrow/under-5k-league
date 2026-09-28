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

  it("opens only the jump's target, never a folded card inside Captain tools", () => {
    // Captain tools is a plain section. The SectionNav default opens the
    // first <details> inside a target, which unfolded the lobby steps and
    // the "Result didn't show up?" import form on every Captain tools jump.
    expect(PAGE).toMatch(
      /<SectionNav\s+items=\{sectionItems\}\s+label="Match sections"\s+openNested="marked"\s*\/>/,
    );
    expect(PAGE).not.toContain("data-section-jump");
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

describe("match page reschedule form", () => {
  it("starts on the current kickoff and stays inside the enforced window", () => {
    // The deadline is the service's own read, so the hint can't disagree.
    expect(PAGE).toMatch(/await loadRescheduleDeadline\(\s*prisma,\s*match,/);
    expect(PAGE).toContain("defaultTs={match.scheduledAt?.getTime() ?? null}");
    expect(PAGE).toContain("minTs={nowMs}");
    // datetime-local's max is inclusive; the server refuses the deadline itself.
    expect(PAGE).toContain(
      "maxTs={deadline ? deadline.getTime() - 60_000 : null}",
    );
    expect(PAGE).toContain("describedBy={hintId}");
  });
});

describe("match page result card", () => {
  it("takes its timings from AUTO_SYNC via leagueResultCopy, said once", () => {
    expect(PAGE).toContain("const leagueCopy = leagueResultCopy({ live });");
    // No hand-written copy of the sync schedule beside it.
    expect(PAGE).not.toMatch(/AUTO_SYNC\.|League-feed checks begin/);
  });

  it("folds the import form before kickoff instead of removing it", () => {
    expect(PAGE).toMatch(
      /const foldImport =\s*!!match\.season\.dotaLeagueId && !live && !afterScheduledTime;/,
    );
    expect(PAGE).toMatch(
      /foldImport \? \(\s*<details>[\s\S]*?Result didn&apos;t show up\?[\s\S]*?<MatchImportControls/,
    );
  });

  it("promises results by themselves in the waiting strip only with a ticket", () => {
    // Without a ticket the captain's section says the result may not appear
    // on its own; the strip above it must not say the opposite.
    expect(PAGE).toMatch(
      /waitingForResultNote\(\{\s*hasLeagueTicket: !!match\.season\.dotaLeagueId,\s*viewerIsCaptain: showCaptainTools,/,
    );
    expect(PAGE).not.toContain("usually appear here on their own");
  });
});


describe("match page box scores", () => {
  it("keeps Game 1 open and folds later games, still reachable by id", () => {
    expect(PAGE).toMatch(
      /if \(i === 0\) \{\s*return \(\s*<Card\s+key=\{g\.id\}\s+id=\{`game-\$\{g\.id\}`\}/,
    );
    // The scoreboard's Game chips link to #game-<id>; AutoOpenDetails opens
    // the folded game when that jump lands on it.
    expect(PAGE).toMatch(/<AutoOpenDetails\s+id=\{`game-\$\{g\.id\}`\}/);
    expect(PAGE).toContain("href={`#game-${game.id}`}");
  });

  it("shows one report-card chip per player that opens the named metrics", () => {
    const strip = PAGE.slice(PAGE.indexOf("function ReportCardStrip"));
    expect(strip).toMatch(
      /<details[\s\S]*?<summary[\s\S]*?Report \{overall\}[\s\S]*?<\/summary>/,
    );
    expect(strip).toContain("{r.label}");
    // No abbreviated per-metric chips ("HD/min", "TD").
    expect(strip).not.toContain("r.short");
  });

  it("prints each game's team net worth once, in the panel", () => {
    const side = PAGE.slice(
      PAGE.indexOf("function SidePlayers"),
      PAGE.indexOf("function ReportCardStrip"),
    );
    expect(side).not.toMatch(/formatNetWorth\(totalNet\)|Net worth\{" "\}/);
    expect(PAGE).toContain("Recorded net worth");
  });
});

describe("match page scouting report", () => {
  it("starts folded on phones, keeping the Scouting jump's id on the fold", () => {
    expect(PAGE).toMatch(
      /<AutoOpenDetails\s+id="match-scouting"\s+openFromWidth="64rem"/,
    );
    expect(PAGE).toContain('{ id: "match-scouting", label: "Scouting" }');
  });

  it("shows only heroes with two games behind them, pubs labelled, no pace", () => {
    expect(PAGE).toContain("threats: threatList(board)");
    expect(PAGE).toMatch(/comfortPicks\(\s*pools\[i\],\s*parsePubStats\(r\.pubStats\)\?\.topHeroes,/);
    expect(PAGE).toMatch(/\{pubs \? \(\s*<span className="text-xs text-muted">\s*pubs/);
    expect(PAGE).not.toMatch(/paceProfile|Pace over|PaceLine/);
  });
});

describe("match page check-in reminder", () => {
  it("offers the reminder only to a captain, under their own side, while check-in is open", () => {
    // sendCheckinNudge refuses everyone but this match's captains, anything
    // but their own team, a closed check-in and a league with no channel;
    // the button follows the same rules so it never offers a refusal.
    expect(PAGE).toMatch(
      /const nudgeTeamId =\s*viewer\?\.id === match\.homeTeam\.captainId\s*\? match\.homeTeamId\s*: viewer\?\.id === match\.awayTeam\.captainId\s*\? match\.awayTeamId\s*: null;/,
    );
    expect(PAGE).toMatch(/nudgeTeamId && checkinOpen\s*\? teamAvailability\(/);
    expect(PAGE).toMatch(/\.unansweredUserIds\.filter\(\(id\) => id !== viewer!\.id\)/);
    expect(PAGE).toMatch(/nudgeTeamId && nudgeWaiting > 0 && \(await getWebhookUrl\(\)\)/);
    expect(PAGE).toContain("{nudge && s.teamId === nudge.teamId ? (");
    expect(PAGE).toMatch(/action=\{remindUnansweredCheckins\}\s*hidden=\{\{ matchId: match\.id \}\}/);
  });

  it("is a single press with no confirm, and says when the next one is allowed", () => {
    expect(PAGE).toMatch(
      /action=\{remindUnansweredCheckins\}[\s\S]{0,300}<SubmitButton variant="secondary" size="sm">/,
    );
    expect(PAGE).toContain("checkinNudgeBlockedSince(");
    expect(PAGE).toContain("You can send another from");
  });
});

describe("match page admin tools", () => {
  const TOOLS = stripLineComments(
    sourceFile("src/components/admin-match-tools.tsx").text,
  );
  const ADMIN = stripLineComments(sourceFile("src/app/admin/page.tsx").text);

  it("renders for admins on the active season, above the games", () => {
    expect(PAGE).toMatch(
      /viewer\?\.role === "ADMIN" && match\.season\.isActive \? \(\s*<AdminMatchTools\s+match=\{match\}/,
    );
    expect(PAGE.indexOf("<AdminMatchTools")).toBeGreaterThan(-1);
    expect(PAGE.indexOf("<AdminMatchTools")).toBeLessThan(
      PAGE.indexOf('id="match-games"'),
    );
  });

  it("is one folded card that a jump to #match-admin opens", () => {
    expect(TOOLS).toMatch(/<AutoOpenDetails\s+id=\{MATCH_ANCHOR\.admin\}/);
    expect(TOOLS).toMatch(/<h2[^>]*>\s*Admin tools\s*<\/h2>/);
  });

  it("renders /admin's own result row and standin block, not copies", () => {
    // One definition of each, shared by both pages, so the actions, confirms
    // and capability gates can't drift apart.
    expect(TOOLS).toContain("export function MatchResultRow(");
    expect(TOOLS).toContain("export function StandinMatchBlock(");
    expect(ADMIN).not.toMatch(/function (MatchResultRow|StandinMatchBlock)\(/);
    expect(TOOLS).toContain(
      "const correction = matchCorrectionContext(match, fixtures);",
    );
    expect(ADMIN.match(/\{\.\.\.matchCorrectionContext\(m, data\.matches\)\}/g))
      .toHaveLength(3);
    // The same standin pool on both pages.
    expect(TOOLS).toContain("where: adminStandinPoolWhere(match.seasonId),");
    expect(ADMIN).toContain("where: adminStandinPoolWhere(seasonId),");
  });

  it("gives the admin standin picker the captain picker's rules", () => {
    // Both pickers sit one card apart on the match page. The admin one used
    // to offer standins the captain one greys out (already booked here or
    // the same night), which the server then refused as a toast.
    const block = TOOLS.slice(
      TOOLS.indexOf("export function StandinMatchBlock("),
      TOOLS.indexOf("export async function AdminMatchTools("),
    );
    expect(block).toContain(
      "blocked: standinPickerBlock(s.userId, target, bookings)",
    );
    expect(block).toMatch(
      /<option key=\{s\.userId\} value=\{s\.userId\} disabled=\{!!blocked\}>/,
    );
    expect(block).toMatch(/coverChoices\(home\?\.members \?\? \[\], outIds, coveredIds\)/);
    expect(block).toMatch(/coverChoices\(away\?\.members \?\? \[\], outIds, coveredIds\)/);
    // Both callers pass the season's unplayed-fixture bookings.
    expect(TOOLS).toMatch(/bookings=\{bookings\}/);
    expect(ADMIN).toMatch(/bookings=\{bookings\}/);
  });

  it("never repeats the captain's import form for an admin who captains", () => {
    // Two "Auto-fetch games" / "Add game" forms on one page break the
    // one-control-one-name rule; the admin card points at Captain tools.
    expect(PAGE).toMatch(
      /<AdminMatchTools\s+match=\{match\}[\s\S]*?viewerHasCaptainTools=\{showCaptainTools\}/,
    );
    expect(TOOLS).toContain("captainImportOnPage={viewerHasCaptainTools}");
    expect(TOOLS).toMatch(
      /captainImportOnPage \? \([\s\S]*?href=\{`#\$\{MATCH_ANCHOR\.report\}`\}[\s\S]*?\) : resultCorrectionOpen && m\.status !== MATCH_STATUS\.COMPLETED \? \(\s*<MatchImportControls/,
    );
  });

  it("locks a live series' standin instead of offering a remove that fails", () => {
    // removeStandinGuarded refuses every removal once a game is imported, for
    // the admin path too. Same note as the captain's card.
    expect(TOOLS).toContain("const seriesStarted = m.games.length > 0;");
    expect(TOOLS).toMatch(
      /\{seriesStarted \? \([\s\S]*?Locked: series already started[\s\S]*?\) : \(\s*<ActionForm action=\{removeStandin\}>/,
    );
  });

  it("points every Needs attention item at the match page's admin tools", () => {
    expect(ADMIN).toContain(
      "href={matchAnchorPath(item.id, MATCH_ANCHOR.admin)}",
    );
    // And every /admin result row is a jump target the card links back to.
    expect(ADMIN.match(/id=\{adminMatchRowId\(m\.id\)\}/g)).toHaveLength(3);
    expect(ADMIN).toContain(
      "<RevealHashTarget prefix={ADMIN_MATCH_ROW_PREFIX} />",
    );
    expect(TOOLS).toContain("href={`/admin#${adminMatchRowId(match.id)}`}");
  });
});
