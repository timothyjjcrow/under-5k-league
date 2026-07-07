// Pure filtering + sorting for the player-pool UI. Kept DB-free so it's
// unit-testable and reusable on client and server.
import { parseRoles } from "./roles";

export type PoolPlayer = {
  userId: string;
  name: string;
  avatar: string | null;
  mmr: number;
  rankTier: number | null;
  roles: string;
  favoriteHeroes: string;
  captainNote: string;
  wantsCaptain: boolean;
  drafted: boolean;
  /** Resolved Dota account id for scouting links, or null if unavailable. */
  accountId: number | null;
};

export type PoolSort = "mmr" | "rank" | "name";

export type PoolFilter = {
  query?: string;
  /** Position key "1".."5", or null for all roles. */
  role?: string | null;
  sort?: PoolSort;
  captainOnly?: boolean;
};

/** Filter + sort a player list. Never mutates the input. */
export function filterAndSortPlayers(
  players: PoolPlayer[],
  { query = "", role = null, sort = "mmr", captainOnly = false }: PoolFilter,
): PoolPlayer[] {
  const q = query.trim().toLowerCase();
  const filtered = players.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (role && !parseRoles(p.roles).includes(role)) return false;
    if (captainOnly && !p.wantsCaptain) return false;
    return true;
  });
  return [...filtered].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "rank") {
      // Highest medal first; unknown medals sink to the bottom, MMR breaks ties.
      return (b.rankTier ?? -1) - (a.rankTier ?? -1) || b.mmr - a.mmr;
    }
    return b.mmr - a.mmr;
  });
}
