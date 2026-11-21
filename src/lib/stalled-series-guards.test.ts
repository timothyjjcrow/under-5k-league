import { describe, expect, it } from "vitest";
import {
  folderSourceFiles,
  haystackOf,
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

/**
 * A series that stopped partway (`seriesStalled`: LIVE, kickoff past the
 * result-sync window) is unfinished, not live. On 2026-11-20 two US week-2
 * Bo2s sat at 1-0 for a week while the admins moved the rest to week 3's
 * night, and every page still said "Week 2", "Series live" and "Your series
 * is live". The rule is pure and tested in schedule.test.ts; these guards pin
 * that the surfaces showing a series' live state still ask it, so a refactor
 * can't quietly bring back a week-old pulsing "Live".
 */
const code = (text: string) => stripLineComments(text);

describe("stalled series surfaces", () => {
  it("/schedule rows split live from unfinished through the shared rule", () => {
    const schedule = code(haystackOf(sourceFiles("src/app/schedule/**/*.tsx", 1)));
    expect(schedule).toMatch(/live: m\.status === "LIVE" && !seriesStalled\(m, /);
    expect(schedule).toMatch(/unfinished: seriesStalled\(m, /);
    const weeks = code(sourceFile("src/components/schedule-weeks.tsx").text);
    expect(weeks).toContain('? "Unfinished"');
    expect(weeks.match(/m\.unfinished/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("the match page, the captains page and the share picture ask seriesStalled", () => {
    const match = code(haystackOf(folderSourceFiles("src/app/matches/[id]", 10)));
    expect(match).toMatch(/seriesStalled\(match, renderedAt\)/);
    const captains = code(haystackOf(sourceFiles("src/app/captains/**/*.tsx", 2)));
    expect(captains.match(/seriesStalled\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(code(sourceFile("src/lib/og-image.ts").text)).toMatch(
      /seriesStalled\(match, nowMs\)/,
    );
  });

  it("Home's panel and the team and profile cards word it unfinished", () => {
    expect(code(sourceFile("src/components/home/my-next-match.tsx").text)).toMatch(
      /live\.unfinished/,
    );
    expect(code(sourceFile("src/lib/my-match-panel.ts").text)).toMatch(
      /unfinished: seriesStalled\(m, input\.nowMs\)/,
    );
    const team = code(haystackOf(folderSourceFiles("src/app/teams/[id]", 2)));
    expect(team).toMatch(/matchState === "Unfinished"/);
    expect(code(sourceFile("src/components/profile-match-spotlight.tsx").text)).toMatch(
      /state !== "Unfinished"/,
    );
  });

  it("the header's Series live chip leaves stalled series out", () => {
    const nav = code(sourceFile("src/lib/public-navigation.ts").text);
    expect(nav).toMatch(/status: MATCH_STATUS\.LIVE,\s*OR: \[/);
    expect(nav).toContain("AUTO_SYNC.WINDOW_HOURS");
  });
});
