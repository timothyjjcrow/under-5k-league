import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../../test/support/source-files";

/**
 * Every admin date/time box reads on the LEAGUE's clock.
 *
 * A <LocalDatetimeField> without `timeZone` reads the admin's own browser
 * clock. Europe's admin typing 20:00 from Los Angeles scheduled the season for
 * 05:00 Berlin time, and every screen they checked also rendered on their own
 * clock, so nothing looked wrong until players turned up. The failure is a
 * missing prop on a box nobody remembered, which only a source guard sees.
 */
const ROOT = join(__dirname, "..", "..", "..");

/**
 * Every file that renders an admin control: each page under /admin and the
 * admin components they mount (the same area admin-copy-guard globs), so a
 * box moved into a new admin component stays in view.
 */
const ADMIN_UI = sourceFiles(
  [
    "src/app/admin/**/*.tsx",
    "src/components/admin-*.tsx",
    "src/components/admin/**/*.tsx",
  ],
  3,
);

/** The props of every <LocalDatetimeField …/> in a source text. */
function fieldProps(text: string): string[] {
  return text
    .split("<LocalDatetimeField")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("/>")));
}

describe("admin time boxes", () => {
  const adminFields = ADMIN_UI.flatMap(({ path, text }) =>
    fieldProps(text).map((props) => ({ file: path, props })),
  );

  it("finds the boxes it is supposed to be guarding", () => {
    // Draft night, first match night, move a match night, per-match kickoff.
    // Finding nothing would pass the check below by default.
    expect(adminFields.length).toBeGreaterThanOrEqual(4);
  });

  it("read and prefill on the league's clock", () => {
    const missing = adminFields.filter(
      ({ props }) => !props.includes("timeZone={LEAGUE_CONFIG.timeZone}"),
    );
    expect(missing).toEqual([]);
  });

  it("leaves captain-facing boxes on the viewer's own clock", () => {
    // The reschedule box is labelled "your time"; the two captains may sit in
    // different zones and each proposes on their own clock.
    const reschedule = fieldProps(
      readFileSync(join(ROOT, "src", "app", "matches", "[id]", "page.tsx"), "utf8"),
    );
    expect(reschedule.length).toBeGreaterThan(0);
    expect(reschedule.every((props) => !props.includes("timeZone="))).toBe(true);
  });
});
