import { describe, expect, it } from "vitest";
import {
  adminPageSource,
  folderSourceFiles,
  haystackOf,
  sourceFile,
  stripLineComments,
} from "../../../../test/support/source-files";

/**
 * Source contracts for the match page's captain tools. The page is a server
 * component with no render test (no jsdom), so the rules that keep a captain
 * from pressing a control that can only error are pinned here.
 *
 * The page is a loader plus one file per card, all in this folder. PAGE is
 * every one of them (page.tsx first), so a rule still holds wherever its card
 * moves within the folder; CARD reads one file where order inside it matters.
 */
const DIR = "src/app/matches/[id]";
const FILES = folderSourceFiles(DIR, 12);
const PAGE = stripLineComments(haystackOf(FILES));
const CARD = (name: string) =>
  stripLineComments(sourceFile(`${DIR}/${name}`).text);

describe("match page files", () => {
  it("reads the page first, then its cards", () => {
    expect(FILES[0].path).toBe(`${DIR}/page.tsx`);
    expect(FILES.map((f) => f.path)).toContain(`${DIR}/load.ts`);
  });
});

describe("match page standins summary", () => {
  // Standins are coordinated in one place (Tim, 2026-11-17): the match page
  // shows a captain who is booked, what needs cover and what waits on them,
  // and sends them to the game on the Standins page for everything else.
  it("summarises and links the Standins page, with no standin controls here", () => {
    const card = CARD("standins.tsx");
    expect(card).toContain("<Card id={MATCH_ANCHOR.standins}");
    expect(card).toContain("href={standinHubPath(match.id)}");
    // The same need the Standins page and the to-dos judge.
    expect(card).toContain("await loadSideNeeds(");
    for (const control of [
      "captainAssignStandin",
      "captainRemoveStandin",
      "captainApproveStandinRequest",
      "captainDeclineStandinRequest",
      "captainCancelStandinRequest",
      "<StandinPicker",
    ]) {
      expect(PAGE).not.toContain(control);
    }
  });
});

describe("match page captain tools order and anchors", () => {
  const TOOLS = CARD("captain-tools.tsx");
  const tools = TOOLS.slice(TOOLS.indexOf("id={MATCH_ANCHOR.tools}"));

  it("puts the cards that need an answer before lobby setup and reporting", () => {
    expect(TOOLS.indexOf("id={MATCH_ANCHOR.tools}")).toBeGreaterThan(-1);
    const reschedule = tools.indexOf(
      '<RescheduleSection match={match} viewer={viewer} part="tools" />',
    );
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
    // The locked card, the spectator strip and the picker card. A captain's
    // "moved by ready check" cards (under the scoreboard, and the seconds-old
    // one in Captain tools) carry no id, so the picker card is their anchor.
    expect(PAGE.match(/id=\{MATCH_ANCHOR\.reschedule\}/g)).toHaveLength(3);
    expect(PAGE.match(/<LockedInCard lock=\{[^\n]*\} id=\{null\} \/>/g)).toHaveLength(2);
    // A jump to the card opens its folded picker ("Change the time").
    expect(PAGE).toMatch(
      /<AutoOpenDetails\s+id=\{PICKER_ID\}\s+openFor=\{MATCH_ANCHOR\.reschedule\}/,
    );
    // The live ready check and the "moved by ready check" card, which the
    // reschedule section mounts from the shared components.
    expect(
      stripLineComments(
        sourceFile("src/components/reschedule/ready-check-card.tsx").text,
      ).match(/id=\{MATCH_ANCHOR\.reschedule\}/g),
    ).toHaveLength(1);
    expect(
      sourceFile("src/components/reschedule/locked-in-card.tsx").text,
    ).toContain("id = MATCH_ANCHOR.reschedule");
    // The captain's to-do lines go where they are answered: standin work on
    // the Standins page, a time change on this page's Reschedule card
    // (captainTodoHref, pinned in captain-todos.test.ts).
    expect(PAGE).toContain(
      "href={captainTodoHref(todo.kind, match.id, `#${MATCH_ANCHOR.reschedule}`)}",
    );
  });
});

describe("match page captain contact", () => {
  it("shows Discord handles only through the shared contact policy", () => {
    // Two chips: the Matchup card's captain line and Captain tools'
    // "Opposing captain" line, each gated by canViewLeagueContact. The
    // standins' handles are on the Standins page (cover-card-guards).
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
  // The card hands its settings to the shared picker, which owns the box.
  const PICKER = stripLineComments(
    sourceFile("src/components/reschedule/propose-times.tsx").text,
  );

  it("starts on the current kickoff and stays inside the enforced window", () => {
    // The deadline is the service's own read, so the hint can't disagree.
    expect(PAGE).toMatch(/loadRescheduleDeadline\(\s*prisma,\s*match,/);
    expect(PAGE).toContain("kickoffMs: match.scheduledAt?.getTime() ?? null");
    expect(PAGE).toContain("minTs: nowMs");
    // datetime-local's max is inclusive; the server refuses the deadline itself.
    expect(PAGE).toContain(
      "maxTs: deadline ? deadline.getTime() - 60_000 : null",
    );
    // ...but only while the box could submit it (customTimePrefill): a
    // passed kickoff under `min` blocked the whole form.
    expect(PICKER).toContain("defaultTs={customTimePrefill(kickoffMs, minTs, maxTs)}");
    expect(PICKER).toContain("minTs={minTs}");
    expect(PICKER).toContain("maxTs={maxTs}");
    expect(PICKER).toContain("describedBy={hintId}");
  });

  it("tags each quick pick by how it sits against the kickoff", () => {
    expect(PAGE).toMatch(
      /offset: kickoffOffsetLabel\(\s*ts,\s*match\.scheduledAt\?\.getTime\(\) \?\? null,\s*LEAGUE_CONFIG\.timeZone,\s*\)/,
    );
    expect(PICKER).toMatch(/\{offset \? \(\s*<span[^>]*>\s*\{offset\}/);
  });

  it("suggests only times the calendar can take", () => {
    // Quick picks avoid both teams' other fixtures and booked scrims and the
    // playoff deadline, through the tested suggestRescheduleTimes.
    expect(PAGE).toMatch(/suggestRescheduleTimes\(\{[\s\S]*?deadlineMs: deadline\?\.getTime\(\) \?\? null,[\s\S]*?busyMs:/);
    expect(PAGE).toContain("windowMs: FIXTURE_CONFLICT_WINDOW_MS");
    expect(PAGE).toContain("timeZone: LEAGUE_CONFIG.timeZone");
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

describe("match page lobby host", () => {
  // Tim, 2026-11-21: nobody but the two captains could see who makes the
  // lobby, and they saw only the home team's name, at the page's bottom.
  it("names both captains on the scoreboard for every viewer", () => {
    const card = CARD("scoreboard.tsx");
    expect(card).toContain("lobbyHostShown(match)");
    expect(card).toContain("matchLobbyHosts(match, viewer?.id ?? null)");
    expect(card).toContain("<LobbyHostLine {...lobbyHosts} />");
    // Not behind a captain or sign-in check.
    const line = card.indexOf("const lobbyHosts =");
    expect(card.slice(line, line + 160)).not.toMatch(/showCaptainTools|isCaptain/);
  });

  it("loads each captain's name with the teams, and How to host names the host", () => {
    const load = CARD("load.ts");
    expect(load).toContain(
      "homeTeam: { include: { captain: { select: { id: true, name: true } } } }",
    );
    expect(load).toContain(
      "awayTeam: { include: { captain: { select: { id: true, name: true } } } }",
    );
    expect(CARD("report-result.tsx")).toContain(
      "hostCaptainName: match.homeTeam.captain.name",
    );
  });
});

describe("match page lobby bot panel", () => {
  it("gives players, standins and admins the season lobby's name and password", () => {
    // resolveDotaLobby lets them view the season lobby, and DOTA-LOBBY-BOT.md
    // sends players to this panel for the password. It used to sit only in
    // the captain-only result card, so nobody else could ever see it.
    expect(CARD("page.tsx")).toMatch(
      /\{!showCaptainTools \? \(\s*<Suspense fallback=\{null\}>\s*<PlayerLobbyPanel match=\{match\} viewer=\{viewer\} \/>/,
    );
    const panel = CARD("lobby-panel.tsx");
    // The same windows as the captains' panel in the result card.
    expect(panel).toContain(
      'if (!viewer || !lobbyBotKindEnabled("season")) return null;',
    );
    expect(panel).toMatch(
      /!match\.season\.isActive \|\|\s*match\.status === "COMPLETED" \|\|\s*!matchResultsOpen\(match\.season\.status, match\.phase\)/,
    );
    expect(panel).toMatch(/!seesPlayerLobbyPanel\(\s*viewer,\s*match,/);
    // The players' copy shows only once the bot answers with a lobby, so an
    // unconnected bot or a missing ticket never reaches them as an alert
    // meant for an admin, pointing at steps that are in Captain tools.
    expect(panel).toMatch(
      /<DotaLobbyControls[^>]*kind="season"[^>]*audience="player"/,
    );
    // Two panels: the captains' (with the controls) and everyone else's.
    expect(PAGE.match(/<DotaLobbyControls\b/g)).toHaveLength(2);
    expect(PAGE.match(/kind="season"/g)).toHaveLength(2);
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
    // One toggle per line (a real button naming what it opens), and the
    // metrics by their full names in the panel it controls.
    const LINE = CARD("box-score-line.tsx");
    expect(LINE).toMatch(
      /<button\s+type="button"\s+aria-expanded=\{open\}\s+aria-controls=\{panelId\}[\s\S]*?Report \{report\.overall\}[\s\S]*?<\/button>/,
    );
    expect(LINE).toMatch(/<div id=\{panelId\} hidden=\{!open\}/);
    expect(LINE).toContain("{r.label}");
    // No abbreviated per-metric chips ("HD/min", "TD").
    expect(LINE).not.toContain("short");
    expect(CARD("box-score.tsx")).toContain("report={lineReport(p)}");
  });

  it("prints each game's team net worth once, in the panel", () => {
    const BOX = CARD("box-score.tsx");
    const side = BOX.slice(
      BOX.indexOf("function SidePlayers"),
      BOX.indexOf("function lineReport"),
    );
    expect(side.length).toBeGreaterThan(0);
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
  const NUDGE = stripLineComments(
    sourceFile("src/components/checkin-nudge-control.tsx").text,
  );
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
    // The control is shared with the Captains page.
    expect(PAGE).toContain(
      "<CheckinNudgeControl matchId={match.id} nudge={nudge} />",
    );
    expect(NUDGE).toMatch(/action=\{remindUnansweredCheckins\}\s*hidden=\{\{ matchId \}\}/);
  });

  it("is a single press with no confirm, and says when the next one is allowed", () => {
    expect(NUDGE).toMatch(
      /action=\{remindUnansweredCheckins\}[\s\S]{0,300}<SubmitButton variant="secondary" size="sm">/,
    );
    expect(PAGE).toContain("checkinNudgeBlockedSince(");
    expect(NUDGE).toContain("You can send another from");
  });
});

describe("match page admin tools", () => {
  const TOOLS = stripLineComments(
    sourceFile("src/components/admin-match-tools.tsx").text,
  );
  const ADMIN = stripLineComments(adminPageSource());

  it("renders for admins on the active season, above the games", () => {
    expect(PAGE).toMatch(
      /viewer\?\.role === "ADMIN" && match\.season\.isActive \? \(\s*<AdminMatchTools\s+match=\{match\}/,
    );
    const page = CARD("page.tsx");
    expect(page.indexOf("<AdminMatchTools")).toBeGreaterThan(-1);
    expect(page.indexOf("<AdminMatchTools")).toBeLessThan(
      page.indexOf('id="match-games"'),
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
      "blocked: standinPickerBlock(s.userId, target, withRequests)",
    );
    expect(block).toMatch(/const withRequests = \[\s*\.\.\.bookings,\s*\.\.\.requests\.map\(/);
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

describe("match page stakes card", () => {
  it("says tonight only on match day, judged once on the server", () => {
    const BANNER = CARD("stakes-banner.tsx");
    expect(BANNER).toContain(
      "title={stakesCardTitle(match.scheduledAt, nowMs)}",
    );
    expect(BANNER).not.toContain("title=\"Tonight's stakes\"");
    // The preview's one request time, not a second clock read per card.
    expect(CARD("match-preview.tsx")).toMatch(
      /<StakesBanner[\s\S]*?nowMs=\{previewNow\}/,
    );
  });
});

describe("match page tale of the tape", () => {
  const TAPE = CARD("tale-of-the-tape.tsx");

  it("sits in the preview after the stakes and before the Matchup card", () => {
    const preview = CARD("match-preview.tsx");
    const stakes = preview.indexOf("<StakesBanner");
    const tape = preview.indexOf("<TaleOfTheTape");
    expect(stakes).toBeGreaterThan(-1);
    expect(tape).toBeGreaterThan(stakes);
    expect(preview.indexOf("<MatchupCard")).toBeGreaterThan(tape);
    // The season's matches come from the preview's one read.
    expect(preview).toMatch(/<TaleOfTheTape[\s\S]*?seasonMatches=\{seasonMatches\}/);
  });

  it("takes every number from the tested helpers", () => {
    expect(TAPE).toContain("const rows = taleOfTheTape({");
    expect(TAPE).toContain("playoffRoad(match.homeTeamId, match, seasonMatches)");
    expect(TAPE).toContain("playoffRoad(match.awayTeamId, match, seasonMatches)");
    expect(TAPE).toContain("{playoffRoadTitle(roundLabel)}");
  });

  it("stays away until it has two numbers to compare or a road", () => {
    expect(TAPE).toContain("if (rows.length < 2 && !hasRoad) return null;");
  });

  it("stays out of the jump bar, whose chips e2e pins", () => {
    expect(CARD("page.tsx")).not.toContain('"match-tape"');
  });
});

describe("match page shared reads", () => {
  it("reads the match, season, draft and viewer once, not per card", () => {
    // Every card used to re-read the season (five places), the draft (three)
    // and the viewer. The page loads the match with its season and passes it
    // and the viewer down; the draft status is load.ts's request-cached read.
    const cards = FILES.filter(
      (f) => !/\/(page\.tsx|load\.ts)$/.test(f.path),
    );
    expect(cards.length).toBeGreaterThanOrEqual(10);
    for (const card of cards) {
      expect(card.text, card.path).not.toMatch(
        /prisma\.(season|draft)\.|prisma\.match\.findUnique|getSessionUser\(/,
      );
    }
    expect(CARD("page.tsx")).toContain("const match = await loadMatch(id);");
    expect(CARD("load.ts")).toMatch(
      /export function loadDraftStatus\([^)]*\) \{\s*return getSeasonDraftStatus\(/,
    );
  });

  it("gives the admin card from src/components the page's season and draft reads", () => {
    // AdminMatchTools lives outside this folder, so the scan above misses it.
    // It takes the season from the page's match and the draft status from the
    // same request-cached read load.ts wraps, instead of querying both again.
    const tools = stripLineComments(
      sourceFile("src/components/admin-match-tools.tsx").text,
    );
    expect(tools).not.toMatch(/prisma\.(season|draft)\.|prisma\.match\.findUnique/);
    const card = tools.slice(tools.indexOf("export async function AdminMatchTools("));
    expect(card).toContain("const season = { ...match.season, id: match.seasonId };");
    expect(card).toContain("getSeasonDraftStatus(match.seasonId),");
  });
});

describe("the ready check's Lock", () => {
  // One rule (lockOffered) decides where Lock shows, on the card and in the
  // captain's to-do list. A time showing "Everyone's in" on an open check is
  // one whose move was refused, so it must keep its Lock.
  it("comes from lockOffered on the card and in the captain's to-dos", () => {
    const card = sourceFile("src/components/reschedule/ready-check-card.tsx").text;
    const todos = sourceFile("src/lib/captain-todos.ts").text;
    expect(card).toContain("const showLock = isCaptain && lockOffered(option);");
    expect(todos).toContain("open.options.find(lockOffered)");
    expect(card).not.toMatch(/showLock[^\n]*everyoneIn/);
    expect(todos).not.toMatch(/lockRefusal === null && !o\.everyoneIn/);
  });
});

describe("match page captain shortcuts", () => {
  const BOARD = CARD("scoreboard.tsx");

  it("builds the scoreboard's jumps from the tested rule and the cards' gates", () => {
    expect(BOARD).toMatch(
      /const captainLinks = showCaptainTools\s*\? captainJumps\(\{[\s\S]*?nowMs: renderedAt,\s*\.\.\.captainCardsOpen\(match, await loadDraftStatus\(match\)\),/,
    );
    // Each jump's target comes from the tested rule: the Standins jump
    // leaves for the Standins page, the rest stay on this page.
    expect(BOARD).toContain(
      "const href = captainCardHref(match.id, jump.anchor, true);",
    );
    expect(BOARD).toContain("className={buttonClasses(jump.variant, \"sm\")}");
    // No hand-written jump label is left beside the rule's.
    expect(BOARD).not.toMatch(/Set up & report|Captain tools ↓/);
  });

  it("shows a captain 'moved by ready check' under the scoreboard, like the players", () => {
    expect(PAGE).toMatch(
      /<RescheduleSection\s+match=\{match\}\s+viewer=\{viewer\}\s+part=\{showCaptainTools \? "moved" : "all"\}/,
    );
    const card = CARD("reschedule.tsx");
    // The lasting card is the top slot's; Captain tools keeps only the
    // seconds-old celebration, in the place of the check that was locked.
    expect(card).toMatch(
      /if \(part === "moved"\) \{[\s\S]*?<LockedInCard lock=\{\{ \.\.\.lock, burst: false \}\} id=\{null\} \/>/,
    );
    expect(card).toContain(
      "{lock?.burst ? <LockedInCard lock={lock} id={null} /> : null}",
    );
  });
});
