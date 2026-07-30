import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every file that renders a season.draftAt countdown — the guard's whole
// lesson is that the surface nobody remembered is the one that regresses
// (/me and the draft waiting room shipped without passedLabel while the
// guard only read page.tsx).
const FILES = [
  join(__dirname, "page.tsx"),
  join(__dirname, "me", "page.tsx"),
  join(__dirname, "..", "components", "draft-room.tsx"),
];
const PAGE = FILES.map((f) => readFileSync(f, "utf8")).join("\n");

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
  const chunks = PAGE.split("<Countdown").slice(1);

  it("finds the countdowns it is supposed to be guarding", () => {
    // If the element is ever renamed or the props move to a wrapper, this test
    // would pass by finding nothing at all — which is how a guard rots into
    // decoration.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.slice(0, c.indexOf("/>")).includes("draftAt"))).toBe(
      true,
    );
  });

  it("carries passedLabel wherever it counts down to a draft night", () => {
    const missing = chunks
      .map((c) => c.slice(0, c.indexOf("/>")))
      .filter((props) => props.includes("draftAt") && !props.includes("passedLabel"));
    expect(missing).toEqual([]);
  });
});
