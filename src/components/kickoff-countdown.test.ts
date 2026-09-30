import { describe, expect, it } from "vitest";
import {
  folderSourceFiles,
  sourceFile,
  stripLineComments,
} from "../../test/support/source-files";

// The kickoff clock's rules live in src/lib/countdown.ts (kickoffClock,
// kickoffClockSpoken), tested there. These guards pin the component to them
// and to the two places a visitor meets it.
describe("KickoffCountdown", () => {
  const source = stripLineComments(
    sourceFile("src/components/kickoff-countdown.tsx").text,
  );

  it("reads the clock and its spoken name from the tested helpers", () => {
    expect(source).toMatch(/kickoffClock\(targetMs, second \* 1000\)/);
    expect(source).toContain("kickoffClockSpoken(clock)");
  });

  it("renders no digits on the server, so hydration never mismatches", () => {
    // The server has no business guessing the viewer's clock: a snapshot
    // other than null would hydrate one second over another.
    expect(source).toMatch(
      /function getServerSnapshot\(\): number \| null \{\s*return null;\s*\}/,
    );
    expect(source).toContain('role="timer"');
  });

  it("stands on the match scoreboard and Home's lone featured series", () => {
    const scoreboard = folderSourceFiles("src/app/matches/[id]", 5).find(
      (f) => f.path.endsWith("/scoreboard.tsx"),
    );
    expect(scoreboard?.text).toContain("<KickoffCountdown");
    // Only an unplayed fixture of the active season ticks.
    expect(scoreboard?.text).toMatch(
      /match\.season\.isActive &&\s*!hasSeriesScore &&\s*!resultPending/,
    );
    const home = sourceFile("src/components/home/this-week.tsx").text;
    expect(home).toMatch(/solo && m\.status !== "LIVE" && m\.scheduledAt \?\s*\(\s*<KickoffCountdown/);
  });
});
