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
 * "Season handoff". An admin following one of those is hunting for a
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
  "src/lib/captain-mmr.ts",
  "src/components/match-import-controls.tsx",
  "src/components/admin-player-rank-editor.tsx",
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
  { quoted: "Season handoff", rendered: "Season handoff" },
  { quoted: "Remove webhook", rendered: "Remove webhook" },
  { quoted: "Use the league channel instead", rendered: "Use the league channel instead" },
  {
    quoted: "Send alerts to the board channel instead",
    rendered: "Send alerts to the board channel instead",
  },
  { quoted: "Abort draft", rendered: "Abort draft" },
  { quoted: "Start draft", rendered: "Start draft" },
  // The pre-draft next-step points at the funnel that names the unlinked.
  { quoted: "Discord notifications", rendered: "Discord notifications" },
  { quoted: "Start playoffs", rendered: "Start playoffs" },
  { quoted: "Reset playoffs", rendered: "Reset playoffs" },
  { quoted: "Move a match night", rendered: "Move a match night" },
  // withdrawTeam's toast points released standin-pool candidates here.
  { quoted: "Roster moves", rendered: "Roster moves" },
  // releasePlayer's quitter note points at the signup remove control's card.
  { quoted: "Captains & draft", rendered: "Captains & draft" },
  // The unverified-captain-MMR confirm and next-step note send the admin to
  // this disclosure. The rendered form is the JSX entity, which the quoting
  // copy (a plain "&") can never satisfy on its own.
  { quoted: "Edit medal & MMR", rendered: "Edit medal &amp; MMR" },
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
      why: 'the section is called "Season handoff"',
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

  // The REFERENCED_CONTROLS check is haystack-wide, and admin-next-step.ts —
  // which QUOTES "the Discord notifications card" — is part of the haystack,
  // so that entry satisfies itself: renaming the card leaves the quoting copy
  // matching its own words (verified by mutation). Pin the RENDER site
  // directly instead.
  it("the card the pre-draft chase note points at is actually titled that", () => {
    const page = read("src/app/admin/page.tsx");
    expect(
      page.includes('title="Discord notifications"'),
      'admin-next-step copy points at "the Discord notifications card" — if the AdminSection was renamed, update the note (and this test), or the admin hunts for a card that is not there',
    ).toBe(true);
  });

  // The house rule the Start-draft confirm upgrade exists for: state the real
  // reachability numbers BEFORE the click. discordReachWarning is unit-tested,
  // but nothing behavioural reaches a native confirm dialog — deleting the
  // append would fail no test while silently reverting the feature.
  it("the Start-draft confirm actually carries the Discord reachability line", () => {
    const page = read("src/app/admin/page.tsx");
    expect(
      page.includes("confirmBase + discordReachWarning(reach)"),
      "StartDraftControl must append discordReachWarning to the confirm — the warning copy is tested, this is the line that makes it reach the admin",
    ).toBe(true);
  });

  // Same shape for the unverified-captain-MMR line, which is DB-only and so is
  // appended to the BASE confirm (both the Suspense fallback and the upgraded
  // button carry it). captainMmrWarning is unit-tested; these pin that it, the
  // per-captain flag and the next-step input actually reach the admin.
  it("the Start-draft confirm, captain rows and next-step banner carry the unverified-MMR check", () => {
    const page = read("src/app/admin/page.tsx");
    expect(
      page.includes("captainMmrWarning(unverifiedMmr)"),
      "startConfirm must append captainMmrWarning, or the confirm stops naming unverified captains",
    ).toBe(true);
    expect(
      page.includes("unverifiedMmrByTeam.get(t.id)!.reason"),
      "each captain row must render its unverified-MMR reason",
    ).toBe(true);
    expect(
      page.includes("unverifiedCaptainMmrNames: unverifiedCaptainMmrsFor("),
      "adminNextStep must receive the unverified captain names",
    ).toBe(true);
  });

  // The fix the copy prescribes is saving a matching medal in this editor.
  // Pin that the editor still offers a manual medal and still renders on the
  // captain rows, or the copy points at a control that cannot clear the flag.
  it("the Edit medal & MMR editor can still set a manual medal on captain rows", () => {
    const editor = read("src/components/admin-player-rank-editor.tsx");
    expect(editor).toContain('<option value="manual">Manual correction</option>');
    const page = read("src/app/admin/page.tsx");
    expect(page).toContain("registrationId={captainReg.get(t.captainId)!.id}");
  });
});
