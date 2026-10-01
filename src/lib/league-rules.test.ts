import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  sourceFile,
  sourceFiles,
  stripLineComments,
  type SourceFile,
} from "../../test/support/source-files";
import {
  AUTO_SYNC,
  DEFAULTS,
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "./constants";
import { canBid, maxBid, nextNominatorIndex } from "./draft";
import { eligibilityText, resultsCopy, standinSignupOpen } from "./how-it-works";
import { createLeagueConfig } from "./league-config";
import {
  matchCheckinOpen,
  matchLogisticsOpen,
  standinAssignmentOpen,
} from "./league-lifecycle";
import {
  RULES_CLOSING,
  leagueRules,
  type LeagueRules,
  type LeagueRulesInput,
  type RulesSeason,
} from "./league-rules";
import { NO_TICKET_RESULT_LEAD } from "./match-hosting";
import { projectPlayoffField } from "./playoff-field";
import { registrationGate } from "./registration";
import { nextRoundPairings } from "./schedule";
import { carriedSeasonSettings } from "./season-handoff";
import { computeStandings, type MatchLike } from "./standings";

const US = createLeagueConfig({});
const EU = createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: "eu" });
const HOUR_MS = 60 * 60 * 1000;

function season(overrides: Partial<RulesSeason> = {}): RulesSeason {
  return {
    ...carriedSeasonSettings(null),
    name: "Season 9",
    status: SEASON_STATUS.REGULAR_SEASON,
    isActive: true,
    dotaLeagueId: "17119",
    ...overrides,
  };
}

function build(input: Partial<LeagueRulesInput> = {}): LeagueRules {
  return leagueRules({
    season: season(),
    matchNight: "Sundays at 6:00 PM Pacific time",
    teamCount: 6,
    config: US,
    ...input,
  });
}

function section(rules: LeagueRules, id: string): string {
  const found = rules.sections.find((s) => s.id === id);
  expect(found, `section ${id}`).toBeDefined();
  return found!.rules.join("\n");
}

function everything(rules: LeagueRules): string {
  return [
    rules.basis,
    ...rules.sections.flatMap((s) => [s.title, ...s.rules]),
    rules.closing,
  ].join("\n");
}

describe("leagueRules", () => {
  it("covers the ten sections in reading order and ends on the closing line", () => {
    const rules = build();
    expect(rules.sections.map((s) => s.id)).toEqual([
      "series",
      "standings",
      "playoffs",
      "forfeits",
      "rosters",
      "match-night",
      "hosting",
      "signups",
      "draft",
      "results",
    ]);
    const titles = rules.sections.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const s of rules.sections) {
      expect(s.rules.length, s.id).toBeGreaterThan(0);
      for (const rule of s.rules) expect(rule.trim(), s.id).not.toBe("");
    }
    expect(rules.closing).toBe("Admins rule on anything not written here.");
    expect(RULES_CLOSING).toBe(rules.closing);
  });

  it("quotes the active season's settings", () => {
    const rules = build();
    expect(rules.defaults).toBe(false);
    expect(rules.basis).toBe("How GGD2L plays Season 9.");
    expect(section(rules, "series")).toContain(
      "Regular season: best of 2. Playoffs: best of 3. Grand final: best of 5.",
    );
    expect(section(rules, "series")).toContain("Bo2 = two separate lobbies.");
    expect(section(rules, "series")).toContain(
      "Bo3 = one lobby per game, first to 2 wins.",
    );
    expect(section(rules, "series")).toContain(
      "Bo5 = one lobby per game, first to 3 wins.",
    );
    // Read off computeStandings, whose points are literals.
    expect(section(rules, "standings")).toContain(
      "A series win is worth 3 points, a draw 1 and a loss 0.",
    );
    expect(section(rules, "standings")).toContain(
      "A regular-season series that ends level is a draw (a best of 2 that ends 1–1).",
    );
    expect(section(rules, "forfeits")).toContain(
      "each opponent wins 2–0 in a best of 2",
    );
    expect(section(rules, "rosters")).toContain(
      "Teams have 5 players, the captain included.",
    );
    expect(section(rules, "draft")).toContain(
      "buy their other 4 players in a live auction",
    );
    expect(section(rules, "draft")).toContain("Each captain has $100 to spend.");
    expect(section(rules, "draft")).toContain(
      "the lowest-rated captain gets up to 20% more and the highest up to 20% less, in full once the captains are 1,000 MMR apart",
    );
    expect(section(rules, "signups")).toContain(eligibilityText(4500));
    expect(section(rules, "signups")).toContain(
      "Signups are uncapped; the season's target is at least 4 teams.",
    );
    expect(section(rules, "results")).toContain(
      "at least 3 of each team's players",
    );
  });

  it("changes with the season's settings", () => {
    const rules = build({
      season: season({
        regularBestOf: 3,
        playoffBestOf: 5,
        finalBestOf: 7,
        teamSize: 2,
        minTeams: 6,
        draftBudget: 250,
        budgetMmrWeight: 0,
        maxMmr: 0,
      }),
    });
    expect(section(rules, "series")).toContain(
      "Regular season: best of 3. Playoffs: best of 5. Grand final: best of 7.",
    );
    expect(section(rules, "series")).toContain(
      "Bo7 = one lobby per game, first to 4 wins.",
    );
    expect(section(rules, "series")).not.toContain("Bo2");
    // An odd regular series only ends level by a ruling: no Bo-split example.
    expect(section(rules, "standings")).toContain(
      "A regular-season series that ends level is a draw.",
    );
    expect(section(rules, "forfeits")).toContain(
      "each opponent wins 2–0 in a best of 3",
    );
    expect(section(rules, "rosters")).toContain("Teams have 2 players");
    expect(section(rules, "draft")).toContain("buy their other 1 player in");
    expect(section(rules, "draft")).toContain("Each captain has $250 to spend.");
    expect(section(rules, "draft")).not.toContain("weighted");
    expect(section(rules, "signups")).toContain(eligibilityText(0));
    expect(section(rules, "signups")).not.toContain("looks over your signup");
    expect(section(rules, "signups")).toContain("at least 6 teams");
    // A two-a-side team needs both its players in the game.
    expect(section(rules, "results")).toContain(
      "at least 2 of each team's players",
    );

    const bo5 = build({ season: season({ regularBestOf: 5 }) });
    expect(section(bo5, "forfeits")).toContain(
      "each opponent wins 3–0 in a best of 5",
    );
  });

  it("quotes the first-season defaults, labelled as defaults, before any season", () => {
    const rules = build({ season: null, matchNight: null, teamCount: 6 });
    expect(rules.defaults).toBe(true);
    expect(rules.basis).toBe(
      "GGD2L hasn't started a season yet, so these are the settings a first season starts with. The admins can change them before it does.",
    );
    const first = carriedSeasonSettings(null);
    expect(section(rules, "series")).toContain(
      `Regular season: best of ${first.regularBestOf}. Playoffs: best of ${first.playoffBestOf}. Grand final: best of ${first.finalBestOf}.`,
    );
    expect(section(rules, "draft")).toContain(
      `Each captain has $${first.draftBudget} to spend.`,
    );
    expect(section(rules, "signups")).toContain(eligibilityText(first.maxMmr));
    // No season, so no field to size and no ticket to promise.
    expect(section(rules, "playoffs")).not.toContain("This season has");
    expect(section(rules, "hosting")).not.toContain("set League");
    expect(section(rules, "results")).toContain(resultsCopy(null).faq);
    expect(section(rules, "match-night")).toContain(
      "Match night is to be announced.",
    );
  });

  it("quotes the latest season between seasons, for the next one", () => {
    const rules = build({
      season: season({ isActive: false, status: SEASON_STATUS.COMPLETE }),
    });
    expect(rules.defaults).toBe(false);
    expect(rules.basis).toBe(
      "As GGD2L played Season 9. The next season starts with the same settings unless the admins change them.",
    );
    // The next season's ticket and field aren't known yet.
    expect(section(rules, "hosting")).not.toContain("set League");
    expect(section(rules, "results")).toContain(resultsCopy(null).faq);
    expect(section(rules, "playoffs")).not.toContain("This season has");

    const resting = build({ season: season({ status: SEASON_STATUS.COMPLETE }) });
    expect(resting.basis).toContain("The next season starts with the same settings");
  });

  it("names Europe and says its match night is to be announced", () => {
    const rules = build({ config: EU, matchNight: null });
    expect(rules.basis).toBe("How GGD2L Europe plays Season 9.");
    expect(section(rules, "match-night")).toContain(
      "Match night is to be announced. Kickoff times show in your own time zone.",
    );
    expect(section(rules, "hosting")).toContain(
      "Lobbies are Captains Mode on Europe West servers.",
    );
    expect(section(build(), "hosting")).toContain(
      "Lobbies are Captains Mode on US East servers.",
    );
  });

  it("names the announced match night", () => {
    expect(section(build(), "match-night")).toContain(
      "Match night: Sundays at 6:00 PM Pacific time. Kickoff times show in your own time zone.",
    );
  });

  it("follows the active season's league ticket", () => {
    const ticketed = build();
    expect(section(ticketed, "hosting")).toContain(
      "In every lobby, set League to the season's league id (the match page shows it), so each result imports by itself.",
    );
    expect(section(ticketed, "results")).toContain(resultsCopy(true).faq);
    // The id itself is the captains' business, on the match page.
    expect(everything(ticketed)).not.toContain("17119");

    const ticketless = build({ season: season({ dotaLeagueId: null }) });
    expect(section(ticketless, "hosting")).not.toContain("set League");
    expect(section(ticketless, "results")).toContain(resultsCopy(false).faq);
    expect(section(ticketless, "results")).toContain(NO_TICKET_RESULT_LEAD);
  });

  it("sizes the playoff field from the teams still in the season", () => {
    const steps =
      "2–3 teams send 2, 4–7 send 4, 8–15 send 8, 16–31 send 16";
    const six = section(build({ teamCount: 6 }), "playoffs");
    expect(six).toContain(steps);
    expect(six).toContain(
      "This season has 6 teams in it, so the top 4 make the playoffs.",
    );
    expect(six).toContain("Round one: 1 v 4, 2 v 3; the higher seed hosts.");

    expect(section(build({ teamCount: 8 }), "playoffs")).toContain(
      "Round one: 1 v 8, 2 v 7, 3 v 6, 4 v 5; the higher seed hosts.",
    );
    const three = section(build({ teamCount: 3 }), "playoffs");
    expect(three).toContain("so the top 2 make the playoffs");
    expect(three).toContain("The top two play the grand final, and seed 1 hosts.");

    for (const teamCount of [null, 0, 1]) {
      const unsized = section(build({ teamCount }), "playoffs");
      expect(unsized).not.toContain("This season has");
      expect(unsized).toContain(
        "Round one pairs the top seed with the lowest, the second with the second lowest, and so on; the higher seed hosts.",
      );
    }
  });

  it("writes durations and clocks in words", () => {
    const rules = build();
    expect(section(rules, "match-night")).toContain(
      "A proposed time can't be more than an hour in the past, more than 180 days ahead, or within 4 hours of either team's other league matches or booked scrims.",
    );
    expect(section(rules, "match-night")).toContain(
      `It stays open until ${AUTO_SYNC.WINDOW_HOURS} hours after kickoff.`,
    );
    expect(section(rules, "rosters")).toContain(
      "A standin can't be booked for two matches within 4 hours of each other.",
    );
    expect(section(rules, "rosters")).toContain(
      "Booking a standin 500 or more MMR above the player they cover shows a warning",
    );
    expect(section(rules, "results")).toContain(
      "it started between 3 days before and 6 days after the scheduled kickoff",
    );
    expect(section(rules, "draft")).toContain(
      `Bids are whole dollars from $${DEFAULTS.MIN_BID}. Each bid resets the clock to ${DEFAULTS.BID_TIMER_SECONDS} seconds, or ${DEFAULTS.UNCONTESTED_BID_TIMER_SECONDS} seconds when no other team can top it.`,
    );
    expect(section(rules, "draft")).toContain(
      `within ${DEFAULTS.NOMINATION_TIMER_SECONDS} seconds`,
    );
  });

  it("says where admins aren't held to the captains' limits", () => {
    const rules = build();
    // Captains' proposals are checked (reschedule-service.ts); an admin's
    // Set time is not, so the limits name the proposal.
    expect(section(rules, "match-night")).not.toContain("A new time can't");
    // A withdrawal rules a series under way too, over any game played
    // (withdrawTeam), unlike a forfeit an admin enters on one match.
    expect(section(rules, "forfeits")).toContain(
      "forfeits every series it hasn't finished, one under way included: each opponent wins 2–0 in a best of 2, whatever was already played.",
    );
    // withdrawGateError refuses a booked standin as well as a roster spot.
    expect(section(rules, "signups")).toContain(
      "unless you're on a roster or booked to stand in for a match not yet played",
    );
    // An admin's Add game skips the result window (no enforceFixtureWindow).
    expect(section(rules, "results")).toContain(
      "after the scheduled kickoff. Admins can add a game from outside that window.",
    );
  });

  it("keeps the league's copy rules", () => {
    for (const rules of [build(), build({ season: null }), build({ config: EU })]) {
      const text = everything(rules);
      // The soft MMR limit is a review threshold, never a block or a cap.
      expect(text).not.toContain("MMR are refused");
      expect(text).not.toContain("are reviewed before joining");
      expect(text).toContain("Signups are uncapped");
      expect(text).not.toMatch(/(?<!GG)LD2L/);
      expect(text).not.toMatch(/\bundefined\b|\bNaN\b|\[object/);
    }
  });
});

// Sentences that state what a function decides, not a number. Each is pinned
// to that function, so the page can't keep a claim the code has dropped.
describe("the rules page's claims hold in the code", () => {
  const done = { status: MATCH_STATUS.COMPLETED, phase: MATCH_PHASE.REGULAR };
  const game = (
    home: string,
    away: string,
    homeScore: number,
    awayScore: number,
  ): MatchLike => ({
    ...done,
    homeTeamId: home,
    awayTeamId: away,
    homeScore,
    awayScore,
    winnerTeamId:
      homeScore > awayScore ? home : awayScore > homeScore ? away : null,
  });
  const order = (teams: string[], matches: MatchLike[]) =>
    computeStandings(teams, matches)
      .map((row) => row.teamId)
      .filter((id) => id === "x" || id === "y");

  it("splits level teams on game difference, then series wins, then head-to-head", () => {
    // Points: 3 each. y won a series but has the worse game difference.
    expect(
      order(
        ["x", "y", "p", "q", "r", "s", "t"],
        [
          game("x", "p", 1, 1),
          game("x", "q", 1, 1),
          game("x", "r", 1, 1),
          game("y", "s", 1, 0),
          game("y", "t", 0, 2),
        ],
      ),
    ).toEqual(["x", "y"]);
    // Points 6 and game difference +1 each; x won the meeting, y has more wins.
    expect(
      order(
        ["x", "y", "p", "q", "r", "s", "t"],
        [
          game("x", "y", 1, 0),
          game("x", "p", 1, 1),
          game("x", "q", 1, 1),
          game("x", "r", 1, 1),
          game("y", "s", 1, 0),
          game("y", "t", 1, 0),
        ],
      ),
    ).toEqual(["y", "x"]);
    // Level on everything above; y won the meeting.
    expect(
      order(
        ["x", "y", "p", "q"],
        [game("y", "x", 1, 0), game("x", "p", 1, 0), game("q", "y", 1, 0)],
      ),
    ).toEqual(["y", "x"]);
  });

  it("counts only regular-season series toward the table", () => {
    const table = computeStandings(
      ["x", "y"],
      [{ ...game("x", "y", 2, 0), phase: MATCH_PHASE.PLAYOFF }],
    );
    expect(table.every((row) => row.points === 0 && row.played === 0)).toBe(true);
  });

  it("refuses a drawn tiebreaker or playoff series", () => {
    const action = stripLineComments(
      sourceFile("src/app/actions/admin-schedule-results.ts").text,
    );
    expect(action).toContain("A tiebreaker series cannot end in a draw");
    expect(action).toContain("A playoff series can't end in a draw");
  });

  it("keeps withdrawn teams' results but not the teams in the bracket", () => {
    const field = projectPlayoffField(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d", withdrawn: true }],
      [game("a", "d", 2, 0), game("b", "c", 2, 0)],
    );
    expect(field.seededTeamIds).not.toContain("d");
    expect(field.standings.find((row) => row.teamId === "a")?.points).toBe(3);
  });

  it("advances winners through a fixed bracket", () => {
    expect(nextRoundPairings(["w1", "w2", "w3", "w4"])).toEqual([
      { home: "w1", away: "w2" },
      { home: "w3", away: "w4" },
    ]);
  });

  it("opens check-ins with a kickoff, until the result window closes", () => {
    const kickoff = Date.UTC(2026, 9, 4, 1);
    const open = (status: string, nowMs: number) =>
      matchCheckinOpen(
        SEASON_STATUS.REGULAR_SEASON,
        DRAFT_STATUS.COMPLETE,
        status,
        new Date(kickoff),
        nowMs,
      );
    expect(open(MATCH_STATUS.SCHEDULED, kickoff + AUTO_SYNC.WINDOW_HOURS * HOUR_MS)).toBe(true);
    expect(open(MATCH_STATUS.SCHEDULED, kickoff + AUTO_SYNC.WINDOW_HOURS * HOUR_MS + 1)).toBe(false);
    expect(
      matchCheckinOpen(
        SEASON_STATUS.REGULAR_SEASON,
        DRAFT_STATUS.COMPLETE,
        MATCH_STATUS.SCHEDULED,
        null,
        kickoff,
      ),
    ).toBe(false);
  });

  it("lets only an unstarted series move, and books cover from the auction to the result", () => {
    const moves = (status: string) =>
      matchLogisticsOpen(SEASON_STATUS.REGULAR_SEASON, null, status);
    expect(moves(MATCH_STATUS.SCHEDULED)).toBe(true);
    expect(moves(MATCH_STATUS.LIVE)).toBe(false);
    expect(moves(MATCH_STATUS.COMPLETED)).toBe(false);

    expect(
      standinAssignmentOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS, MATCH_STATUS.SCHEDULED),
    ).toBe(false);
    expect(
      standinAssignmentOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE, MATCH_STATUS.LIVE),
    ).toBe(true);
    expect(
      standinAssignmentOpen(SEASON_STATUS.PLAYOFFS, null, MATCH_STATUS.COMPLETED),
    ).toBe(false);
    const service = stripLineComments(sourceFile("src/lib/standin-service.ts").text);
    expect(service).toContain(
      "Only that team's captain (or an admin) can assign this standin",
    );
    expect(service).toContain("Games are already imported");
  });

  it("takes player signups only during signups, and standins until the playoffs end", () => {
    const gate = (status: string, type: typeof REGISTRATION_TYPE.PLAYER | typeof REGISTRATION_TYPE.STANDIN) =>
      registrationGate({
        season: { maxMmr: 4500, status },
        type,
        mmr: 3000,
        hasExisting: false,
      });
    expect(gate(SEASON_STATUS.SIGNUPS, REGISTRATION_TYPE.PLAYER)).toBeNull();
    expect(gate(SEASON_STATUS.REGULAR_SEASON, REGISTRATION_TYPE.PLAYER)).toBe(
      "Player signups are closed for this season",
    );
    expect(gate(SEASON_STATUS.PLAYOFFS, REGISTRATION_TYPE.STANDIN)).toBeNull();
    // Above the soft limit is never a refusal.
    expect(
      registrationGate({
        season: { maxMmr: 4500, status: SEASON_STATUS.SIGNUPS },
        type: REGISTRATION_TYPE.PLAYER,
        mmr: 4900,
        hasExisting: false,
      }),
    ).toBeNull();
    expect(
      standinSignupOpen({ phase: SEASON_STATUS.PLAYOFFS, registrationStatus: null }),
    ).toBe(true);
    expect(
      standinSignupOpen({ phase: SEASON_STATUS.COMPLETE, registrationStatus: null }),
    ).toBe(false);
  });

  it("runs the auction the way the draft section says", () => {
    const team = { id: "t", budget: 100, rosterCount: 1 };
    // Whole dollars from the minimum, and room left for every open seat.
    expect(canBid(team, 5, DEFAULTS.MIN_BID, 0)).toBe(true);
    expect(canBid(team, 5, 1.5, 0)).toBe(false);
    expect(maxBid(team, 5)).toBe(100 - 3 * DEFAULTS.MIN_BID);
    // A rotation that skips full and broke teams.
    const teams = [
      { id: "a", budget: 50, rosterCount: 2 },
      { id: "full", budget: 50, rosterCount: 5 },
      { id: "broke", budget: 0, rosterCount: 2 },
      { id: "d", budget: 50, rosterCount: 2 },
    ];
    expect(nextNominatorIndex(teams, 5, 0)).toBe(3);
    expect(nextNominatorIndex(teams, 5, 3)).toBe(0);
    // A stalled clock nominates the top-MMR player left at the minimum bid;
    // a dry pool ends the auction.
    const service = stripLineComments(sourceFile("src/lib/draft-service.ts").text);
    const stalled = service.slice(
      service.indexOf("export async function resolveStalledNomination("),
    );
    expect(stalled).toContain('orderBy: { mmr: "desc" }');
    expect(stalled).toContain("const amount = DEFAULTS.MIN_BID;");
    expect(stalled).toContain('type: "PLAYER"');
  });
});

/**
 * Every string a file shows: string literals, template literal text and JSX
 * text, leaving out class names and import paths. Numeric literals are listed
 * with the JSX attribute they sit in, if any.
 */
function shownText(file: SourceFile): {
  texts: string[];
  numbers: { text: string; attribute: string | null }[];
  imports: string[];
} {
  const source = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const texts: string[] = [];
  const numbers: { text: string; attribute: string | null }[] = [];
  const imports: string[] = [];
  const attributeOf = (node: ts.Node): string | null => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isJsxAttribute(parent)) return parent.name.getText(source);
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      imports.push((node.moduleSpecifier as ts.StringLiteral).text);
      return;
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (attributeOf(node) !== "className") texts.push(node.text);
    } else if (ts.isJsxText(node)) {
      texts.push(node.text);
    } else if (ts.isNumericLiteral(node)) {
      numbers.push({ text: node.text, attribute: attributeOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { texts, numbers, imports };
}

// The page renders leagueRules and nothing else that could hold a rule: no
// digit in anything it shows, no number but a heading level, and no import
// that carries a rule constant.
describe("the /rules page", () => {
  const files = sourceFiles("src/app/rules/**/*.tsx", 1);
  const page = files.find((f) => f.path === "src/app/rules/page.tsx");

  it("builds every section from leagueRules", () => {
    expect(page).toBeDefined();
    const text = stripLineComments(page!.text);
    expect(text.match(/\bleagueRules\(/g)).toHaveLength(1);
    expect(text).toContain("rules.sections.map(");
    expect(text).toContain("section.rules.map(");
    expect(text).toContain("{rules.closing}");
    expect(text).toContain("export const dynamic = \"force-dynamic\"");
    // One h1 (PageTitle) and an h2 per section.
    expect(text.match(/<PageTitle\b/g)).toHaveLength(1);
    expect(text).toContain("headingLevel={2}");
  });

  it("is linked from How it works and from every How to host line", () => {
    const howItWorks = sourceFiles("src/app/how-it-works/**/*.tsx", 1);
    expect(howItWorks.some((f) => f.text.includes('href="/rules"'))).toBe(true);
    // Both places the match page prints the host line: on its own for a
    // ticketless season, and atop the official lobby checklist.
    const hostLines = sourceFiles(["src/app/**/*.tsx", "src/components/**/*.tsx"], 80)
      .filter((f) => f.text.includes("How to host:</b>"));
    expect(hostLines.length).toBeGreaterThanOrEqual(2);
    for (const file of hostLines) {
      const line = file.text.slice(file.text.indexOf("How to host:</b>"));
      expect(line.slice(0, line.indexOf("</p>")), file.path).toContain(
        'href="/rules#hosting"',
      );
    }
  });

  it("holds no rule numbers of its own", () => {
    const allowedImports = new Set([
      "@/lib/prisma",
      "@/lib/season",
      "@/lib/season-scope",
      "@/lib/match-night",
      "@/lib/league-rules",
      "@/lib/share-metadata",
      "@/components/ui",
    ]);
    for (const file of files) {
      const { texts, numbers, imports } = shownText(file);
      expect(texts.length, file.path).toBeGreaterThan(5);
      for (const text of texts) {
        expect(text, `${file.path} shows a number`).not.toMatch(/\d/);
      }
      for (const number of numbers) {
        expect(number.attribute, `${file.path}: ${number.text}`).toBe(
          "headingLevel",
        );
      }
      for (const specifier of imports) {
        expect(allowedImports.has(specifier), `${file.path} imports ${specifier}`).toBe(true);
      }
    }
  });
});
