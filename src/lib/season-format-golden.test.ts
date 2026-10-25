// The Recommended format, frozen. This file was captured from the code before
// the season format got a resolver, and every season that stores no format
// keeps rendering it. A change here re-renders live and archived seasons, so
// a new recommendation must be added as a new rule, never edited into this one.
import { describe, expect, it } from "vitest";
import {
  describeSeasonFormat,
  drawGroups,
  firstPlayoffWeek,
  formatName,
  formatSteps,
  playoffBracketSize,
  playoffSteps,
  regularSeasonFixtures,
  seasonFormat,
  seasonLengthPhrase,
  seasonPlan,
  teamCountSeasonNote,
  type SeasonFormatKind,
} from "./season-format";

const FIRST_NIGHT = new Date("2026-11-01T23:00:00.000Z");
const ZONES = ["America/New_York", null] as const;

/** Ids sort in draft order; the first team has the strongest roster. */
function teamIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);
}

function goldenSnapshot() {
  const formats = Array.from({ length: 33 }, (_, count) => {
    const format = seasonFormat(count);
    return {
      count,
      format,
      name: format ? formatName(format) : null,
      description: format ? describeSeasonFormat(format) : null,
      length: format ? seasonLengthPhrase(format) : null,
      note: teamCountSeasonNote(count),
      plans: format
        ? ZONES.map((zone) => ({
            zone,
            dated: seasonPlan(format, FIRST_NIGHT, undefined, zone),
            undated: seasonPlan(format, null, undefined, zone),
            longer: seasonPlan(format, FIRST_NIGHT, format.regularWeeks + 2, zone),
          }))
        : null,
    };
  });
  // Each count's fixtures as generation builds them: the MMR snake draw,
  // each group in draft order, the format's round robin.
  const fixtures = Array.from({ length: 16 }, (_, i) => {
    const count = i + 2;
    const format = seasonFormat(count)!;
    const ids = teamIds(count);
    const groups =
      format.kind === "GROUPS"
        ? drawGroups(
            ids.map((id, rank) => ({ id, averageMmr: 6000 - rank * 100 })),
            format.groupSizes.length,
          ).map((group) => [...group].sort())
        : [ids];
    return { count, groups, fixtures: regularSeasonFixtures(groups, format.doubleRound) };
  });
  const brackets: { kind: SeasonFormatKind; count: number; sizes: number[] }[] = [];
  for (const kind of ["TABLE", "GROUPS"] as const) {
    for (let count = 2; count <= 32; count++) {
      brackets.push({
        kind,
        count,
        sizes: Array.from({ length: count + 1 }, (_, eligible) =>
          playoffBracketSize(kind, count, eligible),
        ),
      });
    }
  }
  const playoffWeeks = [
    [5, 0],
    [5, 6],
    [5, 8],
    [9, 0],
    [9, 11],
  ].map(([last, tiebreaker]) => ({
    last,
    tiebreaker,
    week: firstPlayoffWeek(last, tiebreaker),
  }));
  return {
    formats,
    fixtures,
    brackets,
    playoffWeeks,
    formatSteps: formatSteps(),
    playoffSteps: playoffSteps(),
  };
}

/** JSON with one array item per line, so a change shows as a readable diff. */
function serialize(snapshot: Record<string, unknown>): string {
  const entries = Object.entries(snapshot).map(([key, value]) =>
    Array.isArray(value)
      ? `${JSON.stringify(key)}: [\n${value.map((item) => `  ${JSON.stringify(item)}`).join(",\n")}\n]`
      : `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return `{\n${entries.join(",\n")}\n}\n`;
}

describe("the Recommended season format", () => {
  it("still makes exactly the seasons it made on 2026-10-19", async () => {
    await expect(serialize(goldenSnapshot())).toMatchFileSnapshot(
      "../../test/fixtures/season-format-golden.json",
    );
  });
});
