import { describe, expect, it } from "vitest";
import {
  BENCH_METRICS,
  cardAverage,
  careerReportCard,
  gameReportCard,
  gradeFor,
  gradeTone,
  percentLabel,
  type BenchmarkLine,
  type BenchmarkValue,
} from "./benchmarks";

function line(
  benchmarks?: Record<string, BenchmarkValue> | null
): BenchmarkLine {
  return benchmarks === undefined ? {} : { benchmarks };
}

describe("BENCH_METRICS", () => {
  it("lists the metric catalog in display order", () => {
    expect(BENCH_METRICS.map((m) => m.key)).toEqual([
      "gold_per_min",
      "xp_per_min",
      "kills_per_min",
      "last_hits_per_min",
      "hero_damage_per_min",
      "hero_healing_per_min",
      "tower_damage",
    ]);
  });
});

describe("gradeFor", () => {
  it("grades the exact boundaries", () => {
    expect(gradeFor(0.9)).toBe("S");
    expect(gradeFor(0.7)).toBe("A");
    expect(gradeFor(0.45)).toBe("B");
    expect(gradeFor(0.25)).toBe("C");
  });

  it("grades just below each boundary", () => {
    expect(gradeFor(0.8999)).toBe("A");
    expect(gradeFor(0.6999)).toBe("B");
    expect(gradeFor(0.4499)).toBe("C");
    expect(gradeFor(0.2499)).toBe("D");
    expect(gradeFor(0)).toBe("D");
  });

  it("handles out-of-range percentiles", () => {
    expect(gradeFor(1.5)).toBe("S");
    expect(gradeFor(-0.2)).toBe("D");
  });
});

describe("gradeTone", () => {
  it("maps every grade to its tone", () => {
    expect(gradeTone("S")).toBe("success");
    expect(gradeTone("A")).toBe("success");
    expect(gradeTone("B")).toBe("accent");
    expect(gradeTone("C")).toBe("default");
    expect(gradeTone("D")).toBe("muted");
  });
});

describe("gameReportCard", () => {
  it("builds one row per known metric, in catalog order", () => {
    const rows = gameReportCard(
      line({
        tower_damage: { raw: 4000, pct: 0.5 },
        gold_per_min: { raw: 620, pct: 0.92 },
        kills_per_min: { raw: 0.3, pct: 0.4 },
      })
    );
    expect(rows.map((r) => r.key)).toEqual([
      "gold_per_min",
      "kills_per_min",
      "tower_damage",
    ]);
    expect(rows[0]).toEqual({
      key: "gold_per_min",
      label: "Farming",
      short: "GPM",
      raw: 620,
      pct: 0.92,
      grade: "S",
    });
  });

  it("clamps percentiles into [0, 1]", () => {
    const rows = gameReportCard(
      line({
        gold_per_min: { raw: 900, pct: 1.2 },
        xp_per_min: { raw: 100, pct: -0.3 },
      })
    );
    expect(rows[0].pct).toBe(1);
    expect(rows[0].grade).toBe("S");
    expect(rows[1].pct).toBe(0);
    expect(rows[1].grade).toBe("D");
  });

  it("omits entries with missing, null, or NaN pct", () => {
    const rows = gameReportCard(
      line({
        gold_per_min: { raw: 500 }, // pct missing
        xp_per_min: { raw: 500, pct: null },
        kills_per_min: { raw: 0.2, pct: NaN },
        tower_damage: { raw: 100, pct: 0.1 },
      })
    );
    expect(rows.map((r) => r.key)).toEqual(["tower_damage"]);
  });

  it("ignores unknown metric keys", () => {
    const rows = gameReportCard(
      line({
        stuns_per_min: { raw: 3, pct: 0.99 },
        gold_per_min: { raw: 400, pct: 0.5 },
      })
    );
    expect(rows.map((r) => r.key)).toEqual(["gold_per_min"]);
  });

  it("returns [] for absent or null benchmarks", () => {
    expect(gameReportCard(line())).toEqual([]);
    expect(gameReportCard(line(null))).toEqual([]);
    expect(gameReportCard(line({}))).toEqual([]);
  });

  it("keeps the row with raw null when only pct is usable", () => {
    const rows = gameReportCard(
      line({
        gold_per_min: { pct: 0.6 },
        xp_per_min: { raw: null, pct: 0.7 },
        kills_per_min: { raw: NaN, pct: 0.8 },
      })
    );
    expect(rows.map((r) => r.raw)).toEqual([null, null, null]);
    expect(rows.map((r) => r.pct)).toEqual([0.6, 0.7, 0.8]);
  });
});

describe("cardAverage", () => {
  it("returns null for an empty card", () => {
    expect(cardAverage([])).toBeNull();
  });

  it("averages row percentiles", () => {
    const rows = gameReportCard(
      line({
        gold_per_min: { raw: 1, pct: 0.2 },
        xp_per_min: { raw: 1, pct: 0.8 },
      })
    );
    expect(cardAverage(rows)).toBeCloseTo(0.5);
  });
});

describe("careerReportCard", () => {
  it("counts legacy lines in games but not graded", () => {
    const report = careerReportCard([
      line({
        gold_per_min: { raw: 500, pct: 0.75 },
        xp_per_min: { raw: 600, pct: 0.6 },
      }),
      line({ gold_per_min: { raw: 400, pct: 0.25 } }),
      line(), // legacy: no benchmarks field
      line(null),
      line({ stuns_per_min: { raw: 1, pct: 0.5 } }), // unknown keys only
    ]);
    expect(report.games).toBe(5);
    expect(report.graded).toBe(2);
    expect(report.metrics.map((m) => [m.key, m.avgPct, m.games])).toEqual([
      ["gold_per_min", 0.5, 2],
      ["xp_per_min", 0.6, 1],
    ]);
  });

  it("returns an empty report when nothing is graded", () => {
    const report = careerReportCard([line(), line(null)]);
    expect(report.games).toBe(2);
    expect(report.graded).toBe(0);
    expect(report.metrics).toEqual([]);
    expect(report.avgPct).toBeNull();
    expect(report.focus).toBeNull();
    expect(report.best).toBeNull();
  });

  it("averages per-metric averages, not pooled per-line values", () => {
    const report = careerReportCard([
      line({ gold_per_min: { pct: 1 }, xp_per_min: { pct: 0 } }),
      line({ gold_per_min: { pct: 1 } }),
    ]);
    // gold avg 1.0 (2 games), xp avg 0.0 (1 game) → mean of metric avgs is
    // 0.5; a pooled mean over the three values would be 2/3.
    expect(report.avgPct).toBeCloseTo(0.5);
  });

  it("clamps percentiles before averaging", () => {
    const report = careerReportCard([
      line({ gold_per_min: { pct: 1.5 } }),
      line({ gold_per_min: { pct: -0.5 } }),
    ]);
    expect(report.metrics[0].avgPct).toBeCloseTo(0.5);
  });

  it("excludes metrics under the observation floor from focus/best", () => {
    const report = careerReportCard([
      line({
        gold_per_min: { pct: 0.9 },
        kills_per_min: { pct: 0.2 },
        xp_per_min: { pct: 0.95 }, // highest avg, but seen only once
      }),
      line({ gold_per_min: { pct: 0.7 }, kills_per_min: { pct: 0.4 } }),
      line({ gold_per_min: { pct: 0.8 } }),
    ]);
    // graded = 3 → floor = max(2, ceil(3/3)) = 2; xp (1 game) can't qualify.
    expect(report.best?.key).toBe("gold_per_min");
    expect(report.best?.avgPct).toBeCloseTo(0.8);
    expect(report.focus?.key).toBe("kills_per_min");
    expect(report.focus?.avgPct).toBeCloseTo(0.3);
  });

  it("sets best and leaves focus null when only one metric qualifies", () => {
    const report = careerReportCard([
      line({
        gold_per_min: { pct: 0.8 },
        xp_per_min: { pct: 0.1 }, // seen once — doesn't meet the floor of 2
      }),
      line({ gold_per_min: { pct: 0.4 } }),
    ]);
    expect(report.best?.key).toBe("gold_per_min");
    expect(report.focus).toBeNull();
  });

  it("keeps focus distinct from best even when averages tie", () => {
    const report = careerReportCard([
      line({ gold_per_min: { pct: 0.5 }, xp_per_min: { pct: 0.5 } }),
      line({ gold_per_min: { pct: 0.5 }, xp_per_min: { pct: 0.5 } }),
    ]);
    expect(report.best).not.toBeNull();
    expect(report.focus).not.toBeNull();
    expect(report.focus?.key).not.toBe(report.best?.key);
  });
});

describe("percentLabel", () => {
  it("formats ordinals, including the 11/12/13 exceptions", () => {
    expect(percentLabel(0.01)).toBe("1st percentile");
    expect(percentLabel(0.02)).toBe("2nd percentile");
    expect(percentLabel(0.03)).toBe("3rd percentile");
    expect(percentLabel(0.11)).toBe("11th percentile");
    expect(percentLabel(0.12)).toBe("12th percentile");
    expect(percentLabel(0.13)).toBe("13th percentile");
    expect(percentLabel(0.21)).toBe("21st percentile");
    expect(percentLabel(0.22)).toBe("22nd percentile");
    expect(percentLabel(0.23)).toBe("23rd percentile");
    expect(percentLabel(1)).toBe("100th percentile");
    expect(percentLabel(0)).toBe("0th percentile");
  });

  it("rounds fractional percentiles", () => {
    expect(percentLabel(0.724)).toBe("72nd percentile");
    expect(percentLabel(0.999)).toBe("100th percentile");
  });
});
