// Post-game grades for inhouse games. Every player gets a score out of 100
// and a letter, built from three parts:
//
//   - This game (half): kill participation, survival and their two best role
//     areas, each against the players in their role in this game.
//   - Their hero (a quarter): OpenDota's per-hero benchmarks, how this game
//     ranks against everyone's games on that hero worldwide.
//   - Their MMR (a quarter): how their numbers rank against GGD2L inhouse
//     players in the same role within GRADE.MMR_SPREAD of their MMR.
//
// The MVP, the role award and the game's highlights come from the same
// numbers. Pure and unit-tested. The service grades a game once, when its
// result lands, and stores each grade on its box-score line, so a grade never
// moves after the game (the MMR baseline keeps growing; old grades keep the
// baseline they were measured against).

export const GRADE_VERSION = 1;

export const GRADE = {
  /** The three parts of a grade. Missing parts drop out and the rest scale up. */
  WEIGHT_GAME: 0.5,
  WEIGHT_HERO: 0.25,
  WEIGHT_MMR: 0.25,
  /** Inside "this game": fighting, survival, best role area, second-best. */
  FIGHTING: 0.35,
  SURVIVAL: 0.15,
  BEST_AREA: 0.3,
  SECOND_AREA: 0.2,
  /** Kill participation scores 0 at or below the floor and 100 at or above full. */
  KP_FLOOR: 0.3,
  KP_FULL: 0.8,
  /** Deaths per 10 minutes that score 0 for survival (0 deaths scores 100). */
  DEATHS_PER_10_ZERO: 2.5,
  /** The MMR comparison: same role within this MMR, widened once if thin. */
  MMR_SPREAD: 400,
  MMR_SPREAD_WIDE: 800,
  /** Lines needed for one MMR metric to count. */
  MMR_MIN_SAMPLE: 20,
  /** Metrics (MMR) or benchmarks (hero) needed for that part to count. */
  MIN_METRICS: 3,
  /** Added to a winner's score when picking the MVP, never to the grade. */
  MVP_WIN_BONUS: 8,
  /** How many recent graded-or-not games the service reads for the baseline. */
  BASELINE_GAMES: 300,
} as const;

export type GradeRole = "core" | "support";

export type GradeLetter =
  | "S"
  | "A+"
  | "A"
  | "A-"
  | "B+"
  | "B"
  | "B-"
  | "C+"
  | "C"
  | "C-"
  | "D";

/** Lowest score for each letter, best first. */
export const GRADE_LETTERS: readonly (readonly [number, GradeLetter])[] = [
  [88, "S"],
  [82, "A+"],
  [77, "A"],
  [72, "A-"],
  [67, "B+"],
  [62, "B"],
  [57, "B-"],
  [52, "C+"],
  [47, "C"],
  [42, "C-"],
  [0, "D"],
];

export function letterFor(score: number): GradeLetter {
  for (const [min, letter] of GRADE_LETTERS) if (score >= min) return letter;
  return "D";
}

/** The colour family for a letter (S/A green, B accent, C plain, D muted). */
export function letterTone(
  letter: GradeLetter,
): "success" | "accent" | "default" | "muted" {
  if (letter === "S" || letter.startsWith("A")) return "success";
  if (letter.startsWith("B")) return "accent";
  if (letter.startsWith("C")) return "default";
  return "muted";
}

/** The stat line a grade reads. Every optional field may be missing. */
export type GradeStats = {
  userId: string | null;
  isRadiant: boolean;
  heroId: number;
  kills: number;
  deaths: number;
  assists: number;
  netWorth?: number | null;
  gpm?: number | null;
  xpm?: number | null;
  lastHits?: number | null;
  heroDamage?: number | null;
  towerDamage?: number | null;
  heroHealing?: number | null;
  damageTaken?: number | null;
  stuns?: number | null;
  obsPlaced?: number | null;
  senPlaced?: number | null;
  wardsKilled?: number | null;
  campsStacked?: number | null;
  laneEfficiency?: number | null;
  firstBlood?: boolean | null;
  bestMultiKill?: number | null;
  benchmarks?: Record<
    string,
    { raw?: number | null; pct?: number | null } | null | undefined
  > | null;
};

// ---------- Areas (the "this game" part) ----------

export type GradeAreaKey =
  | "fighting"
  | "survival"
  | "damage"
  | "buildings"
  | "farm"
  | "frontline"
  | "control"
  | "laning"
  | "vision"
  | "healing"
  | "stacking";

/** Every area, in display order, with what it measures. */
export const GRADE_AREAS: Record<GradeAreaKey, { label: string; desc: string }> = {
  fighting: { label: "Fighting", desc: "Kill participation: kills + assists ÷ team kills" },
  survival: { label: "Survival", desc: "Deaths per 10 minutes" },
  damage: { label: "Hero damage", desc: "Damage dealt to heroes" },
  buildings: { label: "Buildings", desc: "Damage dealt to towers and buildings" },
  farm: { label: "Farm", desc: "Gold per minute" },
  frontline: { label: "Frontline", desc: "Hero damage taken per life" },
  control: { label: "Control", desc: "Seconds of stun on enemy heroes" },
  laning: { label: "Laning", desc: "Share of the lane's gold earned by 10 minutes" },
  vision: { label: "Vision", desc: "Wards placed, plus enemy wards destroyed" },
  healing: { label: "Healing", desc: "Healing done to heroes" },
  stacking: { label: "Stacking", desc: "Neutral camps stacked" },
};

/** The role areas each role is judged on; only the best two count. */
export const ROLE_AREAS: Record<GradeRole, readonly GradeAreaKey[]> = {
  core: ["damage", "buildings", "farm", "frontline", "control", "laning"],
  support: ["vision", "healing", "control", "stacking", "frontline", "damage"],
};

/** Areas that only exist once OpenDota has parsed the replay. */
const PARSED_AREAS = new Set<GradeAreaKey>([
  "frontline",
  "control",
  "laning",
  "vision",
  "stacking",
]);

const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function areaValue(area: GradeAreaKey, l: GradeStats): number | null {
  switch (area) {
    case "damage":
      return num(l.heroDamage);
    case "buildings":
      return num(l.towerDamage);
    case "farm":
      return num(l.gpm);
    case "frontline": {
      const taken = num(l.damageTaken);
      // Per life, so feeding never reads as tanking.
      return taken == null ? null : taken / (l.deaths + 1);
    }
    case "control":
      return num(l.stuns);
    case "laning":
      return num(l.laneEfficiency);
    case "vision": {
      const obs = num(l.obsPlaced);
      const sen = num(l.senPlaced);
      if (obs == null && sen == null) return null;
      return (obs ?? 0) + (sen ?? 0) + 0.5 * (num(l.wardsKilled) ?? 0);
    }
    case "healing":
      return num(l.heroHealing);
    case "stacking":
      return num(l.campsStacked);
    default:
      return null;
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Cores and supports: on each side the two lowest net worths are supports.
 * (On 60 real inhouse games this matched OpenDota's own position guess on
 * 572 of 600 lines, and it needs no parsed replay.) A short-handed side keeps
 * three cores first: four players give one support, three or fewer none.
 */
export function assignRoles(lines: readonly GradeStats[]): GradeRole[] {
  const roles: GradeRole[] = lines.map(() => "core");
  for (const side of [true, false]) {
    const idx = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.isRadiant === side)
      .sort(
        (a, b) =>
          (num(b.l.netWorth) ?? 0) - (num(a.l.netWorth) ?? 0) ||
          (num(b.l.gpm) ?? 0) - (num(a.l.gpm) ?? 0) ||
          a.i - b.i,
      )
      .map(({ i }) => i);
    const supports = Math.max(0, idx.length - 3);
    for (const i of idx.slice(idx.length - supports)) roles[i] = "support";
  }
  return roles;
}

function teamKills(lines: readonly GradeStats[], isRadiant: boolean): number {
  return lines
    .filter((l) => l.isRadiant === isRadiant)
    .reduce((s, l) => s + Math.max(0, l.kills), 0);
}

function killParticipation(l: GradeStats, kills: number): number {
  return kills > 0 ? clamp01((l.kills + l.assists) / kills) : 0;
}

const minutesOf = (durationSecs: number) => Math.max(1, durationSecs / 60);

// ---------- The MMR baseline ----------

export type MmrMetricKey =
  | "gpm"
  | "lhPerMin"
  | "kp"
  | "deathsPer10"
  | "heroDamagePerMin"
  | "towerDamagePerMin"
  | "healingPerMin"
  | "wardsPerMin"
  | "assistsPerMin";

export const MMR_METRICS: Record<MmrMetricKey, { label: string }> = {
  gpm: { label: "GPM" },
  lhPerMin: { label: "Last hits/min" },
  kp: { label: "Kill participation" },
  deathsPer10: { label: "Deaths/10 min" },
  heroDamagePerMin: { label: "Hero damage/min" },
  towerDamagePerMin: { label: "Building damage/min" },
  healingPerMin: { label: "Healing/min" },
  wardsPerMin: { label: "Wards/10 min" },
  assistsPerMin: { label: "Assists/10 min" },
};

const ROLE_MMR_METRICS: Record<GradeRole, readonly MmrMetricKey[]> = {
  core: ["gpm", "lhPerMin", "heroDamagePerMin", "towerDamagePerMin", "kp", "deathsPer10"],
  support: ["kp", "assistsPerMin", "heroDamagePerMin", "healingPerMin", "wardsPerMin", "deathsPer10"],
};

const LOWER_IS_BETTER = new Set<MmrMetricKey>(["deathsPer10"]);

/** One past player line for the MMR comparison. */
export type BaselineLine = {
  role: GradeRole;
  mmr: number;
  m: Partial<Record<MmrMetricKey, number>>;
};

function mmrMetricsOf(
  l: GradeStats,
  kills: number,
  minutes: number,
): Partial<Record<MmrMetricKey, number>> {
  const out: Partial<Record<MmrMetricKey, number>> = {
    kp: killParticipation(l, kills),
    deathsPer10: (l.deaths / minutes) * 10,
    assistsPerMin: (l.assists / minutes) * 10,
  };
  const gpm = num(l.gpm);
  if (gpm != null) out.gpm = gpm;
  const lh = num(l.lastHits);
  if (lh != null) out.lhPerMin = lh / minutes;
  const hd = num(l.heroDamage);
  if (hd != null) out.heroDamagePerMin = hd / minutes;
  const td = num(l.towerDamage);
  if (td != null) out.towerDamagePerMin = td / minutes;
  const heal = num(l.heroHealing);
  if (heal != null) out.healingPerMin = heal / minutes;
  const obs = num(l.obsPlaced);
  const sen = num(l.senPlaced);
  if (obs != null || sen != null) {
    out.wardsPerMin = (((obs ?? 0) + (sen ?? 0)) / minutes) * 10;
  }
  return out;
}

/** One line's MMR-comparison numbers in its game (for display). */
export function mmrMetricsFor(
  l: GradeStats,
  lines: readonly GradeStats[],
  durationSecs: number,
): Partial<Record<MmrMetricKey, number>> {
  return mmrMetricsOf(l, teamKills(lines, l.isRadiant), minutesOf(durationSecs));
}

/** Kill participation of one line in its game, 0..1. */
export function killParticipationIn(
  l: GradeStats,
  lines: readonly GradeStats[],
): number {
  return killParticipation(l, teamKills(lines, l.isRadiant));
}

/**
 * A finished game's lines as baseline rows: every line with a known MMR,
 * its role in that game and its per-minute numbers. A game with no duration
 * adds nothing.
 */
export function baselineLinesOf(
  lines: readonly (GradeStats & { mmr?: number | null })[],
  durationSecs: number | null,
): BaselineLine[] {
  if (!durationSecs || durationSecs <= 0) return [];
  const roles = assignRoles(lines);
  const minutes = minutesOf(durationSecs);
  const kills = { r: teamKills(lines, true), d: teamKills(lines, false) };
  const out: BaselineLine[] = [];
  lines.forEach((l, i) => {
    const mmr = num(l.mmr);
    if (mmr == null || mmr <= 0) return;
    out.push({
      role: roles[i],
      mmr,
      m: mmrMetricsOf(l, l.isRadiant ? kills.r : kills.d, minutes),
    });
  });
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Share of `sample` this value beats (ties count half), 0..1. */
function percentileIn(value: number, sample: number[], lowerIsBetter: boolean): number {
  let beaten = 0;
  for (const v of sample) {
    if (v === value) beaten += 0.5;
    else if (lowerIsBetter ? v > value : v < value) beaten += 1;
  }
  return sample.length ? beaten / sample.length : 0.5;
}

export type MmrComparison = {
  mmr: number;
  /** The ± MMR window actually used. */
  spread: number;
  /** Lines in the window (same role, known MMR). */
  n: number;
  /** Per metric: [percentile 0..1, the window's median]. */
  metrics: Partial<Record<MmrMetricKey, [number, number]>>;
};

function compareWithMmr(
  role: GradeRole,
  mmr: number,
  mine: Partial<Record<MmrMetricKey, number>>,
  baseline: readonly BaselineLine[],
): MmrComparison | null {
  const sameRole = baseline.filter((b) => b.role === role);
  for (const spread of [GRADE.MMR_SPREAD, GRADE.MMR_SPREAD_WIDE]) {
    const window = sameRole.filter((b) => Math.abs(b.mmr - mmr) <= spread);
    const metrics: MmrComparison["metrics"] = {};
    for (const key of ROLE_MMR_METRICS[role]) {
      const value = mine[key];
      if (value == null) continue;
      const sample = window
        .map((b) => b.m[key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (sample.length < GRADE.MMR_MIN_SAMPLE) continue;
      metrics[key] = [
        round3(percentileIn(value, sample, LOWER_IS_BETTER.has(key))),
        round3(median(sample)),
      ];
    }
    if (Object.keys(metrics).length >= GRADE.MIN_METRICS) {
      return { mmr, spread, n: window.length, metrics };
    }
  }
  return null;
}

// ---------- Hero benchmarks ----------

/** OpenDota benchmark keys per role. Every pct is "higher is better"
 *  (OpenDota already inverts deaths_per_min). */
const ROLE_BENCHMARKS: Record<GradeRole, readonly string[]> = {
  core: [
    "gold_per_min",
    "xp_per_min",
    "last_hits_per_min",
    "hero_damage_per_min",
    "tower_damage",
    "kills_per_min",
    "deaths_per_min",
  ],
  support: [
    "xp_per_min",
    "assists_per_min",
    "hero_damage_per_min",
    "hero_healing_per_min",
    "kills_per_min",
    "deaths_per_min",
  ],
};

export const BENCHMARK_LABELS: Record<string, string> = {
  gold_per_min: "GPM",
  xp_per_min: "XPM",
  last_hits_per_min: "Last hits/min",
  hero_damage_per_min: "Hero damage/min",
  tower_damage: "Building damage",
  kills_per_min: "Kills/min",
  deaths_per_min: "Deaths/min",
  assists_per_min: "Assists/min",
  hero_healing_per_min: "Healing/min",
};

/** The benchmark keys a role is judged on, with this line's percentile. */
export function heroBenchmarks(
  l: GradeStats,
  role: GradeRole,
): { key: string; pct: number }[] {
  const out: { key: string; pct: number }[] = [];
  for (const key of ROLE_BENCHMARKS[role]) {
    const pct = num(l.benchmarks?.[key]?.pct ?? null);
    if (pct != null) out.push({ key, pct: clamp01(pct) });
  }
  return out;
}

// ---------- Awards ----------

export type GradeAwardKey =
  | "mvp"
  | "topCore"
  | "topSupport"
  | "mostDamage"
  | "demolisher"
  | "frontline"
  | "healer"
  | "eyes"
  | "stunner"
  | "farmer"
  | "untouchable"
  | "firstBlood"
  | "rampage"
  | "ultraKill";

/** Every award, in display order. */
export const GRADE_AWARDS: Record<
  GradeAwardKey,
  { emoji: string; label: string; desc: string }
> = {
  mvp: { emoji: "🏅", label: "MVP", desc: "Best grade of the game (a win adds a little)" },
  topCore: { emoji: "⚔️", label: "Top core", desc: "Best core, in a game a support was MVP" },
  topSupport: { emoji: "🛡️", label: "Top support", desc: "Best support, in a game a core was MVP" },
  mostDamage: { emoji: "💥", label: "Most damage", desc: "Most hero damage in the game" },
  demolisher: { emoji: "🏰", label: "Demolisher", desc: "Most building damage in the game" },
  frontline: { emoji: "🧱", label: "Frontline", desc: "Took the most hero damage per life" },
  healer: { emoji: "💚", label: "Healer", desc: "Most healing in the game" },
  eyes: { emoji: "👁️", label: "All-seeing", desc: "Most wards placed in the game" },
  stunner: { emoji: "💫", label: "Lockdown", desc: "Most stun time in the game" },
  farmer: { emoji: "💰", label: "Farmer", desc: "Highest GPM in the game" },
  untouchable: { emoji: "😇", label: "Untouchable", desc: "Fewest deaths among those in half the team's kills" },
  firstBlood: { emoji: "🩸", label: "First blood", desc: "Drew first blood" },
  rampage: { emoji: "🔥", label: "Rampage", desc: "Five heroes in one multi-kill" },
  ultraKill: { emoji: "⚡", label: "Ultra kill", desc: "Four heroes in one multi-kill" },
};

/** The "most of something" highlights: one value per line, highest wins. */
const MOST: { key: GradeAwardKey; value: (l: GradeStats) => number | null; min: number }[] = [
  { key: "mostDamage", value: (l) => num(l.heroDamage), min: 1 },
  { key: "demolisher", value: (l) => num(l.towerDamage), min: 2000 },
  { key: "frontline", value: (l) => areaValue("frontline", l), min: 1 },
  { key: "healer", value: (l) => num(l.heroHealing), min: 2000 },
  {
    key: "eyes",
    value: (l) =>
      num(l.obsPlaced) == null && num(l.senPlaced) == null
        ? null
        : (num(l.obsPlaced) ?? 0) + (num(l.senPlaced) ?? 0),
    min: 5,
  },
  { key: "stunner", value: (l) => num(l.stuns), min: 20 },
  { key: "farmer", value: (l) => num(l.gpm), min: 1 },
];

/** Ties share a highlight; more than this many tied and nobody gets it. */
const MAX_TIED = 2;

function winnersOf(values: (number | null)[], min: number, lowest = false): number[] {
  const known = values.filter((v): v is number => v != null);
  if (known.length === 0) return [];
  const best = lowest ? Math.min(...known) : Math.max(...known);
  if (!lowest && best < min) return [];
  const idx = values.flatMap((v, i) => (v === best ? [i] : []));
  return idx.length <= MAX_TIED ? idx : [];
}

// ---------- The grade ----------

export type PlayerGrade = {
  v: typeof GRADE_VERSION;
  /** 0..100, whole points. */
  score: number;
  letter: GradeLetter;
  role: GradeRole;
  /** The three parts, 0..100; null where that part had no data. */
  game: number;
  hero: number | null;
  mmr: number | null;
  /** Every area this game measured, 0..100 against the role (fighting and
   *  survival are absolute). */
  areas: Partial<Record<GradeAreaKey, number>>;
  /** The two role areas that counted. */
  counted: GradeAreaKey[];
  /** The MMR comparison it was graded against, or null. */
  vsMmr: MmrComparison | null;
  awards: GradeAwardKey[];
  /** True when the replay wasn't parsed yet: the parsed-only areas are out. */
  partial: boolean;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function weighted(parts: { w: number; s: number | null }[]): number | null {
  const known = parts.filter((p): p is { w: number; s: number } => p.s != null);
  const total = known.reduce((s, p) => s + p.w, 0);
  if (total <= 0) return null;
  return known.reduce((s, p) => s + p.w * p.s, 0) / total;
}

/**
 * Grade every line of one finished game (same order as `lines`). The MVP is
 * the best grade among linked players with MVP_WIN_BONUS for a win; ties go
 * to more kills, then fewer deaths, then the lower user id.
 */
export function gradeGame(
  lines: readonly GradeStats[],
  ctx: {
    radiantWin: boolean;
    durationSecs: number;
    /** Each linked player's MMR when the game formed (0 or absent = unknown). */
    mmrByUser: ReadonlyMap<string, number>;
    baseline: readonly BaselineLine[];
  },
): PlayerGrade[] {
  if (lines.length === 0) return [];
  const roles = assignRoles(lines);
  const minutes = minutesOf(ctx.durationSecs);
  const kills = { r: teamKills(lines, true), d: teamKills(lines, false) };
  const partial = !lines.some((l) => num(l.damageTaken) != null);

  // Each role area against the best in that role this game.
  const areaScores = lines.map((l, i) => {
    const role = roles[i];
    const out: Partial<Record<GradeAreaKey, number>> = {};
    for (const area of ROLE_AREAS[role]) {
      if (partial && PARSED_AREAS.has(area)) continue;
      const group = lines.filter((_, j) => roles[j] === role);
      const best = Math.max(0, ...group.map((g) => areaValue(area, g) ?? 0));
      if (best <= 0) continue; // nobody in the role did any: no information
      out[area] = round1(100 * clamp01((areaValue(area, l) ?? 0) / best));
    }
    return out;
  });

  const grades = lines.map((l, i): PlayerGrade => {
    const role = roles[i];
    const kp = killParticipation(l, l.isRadiant ? kills.r : kills.d);
    const fighting =
      100 * clamp01((kp - GRADE.KP_FLOOR) / (GRADE.KP_FULL - GRADE.KP_FLOOR));
    const survival =
      100 * clamp01(1 - ((l.deaths / minutes) * 10) / GRADE.DEATHS_PER_10_ZERO);
    const roleAreas = Object.entries(areaScores[i]) as [GradeAreaKey, number][];
    // Best two, ties in catalogue order so the pick is stable.
    const ranked = roleAreas.sort(
      (a, b) =>
        b[1] - a[1] ||
        ROLE_AREAS[role].indexOf(a[0]) - ROLE_AREAS[role].indexOf(b[0]),
    );
    const counted = ranked.slice(0, 2).map(([k]) => k);
    const game =
      weighted([
        { w: GRADE.FIGHTING, s: fighting },
        { w: GRADE.SURVIVAL, s: survival },
        { w: GRADE.BEST_AREA, s: ranked[0]?.[1] ?? null },
        { w: GRADE.SECOND_AREA, s: ranked[1]?.[1] ?? null },
      ]) ?? 0;

    const bench = heroBenchmarks(l, role);
    const hero =
      bench.length >= GRADE.MIN_METRICS
        ? (100 * bench.reduce((s, b) => s + b.pct, 0)) / bench.length
        : null;

    const mmrValue = l.userId ? ctx.mmrByUser.get(l.userId) ?? 0 : 0;
    const vsMmr =
      mmrValue > 0
        ? compareWithMmr(
            role,
            mmrValue,
            mmrMetricsOf(l, l.isRadiant ? kills.r : kills.d, minutes),
            ctx.baseline,
          )
        : null;
    const mmrPcts = vsMmr ? Object.values(vsMmr.metrics).map((m) => m![0]) : [];
    const mmr = mmrPcts.length
      ? (100 * mmrPcts.reduce((s, p) => s + p, 0)) / mmrPcts.length
      : null;

    const score = Math.round(
      weighted([
        { w: GRADE.WEIGHT_GAME, s: game },
        { w: GRADE.WEIGHT_HERO, s: hero },
        { w: GRADE.WEIGHT_MMR, s: mmr },
      ]) ?? 0,
    );
    return {
      v: GRADE_VERSION,
      score,
      letter: letterFor(score),
      role,
      game: Math.round(game),
      hero: hero == null ? null : Math.round(hero),
      mmr: mmr == null ? null : Math.round(mmr),
      areas: { fighting: round1(fighting), survival: round1(survival), ...areaScores[i] },
      counted,
      vsMmr,
      awards: [],
      partial,
    };
  });

  // MVP and the role award: linked players only, as the MVP always was.
  const won = (l: GradeStats) => l.isRadiant === ctx.radiantWin;
  const linked = lines.map((l, i) => ({ l, i })).filter(({ l }) => !!l.userId);
  const better = (a: { l: GradeStats; i: number }, b: { l: GradeStats; i: number }) => {
    const sa = grades[a.i].score + (won(a.l) ? GRADE.MVP_WIN_BONUS : 0);
    const sb = grades[b.i].score + (won(b.l) ? GRADE.MVP_WIN_BONUS : 0);
    if (sa !== sb) return sa > sb;
    if (a.l.kills !== b.l.kills) return a.l.kills > b.l.kills;
    if (a.l.deaths !== b.l.deaths) return a.l.deaths < b.l.deaths;
    return (a.l.userId ?? "") < (b.l.userId ?? "");
  };
  const pickBest = (pool: typeof linked) =>
    pool.reduce<(typeof linked)[number] | null>(
      (best, c) => (!best || better(c, best) ? c : best),
      null,
    );
  const mvp = pickBest(linked);
  if (mvp) {
    grades[mvp.i].awards.push("mvp");
    const otherRole: GradeRole = roles[mvp.i] === "core" ? "support" : "core";
    const top = pickBest(linked.filter(({ i }) => roles[i] === otherRole));
    if (top) grades[top.i].awards.push(otherRole === "core" ? "topCore" : "topSupport");
  }

  // Highlights, open to every line (the box score shows unlinked players too).
  for (const { key, value, min } of MOST) {
    for (const i of winnersOf(lines.map(value), min)) grades[i].awards.push(key);
  }
  const involved = lines.map((l) =>
    killParticipation(l, l.isRadiant ? kills.r : kills.d) >= 0.5 && l.deaths <= 2
      ? l.deaths
      : null,
  );
  for (const i of winnersOf(involved, 0, true)) grades[i].awards.push("untouchable");
  lines.forEach((l, i) => {
    if (l.firstBlood) grades[i].awards.push("firstBlood");
    const multi = num(l.bestMultiKill) ?? 0;
    if (multi >= 5) grades[i].awards.push("rampage");
    else if (multi === 4) grades[i].awards.push("ultraKill");
  });
  return grades;
}

// ---------- Reading a stored grade back ----------

const AREA_KEYS = new Set(Object.keys(GRADE_AREAS));
const AWARD_KEYS = new Set(Object.keys(GRADE_AWARDS));
const METRIC_KEYS = new Set(Object.keys(MMR_METRICS));
const LETTER_SET = new Set(GRADE_LETTERS.map(([, l]) => l));

const isScore = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

/**
 * A stored grade, validated: stored JSON is a cache of external data, so a
 * malformed grade reads as no grade (the line itself survives).
 */
export function normalizePlayerGrade(v: unknown): PlayerGrade | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const g = v as Record<string, unknown>;
  if (g.v !== GRADE_VERSION) return null;
  if (!isScore(g.score) || !isScore(g.game)) return null;
  if (typeof g.letter !== "string" || !LETTER_SET.has(g.letter as GradeLetter)) return null;
  if (g.role !== "core" && g.role !== "support") return null;
  if (g.hero !== null && !isScore(g.hero)) return null;
  if (g.mmr !== null && !isScore(g.mmr)) return null;
  if (!g.areas || typeof g.areas !== "object" || Array.isArray(g.areas)) return null;
  const areas: PlayerGrade["areas"] = {};
  for (const [k, s] of Object.entries(g.areas as Record<string, unknown>)) {
    if (AREA_KEYS.has(k) && isScore(s)) areas[k as GradeAreaKey] = s;
  }
  const keys = (list: unknown, allowed: Set<string>) =>
    Array.isArray(list)
      ? list.filter((k): k is string => typeof k === "string" && allowed.has(k))
      : [];
  let vsMmr: MmrComparison | null = null;
  const m = g.vsMmr as Record<string, unknown> | null | undefined;
  if (
    m &&
    typeof m === "object" &&
    typeof m.mmr === "number" &&
    typeof m.spread === "number" &&
    typeof m.n === "number" &&
    m.metrics &&
    typeof m.metrics === "object"
  ) {
    const metrics: MmrComparison["metrics"] = {};
    for (const [k, pair] of Object.entries(m.metrics as Record<string, unknown>)) {
      if (
        METRIC_KEYS.has(k) &&
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((x) => typeof x === "number" && Number.isFinite(x))
      ) {
        metrics[k as MmrMetricKey] = [pair[0] as number, pair[1] as number];
      }
    }
    vsMmr = { mmr: m.mmr, spread: m.spread, n: m.n, metrics };
  }
  return {
    v: GRADE_VERSION,
    score: g.score,
    letter: g.letter as GradeLetter,
    role: g.role,
    game: g.game,
    hero: g.hero as number | null,
    mmr: g.mmr as number | null,
    areas,
    counted: keys(g.counted, AREA_KEYS) as GradeAreaKey[],
    vsMmr,
    awards: keys(g.awards, AWARD_KEYS) as GradeAwardKey[],
    partial: g.partial === true,
  };
}

// ---------- Copy ----------

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * How a grade is worked out, in one paragraph, built from GRADE so the copy
 * can never quote stale weights.
 */
export function gradeRule(): string {
  return (
    `Every player gets a grade out of 100. ${pct(GRADE.WEIGHT_GAME)} is this game, ` +
    `measured against the players in their role: kill participation, survival ` +
    `and their two best areas (cores: hero damage, buildings, farm, frontline, ` +
    `control, laning; supports: vision, healing, control, stacking, frontline, ` +
    `hero damage). ${pct(GRADE.WEIGHT_HERO)} is how the game ranks against ` +
    `everyone's games on that hero worldwide (OpenDota). ${pct(GRADE.WEIGHT_MMR)} ` +
    `is against GGD2L inhouse players in the same role within ` +
    `${GRADE.MMR_SPREAD} MMR. The best grade is MVP (a win adds ` +
    `${GRADE.MVP_WIN_BONUS}), and the best player of the other role gets Top ` +
    `core or Top support. A game that ends before OpenDota has parsed its ` +
    `replay is graded without damage taken, stuns, wards, stacks and laning, ` +
    `then graded again once the replay is parsed, so its grades and MVP can ` +
    `still change that day.`
  );
}

/** The short version, for a line under the box score. */
export function gradeRuleShort(): string {
  return (
    `Grades: ${pct(GRADE.WEIGHT_GAME)} this game against your role, ` +
    `${pct(GRADE.WEIGHT_HERO)} your hero worldwide, ${pct(GRADE.WEIGHT_MMR)} ` +
    `GGD2L players near your MMR. MVP is the best grade (+${GRADE.MVP_WIN_BONUS} ` +
    `for a win).`
  );
}
