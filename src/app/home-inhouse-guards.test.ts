import { describe, expect, it } from "vitest";
import {
  homePageFiles,
  stripLineComments,
} from "../../test/support/source-files";

/**
 * Home's inhouse queue line leads the page while anyone is queued
 * (`inhouseQueueLeadsHome`, src/lib/home-inhouse.ts), and its usual place
 * below stands down so it shows once. The rule is tested on its own; this
 * pins that Home asks it, and that every other `<InhouseStrip` on Home sits
 * behind the flag that turns it off, so a strip added to a new view later
 * can't print the line twice.
 */
describe("Home's leading inhouse queue line", () => {
  const files = homePageFiles().map((f) => ({
    path: f.path,
    text: stripLineComments(f.text),
  }));
  const page = files.find((f) => f.path === "src/app/page.tsx");

  it("reads the queue line up front and asks the rule", () => {
    expect(page?.text).toContain("loadInhouseQueueLine()");
    expect(page?.text).toContain("inhouseQueueLeadsHome(inhouseLine)");
  });

  const strips = files.flatMap((f) =>
    [...f.text.matchAll(/<InhouseStrip\b/g)].map((m) => ({
      path: f.path,
      before: f.text.slice(Math.max(0, (m.index ?? 0) - 400), m.index),
    })),
  );

  it("finds the strips it is supposed to be guarding", () => {
    // page.tsx: the leading one, the COMPLETE rail's tile and the strip
    // after the view; the season view's tile; the offseason view's strip.
    expect(strips.length).toBeGreaterThanOrEqual(5);
  });

  it("renders exactly one leading strip, in page.tsx", () => {
    const leading = strips.filter((s) => /inhouseLeads \? $/.test(s.before));
    expect(leading.map((s) => s.path)).toEqual(["src/app/page.tsx"]);
  });

  it("puts every other strip behind the flag that stands it down", () => {
    const gate =
      /(?:inhouseLeads|inhouseInTop) \? null : \(|inhouseTile \? \(/;
    const ungated = strips
      .filter((s) => !/inhouseLeads \? $/.test(s.before))
      .filter((s) => !gate.test(s.before))
      .map((s) => s.path);
    expect(ungated).toEqual([]);
  });
});
