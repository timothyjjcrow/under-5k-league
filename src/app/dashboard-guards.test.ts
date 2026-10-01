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
 * The viewer's "Your team" card prints the Win/Draw/Loss block for their next
 * series. When that series is on the This-week slate, the slate's own team
 * row already prints the identical block, so the card must stand down; and
 * the card is far shorter than the standings, so it must not sit beside the
 * table (that left a hole under it at desktop widths).
 */
describe("dashboard Your team card", () => {
  const page = stripLineComments(homePageSource());
  const card = page.slice(page.indexOf("const myStakeCard ="));

  it("stands down when This week already shows its series", () => {
    expect(page).toMatch(/myStakesOnSlate\s*=\s*\n?\s*!!myScenario\?\.nextMatchId && slateIds\.has\(myScenario\.nextMatchId\)/);
    expect(card.slice(0, card.indexOf("?"))).toContain("!myStakesOnSlate");
  });

  it("joins the auto-fit band instead of sitting beside the standings", () => {
    expect(page).not.toMatch(/myStakeCard \? "lg:col-span-2"/);
    const band = page.slice(page.indexOf("{myPlayoffCard || myStakeCard"));
    expect(band.slice(0, 400)).toContain("repeat(auto-fit,");
    expect(band.slice(0, 600)).toContain("{myStakeCard ?");
  });
});
