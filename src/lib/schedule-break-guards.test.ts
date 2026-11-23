// Every date a round is given skips the season's breaks (schedule.ts,
// "Breaks"). A new caller of the raw weekly rhythm, or a season plan built
// without the breaks, would put a round on a night the league is off.

import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";

const SOURCE = sourceFiles(["src/**/*.ts", "src/**/*.tsx"], 400);

/** Files allowed to call the raw rhythm, and why. */
const RHYTHM_CALLERS: Record<string, string> = {
  "src/lib/schedule.ts": "defines it, and roundNight walks it",
  "src/lib/season-breaks.ts": "finds the night a break covers",
  "src/lib/season-format.ts": "walks the nights to place each break in the plan",
  "src/app/actions/admin-schedule-results.ts":
    "works week 1's night back from a moved week when a season has none",
};

/** The text of each call `name(...)` in `text`, parentheses balanced. */
function calls(text: string, name: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`\\b${name}\\(`, "g");
  for (const match of text.matchAll(pattern)) {
    let depth = 0;
    for (let i = match.index! + name.length; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      if (text[i] === ")") depth -= 1;
      if (depth === 0) {
        found.push(text.slice(match.index!, i + 1));
        break;
      }
    }
  }
  return found;
}

describe("round dates skip breaks", () => {
  it("calls the raw weekly rhythm only where a break can't apply", () => {
    const callers = SOURCE.filter((file) => /\bmatchNightForWeek\(/.test(file.text)).map(
      (file) => file.path,
    );
    expect(callers.length).toBeGreaterThanOrEqual(3);
    for (const path of callers) {
      expect(RHYTHM_CALLERS[path], `${path} dates a week without the breaks: use roundNight`).toBeDefined();
    }
  });

  it("dates rolled-forward rounds with upcomingRoundNight", () => {
    expect(SOURCE.filter((file) => file.text.includes("upcomingMatchNight")).map((f) => f.path)).toEqual([]);
    const callers = SOURCE.filter((file) => /\bupcomingRoundNight\(/.test(file.text));
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it("builds every season plan with the season's breaks", () => {
    const planCalls = SOURCE.flatMap((file) =>
      file.path === "src/lib/season-format.ts"
        ? []
        : calls(file.text, "seasonPlan").map((call) => ({ path: file.path, call })),
    );
    expect(planCalls.length).toBeGreaterThanOrEqual(6);
    for (const { path, call } of planCalls) {
      expect(call, `${path}: pass the season's breaks to seasonPlan`).toMatch(/[bB]reak/);
    }
  });
});
