import { describe, expect, it } from "vitest";
import { sourceFile, sourceFiles } from "../../test/support/source-files";

/**
 * Text that carries STATE is at least 12px (`text-xs`).
 *
 * The standings' seed, movement, "tied", "withdrawn" and tiebreaker chips, the
 * schedule's LIVE/final and forfeit markers, the season grid's result letters
 * and the box score's report-card grades were 9-10px — on phones, the size
 * most players read the league at. A 390px audit counted over a hundred
 * visible sub-12px elements on the home, teams, schedule and leaders pages.
 *
 * Decorative uppercase eyebrows, unit labels ("pts", "Elo") and the 11px
 * phone tab-bar labels stay small on purpose; they name things rather than
 * report them. So this guard has two halves: nothing anywhere below 10px,
 * and a list of the state markers, each of which must not sit inside a
 * sub-12px class.
 */

const SMALL = /\btext-\[(\d+(?:\.\d+)?)px\]/g;

function tinySizes(text: string, below: number) {
  return [...text.matchAll(SMALL)]
    .map((m) => Number(m[1]))
    .filter((px) => px < below);
}

describe("no text below 10px", () => {
  const files = sourceFiles(["src/**/*.tsx", "src/**/*.ts"], 150);

  it("finds the arbitrary text sizes it polices", () => {
    // The 10px eyebrows still exist; if this finds none, the pattern broke.
    expect(files.some((f) => /\btext-\[10px\]/.test(f.text))).toBe(true);
  });

  it("has no text-[9px] (or smaller) anywhere in src", () => {
    const offenders = files.flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ line, at: `${f.path}:${i + 1}` }))
        .filter(({ line }) => tinySizes(line, 10).length > 0)
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * Each marker is a pattern for the marker's rendered text. The guard walks
 * back to the nearest `className=` before each match — the element that
 * styles it, or a parent that sets the size it inherits — and requires that
 * stretch of source to carry no text size under 12px.
 */
const STATE_MARKERS: {
  file: string;
  what: string;
  pattern: RegExp;
  min: number;
}[] = [
  { file: "src/components/standings-table.tsx", what: "seed label", pattern: /seed \{row\.playoffSeed\}/g, min: 1 },
  { file: "src/components/standings-table.tsx", what: "movement arrows", pattern: /^\s*\{Math\.abs\(row\.move\)\}$/gm, min: 1 },
  { file: "src/components/standings-table.tsx", what: "Your team chip", pattern: />\s*Your team\s*</g, min: 1 },
  { file: "src/components/standings-table.tsx", what: "withdrawn status", pattern: />\s*Withdrawn\s*</g, min: 1 },
  { file: "src/components/standings-table.tsx", what: "tied chip", pattern: />\s*[Tt]ied\s*</g, min: 1 },
  { file: "src/components/standings-table.tsx", what: "tiebreaker chip", pattern: /"Tiebreaker pending"/g, min: 1 },
  { file: "src/components/standings-table.tsx", what: "tiebreaker resolved chip", pattern: />\s*Settled by tiebreaker\s*</g, min: 1 },
  { file: "src/components/standings-table.tsx", what: "playoff cut line", pattern: /Playoff cut/g, min: 1 },
  { file: "src/components/standings-table.tsx", what: "status line", pattern: /<StatusLine\b/g, min: 1 },
  { file: "src/components/standings-table.tsx", what: "win streak chip", pattern: /W\{wins\} streak/g, min: 1 },
  { file: "src/components/home/week-highlights.tsx", what: "upset chip", pattern: />\s*Upset\s*</g, min: 1 },
  { file: "src/components/schedule-weeks.tsx", what: "live/final status", pattern: /\{status\}\n/g, min: 1 },
  { file: "src/components/schedule-weeks.tsx", what: "forfeit marker", pattern: /Ruled result/g, min: 1 },
  { file: "src/components/schedule-weeks.tsx", what: "bye chip", pattern: />\s*Bye\s*</g, min: 1 },
  { file: "src/components/season-grid.tsx", what: "season grid result letters", pattern: /cell\.live\s+\? "Live"/g, min: 1 },
  { file: "src/components/tiebreaker-bracket.tsx", what: "tiebreaker game status", pattern: /statusLabels\[game\.status\]/g, min: 1 },
  { file: "src/app/matches/[id]/box-score-line.tsx", what: "report-card grades", pattern: /Report \{report\.overall\}\s*<|\{r\.grade\}\s*<\/b>/g, min: 2 },
  { file: "src/components/leader-board.tsx", what: "You chip", pattern: />\s*You\s*</g, min: 1 },
];

describe("state markers are at least 12px", () => {
  for (const marker of STATE_MARKERS) {
    it(`${marker.file}: ${marker.what}`, () => {
      const { text } = sourceFile(marker.file);
      const hits = [...text.matchAll(marker.pattern)];
      // A marker that silently stops matching would pass by checking nothing.
      expect(hits.length, `${marker.what} matches`).toBeGreaterThanOrEqual(
        marker.min,
      );
      for (const hit of hits) {
        const start = text.lastIndexOf("className=", hit.index);
        expect(start, `${marker.what} has a className before it`).toBeGreaterThan(
          -1,
        );
        const styling = text.slice(start, hit.index);
        expect(
          tinySizes(styling, 12),
          `${marker.what} at offset ${hit.index}`,
        ).toEqual([]);
      }
    });
  }
});
