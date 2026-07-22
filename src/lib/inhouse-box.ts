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

export function parseInhouseBox(json: string): InhouseBoxPlayer[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as InhouseBoxPlayer[]) : [];
  } catch {
    return [];
  }
}
