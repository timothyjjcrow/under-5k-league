import { describe, it, expect } from "vitest";
import {
  filesContaining,
  haystackOf,
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

/**
 * The unrecoverable actions must stay behind TYPE-TO-CONFIRM.
 *
 * Every other barrier on the site is `window.confirm`, whose OK button is
 * focused by default — one Enter away, and visually identical whether it guards
 * "Rename team" or a hard cascade delete of an entire season. Five actions have
 * no in-app undo at all, and for those the barrier has to be something a reflex
 * cannot satisfy.
 *
 * This is a source guard because the mechanism is invisible to every other kind
 * of test: tsc is happy if someone swaps DangerSubmit back to SubmitButton, the
 * unit suite never renders these pages, and a browser spec only reaches the
 * controls that happen to be on screen in that fixture's phase.
 */

/**
 * Every page and component. Globbed, not listed: an unrecoverable form moved
 * into a new card component must still be found, and so must a new
 * DangerSubmit call site whose token is a magic word.
 */
const UI = sourceFiles(["src/app/**/*.tsx", "src/components/**/*.tsx"], 80);
/** Every page under /admin, joined (so the admin page can be split). */
const admin = haystackOf(UI.filter((f) => f.path.startsWith("src/app/admin/")));
const seasons = sourceFile("src/app/seasons/page.tsx").text;
const danger = sourceFile("src/components/danger-submit.tsx").text;

/** Every `<DangerSubmit …>` call site and the token prop it passes. */
const CALL_SITES = UI.flatMap((f) =>
  stripLineComments(f.text)
    .split(/<DangerSubmit\s/)
    .slice(1)
    .map((after) => ({
      file: f.path,
      token:
        /\btoken=(\{[^}]*\}|"[^"]*"|'[^']*')/.exec(after.slice(0, 600))?.[1] ??
        null,
    })),
);

/** The unrecoverable actions; each form rendering one must use DangerSubmit. */
const UNRECOVERABLE: Array<{ action: string; why: string }> = [
  {
    action: "deleteSeason",
    why: "hard cascade delete of a whole season; no undo, no export",
  },
  {
    action: "abortDraftAction",
    why: "dissolves an auction result nothing records",
  },
  {
    action: "startPlayoffs",
    why: "reset deletes the postseason; RSVPs/picks/bookings are not archived",
  },
  {
    action: "generateSchedule",
    why: "regenerate cascades away every check-in, pick and standin booking",
  },
  {
    action: "deleteMatchNightPoll",
    why: "deletes a poll and every ballot in it; nothing keeps a copy",
  },
  {
    action: "removeCaptain",
    why: "once fixtures exist, deletes every fixture in the season, not just that team's",
  },
];

describe("unrecoverable admin actions require typed confirmation", () => {
  it.each(UNRECOVERABLE)("$action is guarded ($why)", ({ action }) => {
    // The form exists somewhere…
    const forms = filesContaining(UI, `action={${action}}`);
    expect(
      forms.length,
      `no page or component renders action={${action}} any more`,
    ).toBeGreaterThan(0);
    // …and every file rendering it also renders a DangerSubmit. (A per-file
    // check is the honest granularity — a per-form parse would need a real
    // JSX parser to be trustworthy.)
    for (const form of forms) {
      expect(
        form.text.includes("<DangerSubmit"),
        `${action} is rendered in ${form.path}, which renders no DangerSubmit`,
      ).toBe(true);
    }
  });

  it("every DangerSubmit call site names a real token, not a magic word", () => {
    // At least one call site per unrecoverable action, in at least two files
    // (/admin and /seasons), or the parse below is checking nothing.
    expect(CALL_SITES.length).toBeGreaterThanOrEqual(UNRECOVERABLE.length);
    expect(new Set(CALL_SITES.map((c) => c.file)).size).toBeGreaterThanOrEqual(
      2,
    );
    // "type DELETE" trains the reflex it exists to break; the token has to be
    // something specific to the thing being destroyed: its name (a poll's
    // name is its question).
    for (const file of UI) {
      expect(file.text, file.path).not.toMatch(/token=\{?["']DELETE["']\}?/i);
      expect(file.text, file.path).not.toMatch(/token=\{?["']CONFIRM["']\}?/i);
    }
    for (const site of CALL_SITES) {
      expect(site.token, `a DangerSubmit in ${site.file}`).not.toMatch(
        /^\{?["']?(DELETE|CONFIRM)["']?\}?$/i,
      );
      expect(
        site.token,
        `a DangerSubmit in ${site.file} must pass a real name as its token`,
      ).toMatch(/^\{[\w.]+\.(?:name|question)\}$/);
    }
    // Both files pass a real name through.
    expect(admin).toMatch(/token=\{(season\.name|t\.name)\}/);
    expect(seasons).toMatch(/token=\{s\.name\}/);
  });
});

describe("the DangerSubmit mechanism itself", () => {
  it("has exactly one submit button, and it is disabled until armed", () => {
    // A second submit path would bypass the whole thing.
    const submits = danger.match(/type="submit"/g) ?? [];
    expect(submits).toHaveLength(1);
    expect(danger).toContain("disabled={!armed || pending}");
  });

  it("matches the token exactly rather than loosely", () => {
    // A fuzzy/lowercased match would let a half-read team name through.
    expect(danger).toContain("typed.trim() === token.trim()");
    expect(danger).not.toMatch(/toLowerCase\(\)|includes\(token/);
  });

  it("submits the typed token so destructive actions can verify it server-side", () => {
    expect(danger).toContain('name="confirmationName"');
  });

  it("can require server-verified operator evidence before arming", () => {
    expect(danger).toContain("(!evidence || evidenceValue.trim().length > 0)");
    expect(danger).toContain("name={evidence.name}");
    expect(seasons).toContain('name: "backupReceipt"');
    expect(seasons).toMatch(/cannot restore the database/i);
  });

  it("stops phones capitalising or autocorrecting the typed token", () => {
    // The match is exact, so "under 5K league" auto-capitalised to "Under 5K
    // league" (or a name autocorrected to a dictionary word) fails silently.
    const input = danger.slice(danger.indexOf('name="confirmationName"'));
    expect(input.slice(0, 800)).toContain('autoCapitalize="off"');
    expect(input.slice(0, 800)).toContain('autoCorrect="off"');
  });

  it("refuses to let Enter complete the action from the token field", () => {
    expect(danger).toContain('if (e.key === "Enter") e.preventDefault()');
  });

  it("clears the typed token whenever the dialog opens or closes", () => {
    // Otherwise a previously-typed token lingers and the next open is armed
    // from the first frame — exactly the one-keypress hazard this replaces.
    const clears = danger.match(/setTyped\(""\)/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(3); // open, cancel, escape
  });

  it("does not unmount its submit button during the click event", () => {
    // Removing the button in onClick cancels Chrome's default form submission
    // before ActionForm can dispatch the server action. The dialog closes only
    // after requestSubmit synchronously delivers the form's submit event.
    expect(danger).not.toContain("onClick={() => setOpen(false)}");
    expect(danger).toContain("form.requestSubmit(e.currentTarget)");
  });

  it("uses a real opaque surface token and describes the consequences", () => {
    // `surface-1` has never existed in the Tailwind theme, so the old class
    // emitted no background rule and left this destructive dialog transparent.
    expect(danger).toContain("bg-surface p-5");
    expect(danger).not.toContain("bg-surface-1");
    expect(danger).toContain("aria-describedby={`${inputId}-description`}");
    expect(danger).toContain("id={`${inputId}-description`}");
  });

  it("traps focus inside the modal and restores it to the trigger", () => {
    expect(danger).toContain("dialog.querySelectorAll<HTMLElement>");
    expect(danger).toContain('if (e.key !== "Tab") return;');
    expect(danger).toContain("triggerRef.current?.focus()");
    expect(danger).toContain("ref={triggerRef}");
    expect(danger).toContain("onKeyDown={onDialogKeyDown}");
  });
});
