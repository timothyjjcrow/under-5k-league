import { describe, expect, it } from "vitest";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import {
  FORMAT_CHOICES,
  formatAlternatives,
  formatDiff,
  formatEditState,
  formatProblems,
  knobsLabel,
  previewSeasonFormat,
  regularFixtureCount,
} from "./season-builder";
import { buildSeasonFormat, drawGroups, regularSeasonFixtures, seasonFormat } from "./season-format";

const knobs = (groups: number, meet: number, playoffs: number) => ({ groups, meet, playoffs });

describe("formatAlternatives", () => {
  it("lists every layout that fits 13 teams, shortest first", () => {
    expect(
      formatAlternatives(13).map(({ knobs: k, format, recommended }) => [
        knobsLabel(k),
        format.totalWeeks,
        `${format.matchesPerTeam.min}-${format.matchesPerTeam.max}`,
        recommended,
      ]),
    ).toEqual([
      ["Two groups, winner of each", 9, "5-6", false],
      ["Two groups, top 2 of each", 10, "5-6", false],
      ["Two groups, top 4 of each", 11, "5-6", true],
      ["One table, top 2 (a final)", 15, "12-12", false],
      ["One table, top 4", 16, "12-12", false],
      ["One table, top 8", 17, "12-12", false],
    ]);
  });

  it("orders equal lengths by matches played, for Europe's six", () => {
    expect(
      formatAlternatives(6).map(({ knobs: k, format }) => [knobsLabel(k), format.totalWeeks]),
    ).toEqual([
      ["Two groups, winner of each", 5],
      ["Two groups, top 2 of each", 6],
      ["One table, top 2 (a final)", 7],
      ["One table, top 4", 8],
      ["Two groups, each played twice, winner of each", 8],
      ["Two groups, each played twice, top 2 of each", 9],
      ["One table, played twice, top 2 (a final)", 12],
      ["One table, played twice, top 4", 13],
    ]);
  });
});

describe("formatProblems", () => {
  it("refuses layouts that can't be built, with the reason", () => {
    expect(formatProblems(knobs(2, 1, 4), 5).errors).toEqual([
      "Two groups need at least 6 teams, 3 in each; there are 5.",
    ]);
    expect(formatProblems(knobs(1, 1, 8), 7).errors).toEqual([
      "The top 8 needs at least 8 teams; there are 7.",
    ]);
    expect(formatProblems(knobs(1, 1, 4), 3).errors).toEqual([
      "The top 4 needs at least 4 teams; there are 3.",
    ]);
    expect(formatProblems(knobs(2, 2, 4), 13).errors).toEqual([
      "Playing twice needs groups of 6 teams or fewer; the largest has 7, which would take 14 weeks of group games.",
    ]);
    expect(formatProblems(knobs(1, 2, 4), 7).errors).toEqual([
      "Playing twice needs a table of 6 teams or fewer; this one has 7, which would take 14 weeks of regular-season games.",
    ]);
    expect(formatProblems(knobs(1, 1, 2), 1).errors).toEqual(["A season needs at least 2 teams."]);
  });

  it("warns about what a layout costs", () => {
    expect(formatProblems(knobs(1, 1, 8), 8).warnings).toContain(
      "Every team makes the playoffs, so the regular season only decides the seeds.",
    );
    expect(formatProblems(knobs(2, 1, 8), 9).warnings).toContain(
      "The group of 4 sends all 4 of its teams.",
    );
    expect(formatProblems(knobs(1, 1, 4), 13).warnings).toContain(
      "16 weeks in all; two groups, winner of each takes 9.",
    );
    expect(formatProblems(knobs(2, 1, 4), 7).warnings).toContain(
      "Some teams play only 2 regular matches.",
    );
    expect(formatProblems(knobs(1, 1, 8), 8).warnings).toContain(
      "One withdrawal would cut this bracket to 4.",
    );
    expect(formatProblems(knobs(2, 1, 8), 13)).toEqual({ errors: [], warnings: [] });
  });

  it("never refuses the Recommended layout", () => {
    for (let count = 2; count <= 24; count++) {
      const recommended = formatAlternatives(count).find((option) => option.recommended);
      expect(recommended, `${count} teams`).toBeDefined();
    }
  });
});

describe("previewSeasonFormat", () => {
  it("is the season generation builds, for every layout that fits 2 to 24 teams", () => {
    for (let count = 2; count <= 24; count++) {
      for (const groups of FORMAT_CHOICES.groups) {
        for (const meet of FORMAT_CHOICES.meet) {
          for (const playoffs of FORMAT_CHOICES.playoffs) {
            const k = knobs(groups, meet, playoffs);
            const preview = previewSeasonFormat(k, count, null);
            if (!preview || preview.problems.errors.length > 0) continue;
            const label = `${count} teams, ${knobsLabel(k)}`;
            const format = buildSeasonFormat(k, count)!;
            // The generator's own draw and round robin.
            const ids = Array.from({ length: count }, (_, i) => `t${i}`);
            const drawn =
              format.kind === "GROUPS"
                ? drawGroups(ids.map((id, rank) => ({ id, averageMmr: count - rank })), 2)
                : [ids];
            const fixtures = regularSeasonFixtures(drawn, format.doubleRound);
            expect(preview.fixtures, label).toBe(fixtures.length);
            expect(preview.fixtures, label).toBe(regularFixtureCount(format));
            expect(Math.max(...fixtures.map((f) => f.week)), label).toBe(format.regularWeeks);
            // Nobody plays twice in a week.
            const seen = new Set<string>();
            for (const f of fixtures) {
              for (const team of [f.home, f.away]) {
                expect(seen.has(`${f.week}:${team}`), label).toBe(false);
                seen.add(`${f.week}:${team}`);
              }
            }
            expect(preview.plan.at(-1)!.toWeek, label).toBe(format.totalWeeks);
            expect(preview.groups.map((g) => g.size).sort(), label).toEqual(
              [...format.groupSizes].sort(),
            );
          }
        }
      }
    }
  });

  it("names each group's off weeks and byes", () => {
    const preview = previewSeasonFormat(knobs(2, 1, 8), 13, null)!;
    expect(preview.groups).toEqual(
      expect.arrayContaining([
        { size: 7, offWeeks: [], byesPerTeam: 1 },
        { size: 6, offWeeks: [2, 5], byesPerTeam: 2 },
      ]),
    );
    expect(preview.plan.map((step) => [step.label, step.fromWeek, step.toWeek])).toEqual([
      ["Group stage", 1, 7],
      ["Tiebreakers", 8, 8],
      ["Quarterfinals", 9, 9],
      ["Semifinals", 10, 10],
      ["Grand final", 11, 11],
    ]);
  });
});

describe("formatDiff", () => {
  it("says what a rebuild changes", () => {
    expect(formatDiff(buildSeasonFormat(knobs(1, 1, 4), 12)!, seasonFormat(12)!)).toBe(
      "One table of 12 → two groups of 6: 66 → 30 matches, 14 → 9 weeks, top 4 → top 8 in the playoffs",
    );
    expect(formatDiff(seasonFormat(12)!, buildSeasonFormat(knobs(2, 1, 2), 12)!)).toBe(
      "9 → 7 weeks, top 8 → top 2 in the playoffs",
    );
    expect(formatDiff(seasonFormat(12)!, seasonFormat(12)!)).toBe("");
  });
});

describe("formatEditState", () => {
  const state = (overrides: Partial<Parameters<typeof formatEditState>[0]>) =>
    formatEditState({
      seasonStatus: SEASON_STATUS.SIGNUPS,
      draftStatus: null,
      regularFixtures: 0,
      regularResults: 0,
      games: 0,
      ...overrides,
    });

  it("is open, with the count still moving, through signups", () => {
    expect(state({})).toEqual({ mode: "OPEN", countFinal: false, lockReason: null });
    expect(state({ seasonStatus: SEASON_STATUS.DRAFT, draftStatus: DRAFT_STATUS.NOT_STARTED }))
      .toMatchObject({ mode: "OPEN", countFinal: false });
  });

  it("has a final count once the auction starts", () => {
    expect(state({ seasonStatus: SEASON_STATUS.DRAFT, draftStatus: DRAFT_STATUS.COMPLETE }))
      .toMatchObject({ mode: "OPEN", countFinal: true });
  });

  it("is built once fixtures exist, and locked while a result stands", () => {
    expect(state({ seasonStatus: SEASON_STATUS.REGULAR_SEASON, regularFixtures: 30 }).mode).toBe(
      "BUILT",
    );
    expect(
      state({ seasonStatus: SEASON_STATUS.REGULAR_SEASON, regularFixtures: 30, regularResults: 1 })
        .mode,
    ).toBe("LOCKED");
    expect(
      state({ seasonStatus: SEASON_STATUS.REGULAR_SEASON, regularFixtures: 30, games: 1 }).mode,
    ).toBe("LOCKED");
    expect(state({ seasonStatus: SEASON_STATUS.PLAYOFFS, regularFixtures: 30 }).lockReason).toBe(
      "The playoffs have started, so this season's format is locked.",
    );
    expect(state({ seasonStatus: SEASON_STATUS.COMPLETE }).mode).toBe("LOCKED");
  });
});
