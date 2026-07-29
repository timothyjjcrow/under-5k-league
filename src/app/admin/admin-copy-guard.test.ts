import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Copy on /admin must not name a control that doesn't exist.
 *
 * The 2026-07-28 audit found this exact class FOUR times, and it is the most
 * expensive kind of wrong copy here because it appears in recovery
 * instructions: "use Detect games to add it back" (the button is
 * "Auto-fetch games"), "paste these into Add game by match ID" (it is a
 * placeholder reading "Match ID or URL" beside a button reading "Add game"),
 * two webhook fields pointing at a "Remove" that only exists on a third one,
 * and a next-step banner naming "Start next season" for a section called
 * "Create a new season". An admin following one of those is hunting for a
 * button that was never there, in the middle of fixing something.
 *
 * A parse test is the only thing that can catch it: tsc is happy, every unit
 * test passes, and a browser spec only reaches the strings currently on screen.
 */
const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SOURCES = [
  "src/app/admin/page.tsx",
  "src/app/actions/admin.ts",
  "src/app/actions/inhouse-bets.ts",
  "src/lib/admin-next-step.ts",
  "src/components/match-import-controls.tsx",
];

/** Every source that can render or describe an admin control, concatenated. */
const haystack = SOURCES.map(read).join("\n");

/**
 * Control names that admin copy is allowed to reference, each with the file
 * that actually renders it. If you rename a control, this list is what fails.
 */
const REFERENCED_CONTROLS: Array<{ quoted: string; rendered: string }> = [
  { quoted: "Auto-fetch games", rendered: "Auto-fetch games" },
  { quoted: "Add game", rendered: "Add game" },
  { quoted: "Match ID or URL", rendered: "Match ID or URL" },
  { quoted: "Create a new season", rendered: "Create a new season" },
  { quoted: "Remove webhook", rendered: "Remove webhook" },
  { quoted: "Use the league channel instead", rendered: "Use the league channel instead" },
  {
    quoted: "Send alerts to the board channel instead",
    rendered: "Send alerts to the board channel instead",
  },
  { quoted: "Abort draft", rendered: "Abort draft" },
  { quoted: "Start draft", rendered: "Start draft" },
  { quoted: "Start playoffs", rendered: "Start playoffs" },
  { quoted: "Reset playoffs", rendered: "Reset playoffs" },
  { quoted: "Move a match night", rendered: "Move a match night" },
  // The below-zero banner tells an admin to repair the balance with this one.
  { quoted: "Adjust Cred", rendered: "Adjust Cred" },
  // The betting card points at this section for who made a correction.
  { quoted: "Recent admin activity", rendered: "Recent admin activity" },
];

describe("admin copy names only controls that exist", () => {
  it.each(REFERENCED_CONTROLS)(
    "$quoted is rendered somewhere",
    ({ rendered }) => {
      expect(
        haystack.includes(rendered),
        `Admin copy references “${rendered}”, but no admin source renders that string. Either the control was renamed and the copy is now lying, or the copy invented a name.`,
      ).toBe(true);
    },
  );

  // The four literals that were actually wrong. Named individually so a
  // regression says which one came back rather than "some string matched".
  const BANNED = [
    {
      text: "Detect games",
      why: 'the control is called "Auto-fetch games"',
    },
    {
      text: "Add game by match ID",
      why: 'the control is a "Match ID or URL" box beside an "Add game" button',
    },
    {
      text: "Start next season",
      why: 'the section is called "Create a new season"',
    },
    {
      text: "or use Remove.",
      why: 'only the league webhook has a "Remove webhook" button; the inhouse ones clear via differently-labelled buttons',
    },
  ];

  it.each(BANNED)("does not say “$text” ($why)", ({ text }) => {
    expect(haystack).not.toContain(text);
  });

  // The other repeat offender: copy that asserts something the code contradicts.
  it("never claims starting the draft is irreversible — abortDraft undoes it", () => {
    const draftService = read("src/lib/draft-service.ts");
    expect(
      draftService.includes("NOT_STARTED"),
      "abortDraft should still return a draft to NOT_STARTED",
    ).toBe(true);
    // Scoped to the DRAFT claim on purpose: "This can't be undone" is true of
    // deleting a news post, and a blanket ban would just train people to
    // reword it. These three are the exact strings that were wrong.
    for (const claim of [
      "This can't be undone — captains are locked",
      "ONE-WAY DOOR",
      "create a new season to redraft",
    ]) {
      expect(haystack).not.toContain(claim);
    }
  });

  // The betting card's headline figure is "the profit board sums to 0", and it
  // is only zero-sum while the profit reasons exclude the three things the
  // SYSTEM hands out. Add GRANT, FLOOR or ADJUST to that list and the alarm
  // fires forever on a perfectly healthy league — the cry-wolf failure that
  // gets a health surface ignored, on the number the card calls its most
  // valuable one.
  it("only calls betting zero-sum while the profit reasons stay zero-sum", () => {
    const constants = read("src/lib/constants.ts");
    const decl = constants.indexOf("INHOUSE_CRED_PROFIT_REASONS");
    // Bounded from the `[` AFTER the `=`, not the first `[` in the line: the
    // type annotation is `InhouseCredReason[]`, whose own brackets would end
    // the slice before it started.
    const open = constants.indexOf("[", constants.indexOf("=", decl));
    const list = constants.slice(open, constants.indexOf("]", open));
    expect(list).toContain("STAKE");
    for (const handout of ["GRANT", "FLOOR", "ADJUST"]) {
      expect(
        list,
        `${handout} is Cred the system hands out, not Cred taken off another player. In the profit board it makes /admin's zero-sum check non-zero on a healthy league.`,
      ).not.toContain(handout);
    }
  });

  // The below-zero banner tells the admin that a negative balance can ONLY come
  // from a void clawing back re-staked winnings, and that a positive adjustment
  // always lands. Both halves are claims about the bet service; if either stops
  // being true the banner sends an admin hunting for a void that never happened.
  it("does not claim a player can never spend past zero unless the debit says so", () => {
    const betService = read("src/lib/inhouse-bet-service.ts");
    expect(
      betService.includes("balance: { gte: stake }"),
      "placeInhouseBet's overdraft guard is what makes 'nothing lets a player spend past zero' true",
    ).toBe(true);
    // Asserted as the PRESENCE of the debit-only ternary, not the absence of
    // the `gte: Math.max(0, -delta)` it replaced: that expression is quoted in
    // adjustCred's own comment as the bug it fixed, so a ban on the string
    // fails against correct code. What has to hold is that a CREDIT carries no
    // balance predicate at all — on a negative balance any floor at all refuses
    // the one operation that repairs it.
    expect(
      betService.includes(
        "where: delta < 0 ? { userId, balance: { gte: -delta } } : { userId }",
      ),
      "adjustCred must apply its no-overdraw floor to debits only, or the below-zero banner points at a form that refuses the repair",
    ).toBe(true);
  });

  // maxMmr is a REVIEW threshold, not a block (registration.ts says so in two
  // places). Copy has been wrong in both directions here.
  it("does not claim the soft MMR limit refuses signups", () => {
    const registration = read("src/lib/registration.ts");
    expect(registration).toContain("review threshold, not a block");
    expect(haystack).not.toContain("MMR are refused");
    expect(haystack).not.toContain("are reviewed before joining");
  });
});
