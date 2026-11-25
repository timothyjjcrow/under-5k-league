// What a stored inhouse grade shows: the letter, its three parts, every area
// with the stat behind it, the hero and MMR comparisons, and the awards.
// Pure and tested; the box score, the history page and the room's result
// card render from it.

import type { InhouseBoxPlayer } from "./inhouse-box";
import {
  BENCHMARK_LABELS,
  GRADE,
  GRADE_AREAS,
  GRADE_AWARDS,
  MMR_METRICS,
  ROLE_AREAS,
  heroBenchmarks,
  killParticipationIn,
  letterFor,
  letterTone,
  mmrMetricsFor,
  type GradeAreaKey,
  type GradeAwardKey,
  type GradeLetter,
  type MmrMetricKey,
} from "./player-grades";

type Tone = ReturnType<typeof letterTone>;

const fmt = new Intl.NumberFormat("en-US");

/** 24,100 → "24.1k"; under 1,000 stays whole. */
export function compactNumber(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
}

const pctText = (n: number) => `${Math.round(n * 100)}%`;

export type GradeAwardView = {
  key: GradeAwardKey;
  emoji: string;
  label: string;
  desc: string;
};

export function awardViews(keys: readonly GradeAwardKey[]): GradeAwardView[] {
  return keys.map((key) => ({ key, ...GRADE_AWARDS[key] }));
}

export type GradeView = {
  letter: GradeLetter;
  score: number;
  tone: Tone;
  role: "Core" | "Support";
  parts: {
    key: "game" | "hero" | "mmr";
    label: string;
    note: string;
    score: number | null;
    letter: GradeLetter | null;
    tone: Tone;
    weight: string;
  }[];
  areas: {
    key: GradeAreaKey;
    label: string;
    desc: string;
    value: string;
    letter: GradeLetter;
    tone: Tone;
    /** One of the two role areas that counted. */
    counted: boolean;
  }[];
  hero: { label: string; beats: string }[];
  mmr: { label: string; value: string; typical: string; beats: string }[];
  awards: GradeAwardView[];
  partial: boolean;
};

function areaValue(
  key: GradeAreaKey,
  line: InhouseBoxPlayer,
  box: readonly InhouseBoxPlayer[],
): string {
  const n = (v: number | null | undefined) => (typeof v === "number" ? v : 0);
  switch (key) {
    case "fighting":
      return `${pctText(killParticipationIn(line, box))} of team kills`;
    case "survival":
      return line.deaths === 1 ? "1 death" : `${line.deaths} deaths`;
    case "damage":
      return `${compactNumber(n(line.heroDamage))} dealt`;
    case "buildings":
      return `${compactNumber(n(line.towerDamage))} dealt`;
    case "farm":
      return `${n(line.gpm)} GPM`;
    case "frontline":
      return `${compactNumber(n(line.damageTaken))} taken`;
    case "control":
      return `${Math.round(n(line.stuns))}s stuns`;
    case "laning":
      return `${Math.round(n(line.laneEfficiency))}% lane gold`;
    case "vision": {
      const wards = n(line.obsPlaced) + n(line.senPlaced);
      const killed = n(line.wardsKilled);
      return `${wards} wards${killed ? ` · ${killed} destroyed` : ""}`;
    }
    case "healing":
      return `${compactNumber(n(line.heroHealing))} healed`;
    case "stacking":
      return `${n(line.campsStacked)} stacks`;
  }
}

function mmrValue(key: MmrMetricKey, v: number): string {
  switch (key) {
    case "kp":
      return pctText(v);
    case "gpm":
    case "heroDamagePerMin":
    case "towerDamagePerMin":
    case "healingPerMin":
      return fmt.format(Math.round(v));
    default:
      return v.toFixed(1);
  }
}

/** The view of one graded line, or null when it carries no grade. */
export function gradeView(
  line: InhouseBoxPlayer,
  box: readonly InhouseBoxPlayer[],
  o: { durationSecs: number | null; heroName: string | null },
): GradeView | null {
  const g = line.grade;
  if (!g) return null;
  const role = g.role === "core" ? "Core" : "Support";
  const plural = g.role === "core" ? "cores" : "supports";
  const part = (
    key: GradeView["parts"][number]["key"],
    label: string,
    note: string,
    score: number | null,
    weight: number,
  ): GradeView["parts"][number] => {
    const letter = score == null ? null : letterFor(score);
    return {
      key,
      label,
      note,
      score,
      letter,
      tone: letter ? letterTone(letter) : "muted",
      weight: `${Math.round(weight * 100)}%`,
    };
  };
  const vs = g.vsMmr;
  const parts = [
    part("game", "This game", `Against the other ${plural} in this game`, g.game, GRADE.WEIGHT_GAME),
    part(
      "hero",
      o.heroName ? `On ${o.heroName}` : "On this hero",
      g.hero == null
        ? "OpenDota had no hero benchmarks for this game"
        : "Against everyone's games on this hero worldwide (OpenDota)",
      g.hero,
      GRADE.WEIGHT_HERO,
    ),
    part(
      "mmr",
      vs ? `For ${fmt.format(vs.mmr)} MMR` : "For their MMR",
      vs
        ? `Against ${fmt.format(vs.n)} GGD2L inhouse ${plural} at ${fmt.format(Math.max(0, vs.mmr - vs.spread))}–${fmt.format(vs.mmr + vs.spread)} MMR`
        : "Not enough GGD2L games near their MMR yet (or no MMR on record)",
      g.mmr,
      GRADE.WEIGHT_MMR,
    ),
  ];

  // Fighting and survival first, then the role's areas in catalogue order.
  const order: GradeAreaKey[] = ["fighting", "survival", ...ROLE_AREAS[g.role]];
  const areas = order.flatMap((key) => {
    const score = g.areas[key];
    if (score == null) return [];
    const letter = letterFor(score);
    return [
      {
        key,
        label: GRADE_AREAS[key].label,
        desc: GRADE_AREAS[key].desc,
        value: areaValue(key, line, box),
        letter,
        tone: letterTone(letter),
        counted: g.counted.includes(key),
      },
    ];
  });

  const hero = heroBenchmarks(line, g.role).map((b) => ({
    label: BENCHMARK_LABELS[b.key] ?? b.key,
    beats: `beats ${pctText(b.pct)}`,
  }));

  const mine =
    o.durationSecs && o.durationSecs > 0
      ? mmrMetricsFor(line, box, o.durationSecs)
      : {};
  const mmr = vs
    ? (Object.entries(vs.metrics) as [MmrMetricKey, [number, number]][]).map(
        ([key, [p, typical]]) => ({
          label: MMR_METRICS[key].label,
          value: mine[key] == null ? "—" : mmrValue(key, mine[key]!),
          typical: mmrValue(key, typical),
          beats: `beats ${pctText(p)}`,
        }),
      )
    : [];

  return {
    letter: g.letter,
    score: g.score,
    tone: letterTone(g.letter),
    role,
    parts,
    areas,
    hero,
    mmr,
    awards: awardViews(g.awards),
    partial: g.partial,
  };
}

/**
 * The extra numbers under a line's K/D/A, only the ones it has: hero damage,
 * building damage, damage taken, healing, wards, stuns.
 */
export function inhouseStatBits(line: InhouseBoxPlayer): string[] {
  const out: string[] = [];
  const has = (v: number | null | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v);
  if (has(line.heroDamage)) out.push(`${compactNumber(line.heroDamage)} dmg`);
  if (has(line.towerDamage) && line.towerDamage > 0) {
    out.push(`${compactNumber(line.towerDamage)} bldg`);
  }
  if (has(line.damageTaken)) out.push(`${compactNumber(line.damageTaken)} taken`);
  if (has(line.heroHealing) && line.heroHealing > 0) {
    out.push(`${compactNumber(line.heroHealing)} heal`);
  }
  const wards = (line.obsPlaced ?? 0) + (line.senPlaced ?? 0);
  if (wards > 0) out.push(`${wards} wards`);
  if (has(line.stuns) && line.stuns >= 1) out.push(`${Math.round(line.stuns)}s stun`);
  return out;
}
