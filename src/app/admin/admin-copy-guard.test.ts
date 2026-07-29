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

  // maxMmr is a REVIEW threshold, not a block (registration.ts says so in two
  // places). Copy has been wrong in both directions here.
  it("does not claim the soft MMR limit refuses signups", () => {
    const registration = read("src/lib/registration.ts");
    expect(registration).toContain("review threshold, not a block");
    expect(haystack).not.toContain("MMR are refused");
    expect(haystack).not.toContain("are reviewed before joining");
  });
});
