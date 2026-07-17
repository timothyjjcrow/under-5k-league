import { describe, expect, it } from "vitest";
import { averageMmr, mmrDistribution, roleCoverage } from "./pool-stats";

describe("roleCoverage", () => {
  it("counts each position across players", () => {
    const cov = roleCoverage([
      { roles: "1,2" },
      { roles: "1" },
      { roles: "5" },
      { roles: "" },
    ]);
    const byKey = Object.fromEntries(cov.map((r) => [r.key, r.count]));
    expect(byKey["1"]).toBe(2);
    expect(byKey["2"]).toBe(1);
    expect(byKey["3"]).toBe(0);
    expect(byKey["5"]).toBe(1);
  });
  it("always returns all five positions in order", () => {
    const cov = roleCoverage([]);
    expect(cov.map((r) => r.key)).toEqual(["1", "2", "3", "4", "5"]);
    expect(cov.every((r) => r.count === 0)).toBe(true);
  });
});

describe("mmrDistribution", () => {
  it("buckets players by MMR range (inclusive ends)", () => {
    const dist = mmrDistribution([
      { mmr: 500 },
      { mmr: 2500 },
      { mmr: 2999 },
      { mmr: 4200 },
      { mmr: 6000 },
    ]);
    const byLabel = Object.fromEntries(dist.map((b) => [b.label, b.count]));
    expect(byLabel["0–1k"]).toBe(1);
    expect(byLabel["2–3k"]).toBe(2);
    expect(byLabel["4–4.5k"]).toBe(1);
    expect(byLabel["4.5k+"]).toBe(1);
  });
  it("returns six buckets covering all ranges", () => {
    expect(mmrDistribution([]).map((b) => b.label)).toEqual([
      "0–1k",
      "1–2k",
      "2–3k",
      "3–4k",
      "4–4.5k",
      "4.5k+",
    ]);
  });
});

describe("averageMmr", () => {
  it("rounds the mean", () => {
    expect(averageMmr([{ mmr: 1000 }, { mmr: 2000 }, { mmr: 2001 }])).toBe(1667);
  });
  it("is zero for an empty pool", () => {
    expect(averageMmr([])).toBe(0);
  });
});

describe("MMR 0 = unknown (blank signup)", () => {
  it("averageMmr ignores unknowns instead of dragging the pool down", () => {
    expect(averageMmr([{ mmr: 3000 }, { mmr: 0 }, { mmr: 0 }])).toBe(3000);
    expect(averageMmr([{ mmr: 0 }])).toBe(0);
  });

  it("mmrDistribution never buckets unknowns as bottom-of-pool", () => {
    const dist = mmrDistribution([{ mmr: 0 }, { mmr: 4600 }]);
    expect(dist.reduce((s, b) => s + b.count, 0)).toBe(1);
  });
});
