import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

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
const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const admin = read("src/app/admin/page.tsx");
const seasons = read("src/app/seasons/page.tsx");
const danger = read("src/components/danger-submit.tsx");

/** action name → the file whose JSX must guard it with DangerSubmit. */
const UNRECOVERABLE: Array<{ action: string; source: string; why: string }> = [
  {
    action: "deleteSeason",
    source: seasons,
    why: "hard cascade delete of a whole season; no undo, no export",
  },
  {
    action: "abortDraftAction",
    source: admin,
    why: "dissolves an auction result nothing records",
  },
  {
    action: "startPlayoffs",
    source: admin,
    why: "reset deletes the postseason; RSVPs/picks/bookings are not archived",
  },
  {
    action: "generateSchedule",
    source: admin,
    why: "regenerate cascades away every check-in, pick and standin booking",
  },
  {
    action: "removeCaptain",
    source: admin,
    why: "deletes every fixture in the season, not just that team's",
  },
];

describe("unrecoverable admin actions require typed confirmation", () => {
  it.each(UNRECOVERABLE)("$action is guarded ($why)", ({ action, source }) => {
    // The form exists…
    expect(source).toContain(`action={${action}}`);
    // …and a DangerSubmit is rendered somewhere in the same file. (Both files
    // are small enough that a per-file check is the honest granularity — a
    // per-form parse would need a real JSX parser to be trustworthy.)
    expect(
      source.includes("<DangerSubmit"),
      `${action} lives in a file that no longer renders DangerSubmit`,
    ).toBe(true);
  });

  it("every DangerSubmit call site names a real token, not a magic word", () => {
    // "type DELETE" trains the reflex it exists to break; the token has to be
    // something specific to the thing being destroyed.
    for (const src of [admin, seasons]) {
      expect(src).not.toMatch(/token=\{?["']DELETE["']\}?/i);
      expect(src).not.toMatch(/token=\{?["']CONFIRM["']\}?/i);
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

  it("refuses to let Enter complete the action from the token field", () => {
    expect(danger).toContain('if (e.key === "Enter") e.preventDefault()');
  });

  it("clears the typed token whenever the dialog opens or closes", () => {
    // Otherwise a previously-typed token lingers and the next open is armed
    // from the first frame — exactly the one-keypress hazard this replaces.
    const clears = danger.match(/setTyped\(""\)/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(3); // open, cancel, escape
  });
});
