import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { discoverThrottleSqlClaims } from "../../scripts/mutation-sql-claims.mjs";

const file = "src/lib/settings.ts";
const source = readFileSync(file, "utf8");

describe("SQL throttle mutation protection", () => {
  it("keeps the existing protected claim ID and removes both timestamp guards", () => {
    const claims = discoverThrottleSqlClaims(file, source);
    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe("src/lib/settings.ts::claimThrottle::value#1");
    const baseline = JSON.parse(readFileSync("test/mutation-baseline.json", "utf8"));
    expect(baseline.protected).toContain(claims[0].id);

    let mutant = source;
    for (const [start, end] of [...claims[0].drop].sort((a, b) => b[0] - a[0])) {
      mutant = mutant.slice(0, start) + mutant.slice(end);
    }
    expect(mutant).not.toContain('WHERE NOT EXISTS');
    expect(mutant).not.toContain('WHERE "Setting"."value" <');
    expect(mutant).toContain('ON CONFLICT ("key") DO UPDATE');
    expect(
      ts.transpileModule(mutant, { fileName: file, reportDiagnostics: true }).diagnostics,
    ).toEqual([]);
  });

  it("fails closed if either SQL timestamp predicate is removed", () => {
    const [claim] = discoverThrottleSqlClaims(file, source);
    for (const [start, end] of claim.drop) {
      expect(
        discoverThrottleSqlClaims(file, source.slice(0, start) + source.slice(end)),
      ).toEqual([]);
    }
  });

  it("does not mistake comments or another function for the protected claim", () => {
    expect(
      discoverThrottleSqlClaims(file, source.split("\n").map((line) => `// ${line}`).join("\n")),
    ).toEqual([]);
    expect(
      discoverThrottleSqlClaims(file, source.replace('async function claimThrottle(', 'async function anotherClaim(')),
    ).toEqual([]);
  });
});
