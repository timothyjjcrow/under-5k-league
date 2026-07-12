// Per-player benchmark report cards. OpenDota's /matches/{id} payload carries
// per-player "benchmarks": for ~8 metrics a { raw, pct } pair where pct is the
// player's percentile (0..1) vs everyone playing that hero worldwide. The
// import pipeline stores these on each player line in Game.players JSON; this
// module is the pure math/presentation layer over lines that may (or may not —
// legacy imports predate the field) carry benchmarks. Pure + DB-free + testable.

export type BenchmarkValue = { raw?: number | null; pct?: number | null };

export type BenchmarkLine = {
  benchmarks?: Record<string, BenchmarkValue> | null;
};

/** Metric catalog, in display order. Keys match OpenDota's benchmark names. */
export const BENCH_METRICS: readonly {
  key: string;
  label: string;
  short: string;
}[] = [
  { key: "gold_per_min", label: "Farming", short: "GPM" },
  { key: "xp_per_min", label: "Experience", short: "XPM" },
  { key: "kills_per_min", label: "Kills", short: "K/min" },
  { key: "last_hits_per_min", label: "Last hits", short: "LH/min" },
  { key: "hero_damage_per_min", label: "Hero damage", short: "HD/min" },
  { key: "hero_healing_per_min", label: "Healing", short: "Heal/min" },
  { key: "tower_damage", label: "Tower damage", short: "TD" },
];

export type Grade = "S" | "A" | "B" | "C" | "D";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Letter grade for a percentile (0..1): ≥0.90 S, ≥0.70 A, ≥0.45 B, ≥0.25 C, else D. */
export function gradeFor(pct: number): Grade {
  if (pct >= 0.9) return "S";
  if (pct >= 0.7) return "A";
  if (pct >= 0.45) return "B";
  if (pct >= 0.25) return "C";
  return "D";
}

/** UI color hint per grade — kept here so the color logic stays tested. */
export function gradeTone(grade: Grade): "success" | "accent" | "default" | "muted" {
  if (grade === "S" || grade === "A") return "success";
  if (grade === "B") return "accent";
  if (grade === "C") return "default";
  return "muted";
}

export type ReportRow = {
  key: string;
  label: string;
  short: string;
  raw: number | null;
  pct: number; // clamped into [0, 1]
  grade: Grade;
};

/**
 * Build a single game's report card: one row per BENCH_METRICS entry whose
 * pct on the line is a real number, in catalog order. Percentiles are clamped
 * into [0, 1]; unknown metric keys and missing/null/NaN pct entries are
 * skipped; a line without benchmarks (legacy import) yields [].
 */
export function gameReportCard(line: BenchmarkLine): ReportRow[] {
  const bench = line.benchmarks;
  if (!bench) return [];
  const rows: ReportRow[] = [];
  for (const metric of BENCH_METRICS) {
    const value = bench[metric.key];
    if (!value) continue;
    const { pct, raw } = value;
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    const clamped = clamp01(pct);
    rows.push({
      key: metric.key,
      label: metric.label,
      short: metric.short,
      raw: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
      pct: clamped,
      grade: gradeFor(clamped),
    });
  }
  return rows;
}

/** Mean percentile (0..1) across a card's rows, or null for an empty card. */
export function cardAverage(rows: ReportRow[]): number | null {
  if (rows.length === 0) return null;
  return rows.reduce((sum, row) => sum + row.pct, 0) / rows.length;
}

export type CareerMetric = {
  key: string;
  label: string;
  short: string;
  avgPct: number; // mean clamped percentile over the lines where this metric appears
  games: number; // lines where this metric appeared
};

export type CareerReport = {
  games: number; // all lines fed in, benchmarked or not
  graded: number; // lines that produced at least one usable metric
  metrics: CareerMetric[]; // catalog order, only metrics seen at least once
  /**
   * Mean of the per-metric avgPct values — NOT a pooled mean of every per-line
   * pct — so a frequently-benchmarked metric can't drown out a rare one.
   */
  avgPct: number | null;
  focus: CareerMetric | null; // the "work on this" callout
  best: CareerMetric | null;
};

/**
 * Roll many game lines (legacy ones welcome — they count in games but not
 * graded) into a career report. focus/best only consider metrics observed in
 * at least max(2, ceil(graded / 3)) lines: best is the highest-avgPct such
 * metric, focus the lowest, and they never coincide — when a single metric
 * qualifies, best takes it and focus stays null (celebrate before criticizing).
 */
export function careerReportCard(lines: BenchmarkLine[]): CareerReport {
  const tallies = new Map<string, { sum: number; games: number }>();
  let graded = 0;
  for (const line of lines) {
    const rows = gameReportCard(line);
    if (rows.length === 0) continue;
    graded += 1;
    for (const row of rows) {
      const tally = tallies.get(row.key) ?? { sum: 0, games: 0 };
      tally.sum += row.pct;
      tally.games += 1;
      tallies.set(row.key, tally);
    }
  }

  const metrics: CareerMetric[] = [];
  for (const metric of BENCH_METRICS) {
    const tally = tallies.get(metric.key);
    if (!tally) continue;
    metrics.push({
      key: metric.key,
      label: metric.label,
      short: metric.short,
      avgPct: tally.sum / tally.games,
      games: tally.games,
    });
  }

  const avgPct =
    metrics.length > 0
      ? metrics.reduce((sum, m) => sum + m.avgPct, 0) / metrics.length
      : null;

  const floor = Math.max(2, Math.ceil(graded / 3));
  const qualified = metrics.filter((m) => m.games >= floor);

  let best: CareerMetric | null = null;
  let focus: CareerMetric | null = null;
  if (qualified.length > 0) {
    best = qualified.reduce((top, m) => (m.avgPct > top.avgPct ? m : top));
    if (qualified.length > 1) {
      // Excluding best keeps focus !== best even when every avgPct ties.
      const rest = qualified.filter((m) => m !== best);
      focus = rest.reduce((low, m) => (m.avgPct < low.avgPct ? m : low));
    }
  }

  return { games: lines.length, graded, metrics, avgPct, focus, best };
}

/** Format a 0..1 percentile as an ordinal, e.g. 0.72 → "72nd percentile". */
export function percentLabel(pct: number): string {
  const n = Math.round(clamp01(pct) * 100);
  const mod100 = n % 100;
  const mod10 = n % 10;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : mod10 === 1
        ? "st"
        : mod10 === 2
          ? "nd"
          : mod10 === 3
            ? "rd"
            : "th";
  return `${n}${suffix} percentile`;
}
