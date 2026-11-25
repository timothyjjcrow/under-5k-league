// The stored inhouse box-score line (InhouseLobby.boxScore JSON) + its parser,
// shared by /inhouse and /inhouse/history. Mirrors what inhouse-service's
// buildResult writes.

import { gameMvp } from "./achievements";
import { sanitizeBenchmarks } from "./benchmarks";
import type { OpenDotaPlayer } from "./dota";
import {
  normalizePlayerGrade,
  type GradeAwardKey,
  type PlayerGrade,
} from "./player-grades";

/**
 * The stats a line carries beyond K/D/A, from the OpenDota payload. All
 * optional: games recorded before grades (2026-11) have none of them, and the
 * parsed-replay ones (damageTaken onwards) are absent until OpenDota has
 * parsed the replay.
 */
export type InhouseBoxExtras = {
  xpm?: number | null;
  denies?: number | null;
  heroDamage?: number | null;
  towerDamage?: number | null;
  heroHealing?: number | null;
  benchmarks?: Record<string, { raw: number | null; pct: number }> | null;
  /** Hero damage taken: the hero sources of OpenDota's damage_taken. */
  damageTaken?: number | null;
  stuns?: number | null;
  obsPlaced?: number | null;
  senPlaced?: number | null;
  wardsKilled?: number | null;
  campsStacked?: number | null;
  towersKilled?: number | null;
  roshansKilled?: number | null;
  laneEfficiency?: number | null;
  deadSeconds?: number | null;
  firstBlood?: boolean | null;
  /** Largest multi-kill (2 = double kill … 5 = rampage), 0 for none. */
  bestMultiKill?: number | null;
  /** The post-game grade, stamped once when the result landed. */
  grade?: PlayerGrade | null;
};

export type InhouseBoxPlayer = {
  userId: string | null;
  name: string | null;
  team: number | null;
  isRadiant: boolean;
  heroId: number;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number | null;
  gpm: number | null;
  lastHits: number | null;
} & InhouseBoxExtras;

const nullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";
const nullableNumber = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isFinite(v));

/**
 * Stored JSON is an external-data cache, not a trusted TypeScript value. One
 * malformed line must not crash Recent results, the permanent archive and a
 * player's entire profile through `gameMvp`/hero rendering.
 */
function isInhouseBoxPlayer(v: unknown): v is InhouseBoxPlayer {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return (
    nullableString(p.userId) &&
    nullableString(p.name) &&
    (p.team === null || p.team === 1 || p.team === 2) &&
    typeof p.isRadiant === "boolean" &&
    typeof p.heroId === "number" &&
    Number.isInteger(p.heroId) &&
    p.heroId >= 0 &&
    typeof p.kills === "number" &&
    Number.isFinite(p.kills) &&
    typeof p.deaths === "number" &&
    Number.isFinite(p.deaths) &&
    typeof p.assists === "number" &&
    Number.isFinite(p.assists) &&
    nullableNumber(p.netWorth) &&
    nullableNumber(p.gpm) &&
    nullableNumber(p.lastHits)
  );
}

const NUMBER_EXTRAS = [
  "xpm",
  "denies",
  "heroDamage",
  "towerDamage",
  "heroHealing",
  "damageTaken",
  "stuns",
  "obsPlaced",
  "senPlaced",
  "wardsKilled",
  "campsStacked",
  "towersKilled",
  "roshansKilled",
  "laneEfficiency",
  "deadSeconds",
  "bestMultiKill",
] as const;

/**
 * The core fields decide whether a line is kept; an extra that fails its
 * check is dropped on its own, so a bad grade or stat never hides the line.
 */
function cleanLine(p: InhouseBoxPlayer): InhouseBoxPlayer {
  const raw = p as unknown as Record<string, unknown>;
  const out: InhouseBoxPlayer = {
    userId: p.userId,
    name: p.name,
    team: p.team,
    isRadiant: p.isRadiant,
    heroId: p.heroId,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    netWorth: p.netWorth,
    gpm: p.gpm,
    lastHits: p.lastHits,
  };
  for (const key of NUMBER_EXTRAS) {
    if (key in raw && nullableNumber(raw[key])) out[key] = raw[key] as number | null;
  }
  if (typeof raw.firstBlood === "boolean") out.firstBlood = raw.firstBlood;
  if ("benchmarks" in raw) {
    out.benchmarks = sanitizeBenchmarks(
      raw.benchmarks as Parameters<typeof sanitizeBenchmarks>[0],
    );
  }
  if ("grade" in raw) {
    const grade = normalizePlayerGrade(raw.grade);
    if (grade) out.grade = grade;
  }
  return out;
}

export function parseInhouseBox(json: string): InhouseBoxPlayer[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter(isInhouseBoxPlayer).map(cleanLine) : [];
  } catch {
    return [];
  }
}

const finite = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * OpenDota sends 16-digit percentiles; three decimals is all a grade or a
 * "beats 86%" reads, and the archive parses a hundred box scores a view.
 */
function compactBenchmarks(
  bench: InhouseBoxExtras["benchmarks"],
): InhouseBoxExtras["benchmarks"] {
  if (!bench) return null;
  const out: NonNullable<InhouseBoxExtras["benchmarks"]> = {};
  for (const [key, { raw, pct }] of Object.entries(bench)) {
    out[key] = {
      raw: raw == null ? null : Math.round(raw * 100) / 100,
      pct: Math.round(pct * 1000) / 1000,
    };
  }
  return out;
}

/**
 * Everything a line keeps from OpenDota beyond K/D/A, net worth, GPM and last
 * hits. Damage taken is stored as one number (the hero sources of
 * `damage_taken`), never the per-unit map.
 */
export function inhouseBoxStats(pl: OpenDotaPlayer): InhouseBoxExtras {
  const out: InhouseBoxExtras = {
    xpm: finite(pl.xp_per_min),
    denies: finite(pl.denies),
    heroDamage: finite(pl.hero_damage),
    towerDamage: finite(pl.tower_damage),
    heroHealing: finite(pl.hero_healing),
    benchmarks: compactBenchmarks(sanitizeBenchmarks(pl.benchmarks)),
  };
  // Parsed-replay fields only when OpenDota has them: an absent key, not a
  // zero, is how a reader tells "not parsed yet" from "none".
  if (pl.damage_taken && typeof pl.damage_taken === "object") {
    out.damageTaken = Object.entries(pl.damage_taken)
      .filter(([unit]) => unit.startsWith("npc_dota_hero_"))
      .reduce((s, [, v]) => s + (finite(v) ?? 0), 0);
  }
  const parsed: [keyof InhouseBoxExtras, number | null | undefined][] = [
    ["stuns", pl.stuns],
    ["obsPlaced", pl.obs_placed],
    ["senPlaced", pl.sen_placed],
    ["campsStacked", pl.camps_stacked],
    ["towersKilled", pl.towers_killed],
    ["roshansKilled", pl.roshans_killed],
    ["laneEfficiency", pl.lane_efficiency_pct],
    ["deadSeconds", pl.life_state_dead],
  ];
  for (const [key, v] of parsed) {
    const n = finite(v);
    if (n != null) (out as Record<string, unknown>)[key] = Math.round(n * 10) / 10;
  }
  if (finite(pl.observer_kills) != null || finite(pl.sentry_kills) != null) {
    out.wardsKilled = (finite(pl.observer_kills) ?? 0) + (finite(pl.sentry_kills) ?? 0);
  }
  if (finite(pl.firstblood_claimed) != null) out.firstBlood = pl.firstblood_claimed === 1;
  if (pl.multi_kills && typeof pl.multi_kills === "object") {
    out.bestMultiKill = Math.max(
      0,
      ...Object.entries(pl.multi_kills)
        .filter(([, count]) => (finite(count) ?? 0) > 0)
        .map(([size]) => Number(size))
        .filter((n) => Number.isInteger(n) && n > 0),
    );
  }
  return out;
}

/** Does every linked line of this game carry a grade? */
export function isGradedBox(box: readonly InhouseBoxPlayer[]): boolean {
  const linked = box.filter((p) => p.userId);
  return linked.length > 0 && linked.every((p) => p.grade);
}

/** The line holding an award in a graded game, or null. */
export function lineWithAward(
  box: readonly InhouseBoxPlayer[],
  award: GradeAwardKey,
): InhouseBoxPlayer | null {
  return box.find((p) => p.userId && p.grade?.awards.includes(award)) ?? null;
}

/**
 * The game's MVP for every inhouse surface: the stored grade's MVP when the
 * game was graded, else the impact-points MVP it was always given (games
 * before grades keep the MVP Discord announced).
 */
export function inhouseGameMvp(
  box: readonly InhouseBoxPlayer[],
  radiantWin: boolean,
): string | null {
  if (isGradedBox(box)) return lineWithAward(box, "mvp")?.userId ?? null;
  return gameMvp([...box], radiantWin);
}

/** A graded game's Top core or Top support, whichever it gave out. */
export function inhouseRoleAward(
  box: readonly InhouseBoxPlayer[],
): { award: "topCore" | "topSupport"; line: InhouseBoxPlayer } | null {
  if (!isGradedBox(box)) return null;
  for (const award of ["topSupport", "topCore"] as const) {
    const line = lineWithAward(box, award);
    if (line) return { award, line };
  }
  return null;
}
