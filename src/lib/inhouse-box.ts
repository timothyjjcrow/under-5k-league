// The stored inhouse box-score line (InhouseLobby.boxScore JSON) + its parser,
// shared by /inhouse and /inhouse/history. Mirrors what inhouse-service's
// buildResult writes.

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
};

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

export function parseInhouseBox(json: string): InhouseBoxPlayer[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter(isInhouseBoxPlayer) : [];
  } catch {
    return [];
  }
}
