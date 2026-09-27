import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

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

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

/** The props of every <LocalDatetimeField …/> in a file. */
function fieldProps(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("<LocalDatetimeField")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("/>")));
}

describe("admin time boxes", () => {
  const adminFields = sources(join(ROOT, "src", "app", "admin")).flatMap((path) =>
    fieldProps(path).map((props) => ({ file: relative(ROOT, path), props })),
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
    const reschedule = fieldProps(join(ROOT, "src", "app", "matches", "[id]", "page.tsx"));
    expect(reschedule.length).toBeGreaterThan(0);
    expect(reschedule.every((props) => !props.includes("timeZone="))).toBe(true);
  });
});
