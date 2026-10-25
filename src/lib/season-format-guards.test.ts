import { describe, expect, it } from "vitest";
import {
  sourceFiles,
  stripLineComments,
  type SourceFile,
} from "../../test/support/source-files";

/**
 * A season's format is read through one resolver (season-format.ts):
 * `plannedSeasonFormat` for what a schedule generated now would build, and
 * `resolveSeasonFormat` for what a season plays and every page prints. A page
 * that works the format out from its team count itself shows the
 * Recommended format whatever the season was generated as (a table of ten or
 * more printed "Two groups" over its one table), and it will ignore the
 * format an admin chooses once seasons store one. So the count-based
 * building blocks stay inside the modules that own them.
 */
const SOURCE = sourceFiles(
  ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts", "scripts/**/*.mts"],
  400,
);

function callers(pattern: RegExp, allowed: readonly string[]): string[] {
  return SOURCE.filter(
    (file) => !allowed.includes(file.path) && pattern.test(stripLineComments(file.text)),
  ).map((file) => file.path);
}

function callCount(files: readonly SourceFile[], pattern: RegExp): number {
  const global = new RegExp(pattern.source, "g");
  return files.reduce(
    (sum, file) => sum + (stripLineComments(file.text).match(global)?.length ?? 0),
    0,
  );
}

describe("the season format is read through its resolver", () => {
  it("never derives the format from a team count outside season-format.ts", () => {
    expect(callers(/(?<![\w.])seasonFormat\s*\(/, ["src/lib/season-format.ts"])).toEqual([]);
    expect(
      callers(/\b(?:GROUP_STAGE_MIN_TEAMS|DOUBLE_ROUND_MAX_TEAMS)\b/, [
        "src/lib/season-format.ts",
      ]),
    ).toEqual([]);
  });

  it("sizes brackets only where the format and the field are built", () => {
    // The Recommended spots; everything else reads the season's stored
    // format (seasonBracketSize, formatBracketSize).
    expect(callers(/\bplayoffBracketSize\s*\(/, ["src/lib/season-format.ts"])).toEqual([]);
    expect(
      callers(/\bseasonBracketSize\s*\(/, [
        "src/lib/season-format.ts",
        "src/lib/playoff-field.ts",
      ]),
    ).toEqual([]);
    expect(
      callers(/\bpickBracketSize\s*\(/, ["src/lib/schedule.ts", "src/lib/season-format.ts"]),
    ).toEqual([]);
  });

  it("routes every reader through the resolver", () => {
    const outside = SOURCE.filter((file) => file.path !== "src/lib/season-format.ts");
    // The /schedule plan, Home's plan, the admin format box, the season-start
    // post and /rules.
    expect(callCount(outside, /\bresolveSeasonFormat\s*\(/)).toBeGreaterThanOrEqual(5);
    // Schedule generation, the fixture seeder and /rules' fallback.
    expect(callCount(outside, /\bplannedSeasonFormat\s*\(/)).toBeGreaterThanOrEqual(3);
    // Every printed plan follows a bracket withdrawals shrank: /schedule,
    // Home, the admin format box and /rules.
    for (const path of [
      "src/app/schedule/page.tsx",
      "src/components/home/season-view.tsx",
      "src/components/admin/season-format-controls.tsx",
      "src/lib/league-rules.ts",
    ]) {
      const file = SOURCE.find((candidate) => candidate.path === path)!;
      expect(stripLineComments(file.text), path).toMatch(/\bwithBracket\s*\(/);
    }
  });

  it("stays importable from client code", () => {
    // The season builder previews formats in the browser. A value import of
    // Prisma (or the database) anywhere its rules reach would pull Prisma's
    // browser stub into a public chunk with every test still green, so walk
    // every module season-builder.ts imports, and theirs.
    const byPath = new Map(SOURCE.map((file) => [file.path, file]));
    const seen = new Set<string>();
    const queue = ["src/lib/season-builder.ts"];
    while (queue.length > 0) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const file = byPath.get(path);
      expect(file, path).toBeDefined();
      const imports = [...file!.text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)];
      for (const [, typeOnly, specifier] of imports) {
        if (typeOnly) continue;
        expect(specifier, `${path} imports ${specifier}`).not.toMatch(
          /@prisma\/client|\/prisma$|\/settings$|-service$/,
        );
        if (specifier.startsWith("./")) queue.push(`src/lib/${specifier.slice(2)}.ts`);
        else if (specifier.startsWith("@/lib/")) queue.push(`src/${specifier.slice(2)}.ts`);
      }
    }
    for (const reached of ["src/lib/season-format.ts", "src/lib/schedule.ts", "src/lib/draft-setup.ts"]) {
      expect(seen.has(reached), reached).toBe(true);
    }
  });

  it("previews with the rules the actions judge by", () => {
    const card = SOURCE.find((file) => file.path === "src/components/admin/season-format-builder.tsx");
    expect(card).toBeDefined();
    const text = stripLineComments(card!.text);
    expect(text).toMatch(/\bpreviewSeasonFormat\s*\(/);
    expect(text).toMatch(/\bformatAlternatives\s*\(/);
    for (const action of ["src/app/actions/admin-season.ts", "src/app/actions/admin-schedule-results.ts"]) {
      const file = SOURCE.find((candidate) => candidate.path === action)!;
      expect(stripLineComments(file.text), action).toMatch(/\bformatProblems\s*\(/);
    }
    const save = SOURCE.find((file) => file.path === "src/app/actions/admin-season.ts")!;
    expect(stripLineComments(save.text)).toMatch(/\bformatEditState\s*\(/);
  });
});
