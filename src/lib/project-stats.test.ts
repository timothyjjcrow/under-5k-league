import { describe, it, expect } from "vitest";
import stats from "./project-stats.json";

// `scripts/project-stats.mjs` regenerates this file on every build, and the
// dashboard renders it verbatim. Nothing else checks it, so a counting bug
// ships as a confident wrong number on the front page — which is worse than no
// number, because it is presented as measured.

describe("project-stats.json", () => {
  it("has plausible, positive figures", () => {
    for (const key of ["codeLines", "codeFiles", "testLines", "testFiles", "tests"] as const) {
      expect(Number.isInteger(stats[key]), `${key} is an integer`).toBe(true);
      expect(stats[key], `${key} is positive`).toBeGreaterThan(0);
    }
    // Files can't outnumber the lines in them, and this repo tests heavily
    // enough that a test count near zero means the matcher broke, not that the
    // tests vanished — the suite running this assertion is one of them.
    expect(stats.codeFiles).toBeLessThan(stats.codeLines);
    expect(stats.testFiles).toBeLessThan(stats.testLines);
    expect(stats.tests).toBeGreaterThan(stats.testFiles);
  });

  // The first version read `git log --reverse --max-count=1`, where the limit
  // applies BEFORE the reverse — so it returned the NEWEST commit and reported
  // a three-week-old project as having started today. Any "days building"
  // figure derived from that would have rendered as 0.
  it("dates the first commit meaningfully in the past", () => {
    expect(stats.firstCommit).toBeTruthy();
    const first = new Date(stats.firstCommit as string).getTime();
    expect(Number.isNaN(first)).toBe(false);
    const days = (Date.now() - first) / 86_400_000;
    expect(days).toBeGreaterThan(1);
  });

  it("counts commits", () => {
    expect(stats.commits).toBeGreaterThan(0);
  });
});
