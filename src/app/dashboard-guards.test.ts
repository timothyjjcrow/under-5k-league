import { describe, it, expect } from "vitest";
import {
  homePageSource,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

// EVERY .tsx in the app — the guard's whole lesson is that the surface nobody
// remembered is the one that regresses (/me and the draft waiting room shipped
// without passedLabel while the guard only read page.tsx, and a later fixed
// list would have missed any countdown moved into a new component file).
const FILES = sourceFiles("src/**/*.tsx", 80);

/**
 * A `<Countdown>` on a SCHEDULED DATE THE PAGE ALSO PRINTS must say when that
 * date has gone by.
 *
 * `countdownLabel` returns null 3h past its target, so without `passedLabel`
 * the chip simply vanishes — and the dashboard was left rendering
 * "🗓️ Draft night: Sun, Jul 26" as an upcoming plan under a "Ready to draft"
 * badge, three days after the fact. The season does not advance its own phase,
 * so a draft that slips by a day parks the front page in that state for
 * everyone deciding whether this league is alive.
 *
 * This is a SOURCE guard because the failure is a missing prop, and the way it
 * happened is instructive: the fix landed on two surfaces and a THIRD, added in
 * the same change, was written without it. A test that renders one component
 * cannot see the one nobody remembered.
 */
describe("dashboard draft-night countdowns", () => {
  /** Every `<Countdown …/>` prop list in the app, with the file it is in. */
  const countdowns = FILES.flatMap((f) =>
    f.text
      .split("<Countdown")
      .slice(1)
      .map((c) => ({ file: f.path, props: c.slice(0, c.indexOf("/>")) })),
  );
  const draftNight = countdowns.filter((c) => c.props.includes("draftAt"));

  it("finds the countdowns it is supposed to be guarding", () => {
    // If the element is ever renamed or the props move to a wrapper, this test
    // would pass by finding nothing at all — which is how a guard rots into
    // decoration. Six draft-night countdowns exist today (on the dashboard:
    // the hero's draft chip, the hero panel's draft-night confirmation and
    // the captain line in the Draft phase; one on /me, one in the draft
    // waiting room, one on a team page before its fixtures exist); lower
    // this only when one is deliberately removed.
    expect(countdowns.length).toBeGreaterThan(0);
    expect(
      draftNight.length,
      `found ${draftNight.length} draft-night <Countdown>s in ${[
        ...new Set(draftNight.map((c) => c.file)),
      ].join(", ")}`,
    ).toBeGreaterThanOrEqual(6);
  });

  it("carries passedLabel wherever it counts down to a draft night", () => {
    const missing = draftNight
      .filter((c) => !c.props.includes("passedLabel"))
      .map((c) => c.file);
    expect(missing).toEqual([]);
  });
});

/**
 * The same rule for the next season's signup date on the Season complete
 * hero: phases never advance themselves, so a date an admin set and then
 * missed would otherwise stand on Home as a plan, or vanish with no word.
 */
describe("the next season's countdown", () => {
  const nextSeason = FILES.flatMap((f) =>
    f.text
      .split("<Countdown")
      .slice(1)
      .map((c) => c.slice(0, c.indexOf("/>")))
      .filter((props) => props.includes("signupsAtMs")),
  );

  it("says the date has passed", () => {
    expect(nextSeason.length).toBeGreaterThanOrEqual(1);
    for (const props of nextSeason) {
      expect(props).toContain("passedLabel={NEXT_SEASON_PASSED_LABEL}");
    }
  });
});

/**
 * Where the viewer's team stands is said ONCE on Home, in the hero: its place
 * and record in words, then the Win/Draw/Loss paths of its next series
 * (`MyStanding`, under the next-match panel). This week's rows carry one
 * stake line per side, and the regular season has no "Your team" card: that
 * card showed only on a bye week, and printed the same block the slate did
 * on every other. The rules are pure and unit-tested (home-slate.test.ts,
 * playoff-outlook.test.ts); this pins the page to them.
 */
describe("dashboard: where the viewer stands", () => {
  const page = stripLineComments(homePageSource());
  const hero = page.slice(
    page.indexOf("export function seasonHero("),
    page.indexOf("export function SeasonViewSkeleton("),
  );

  it("reads the place, the record and the race from the tested rules", () => {
    expect(hero.length).toBeGreaterThan(0);
    expect(hero).toContain("tablePlace(myTable, myTeam.id)");
    expect(hero).toContain("standingSummary({");
    expect(hero).toContain("playoffRace(report, field.bracketSize)");
    expect(hero).toMatch(/<MyStanding\s/);
    // The stakes wait for the first final series, as the slate's do.
    expect(hero).toMatch(
      /playoffOutlookShown\(matches\)\s*\?\s*report\?\.teams\.get\(myTeam\.id\)/,
    );
  });

  it("prints the viewer's Win/Draw/Loss paths in the hero and nowhere else", () => {
    // One call on Home, inside MyStanding.
    expect(page.match(/playoffPathLines\(/g)).toHaveLength(1);
    const standing = page.slice(page.indexOf("function MyStanding("));
    expect(standing.slice(0, standing.indexOf("\nexport ")))
      .toContain("playoffPathLines(scenario, scenario.nextMatchId ?? undefined)");
    // The rail keeps a team card for the playoffs only.
    expect(page).not.toContain("myStakeCard");
    expect(page.match(/title="Your team"/g)).toHaveLength(1);
    expect(page).toContain("function PlayoffTeamCard(");
  });

  it("gives a full slate one stake line a side, the viewer's series first", () => {
    expect(page).toContain("viewerTeamId={myTeam?.id}");
    expect(page).toContain("const focus = orderSlate(slate, viewerTeamId);");
    expect(page).toContain("const kickoff = sharedKickoff(focus);");
    const rows = page.slice(
      page.indexOf("if (focus.length > 1) {"),
      page.indexOf("const m = focus[0];"),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toContain("slateStakeLine(");
    // The full outlook block is the lone-series card's, never a row's.
    expect(rows).not.toContain("<PlayoffOutlook");
    expect(rows).toContain('layout="inline"');
  });
});

/**
 * While a match-night poll is open during signups, every "Match night" line a
 * player reads before the draft says the poll is deciding it. Home printed
 * "Match night: Saturday 2PM PST" right above a poll asking when match night
 * should be, with Sunday leading, and once Home and /me followed the poll,
 * /rules, How it works and Schedule kept printing the old night. The rule is
 * pollDecidesMatchNight (match-night.test.ts) and the pitch's wording is
 * unit-tested in season-copy.test.ts; this pins every surface to them.
 */
describe("match-night lines while a poll is open", () => {
  const home = stripLineComments(homePageSource());
  const page = (path: string) =>
    stripLineComments(
      sourceFiles(path, 1).map((file) => file.text).join("\n"),
    );
  const me = page("src/app/me/page.tsx");
  const rules = page("src/app/rules/page.tsx");
  const howItWorks = page("src/app/how-it-works/page.tsx");
  const schedule = page("src/app/schedule/page.tsx");
  const surfaces = { home, me, rules, howItWorks, schedule };

  it("asks the one rule whether a poll is deciding the night, on every page that names it", () => {
    for (const [name, source] of Object.entries(surfaces)) {
      expect(source, name).toContain("pollDecidesMatchNight(");
      // The poll is read only where the rule says one could decide the
      // night, never behind a phase test of the page's own: a hardcoded
      // SIGNUPS would hide any change to the rule.
      expect(source, name).toMatch(
        /pollCanDecideMatchNight\(\w+\)\s*\?\s*(await\s+)?matchNightPollOpen\(\)/,
      );
      expect(source, name).not.toMatch(
        /SIGNUPS["']?\s*(\?|&&)\s*\(?\s*(await\s+)?matchNightPollOpen\(\)/,
      );
    }
  });

  it("passes the answer to the pitch and every callout", () => {
    expect(home).toMatch(
      /<LeaguePitch[\s\S]{0,120}pollOpen=\{pollDecidesNight\}/,
    );
    expect(home).toContain("matchNightPollOpen={pollDecidesNight}");
    expect(home).toContain("label={MATCH_NIGHT_POLL_LABEL}");
    for (const [name, source] of Object.entries({ me, schedule })) {
      expect(source, name).toMatch(/pollDecidesNight\s*\?\s*MATCH_NIGHT_POLL_LABEL/);
      expect(source, name).toMatch(/pollDecidesNight\s*\?\s*\(\s*<MatchNightPollNote \/>/);
    }
    expect(howItWorks).toContain("? `Match night: ${MATCH_NIGHT_POLL_LABEL}`");
    expect(howItWorks).toContain("<MatchNightPollNote />");
    expect(rules).toContain(
      "matchNightPoll: pollDecidesMatchNight(active, fixtures, pollOpen)",
    );
  });
});
