// Pure aggregates over the signup pool: role coverage + MMR distribution.
// DB-free so it's unit-testable and cheap to reuse.
import { DOTA_ROLES, parseRoles } from "./roles";

export type RoleCount = {
  key: string;
  label: string;
  short: string;
  count: number;
};

/** How many players list each position (1..5). Always returns all five. */
export function roleCoverage(players: { roles: string }[]): RoleCount[] {
  const counts = new Map<string, number>();
  for (const p of players) {
    for (const key of parseRoles(p.roles)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return DOTA_ROLES.map((r) => ({
    key: r.key,
    label: r.label,
    short: r.short,
    count: counts.get(r.key) ?? 0,
  }));
}

export type MmrBucket = {
  label: string;
  min: number;
  max: number;
  count: number;
};

const BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "0–1k", min: 0, max: 999 },
  { label: "1–2k", min: 1000, max: 1999 },
  { label: "2–3k", min: 2000, max: 2999 },
  { label: "3–4k", min: 3000, max: 3999 },
  { label: "4–4.5k", min: 4000, max: 4499 },
  { label: "4.5k+", min: 4500, max: Number.POSITIVE_INFINITY },
];

/** Count players into fixed 1k-wide MMR buckets. */
export function mmrDistribution(players: { mmr: number }[]): MmrBucket[] {
  return BUCKETS.map((b) => ({
    label: b.label,
    min: b.min,
    max: b.max,
    count: players.filter((p) => p.mmr >= b.min && p.mmr <= b.max).length,
  }));
}

/** Mean MMR, rounded; 0 for an empty pool. */
export function averageMmr(players: { mmr: number }[]): number {
  if (players.length === 0) return 0;
  return Math.round(players.reduce((sum, p) => sum + p.mmr, 0) / players.length);
}
