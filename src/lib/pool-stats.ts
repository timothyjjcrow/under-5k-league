// Pure aggregates over the signup pool: role coverage, the positions in short
// supply, and the average MMR. DB-free so it's unit-testable and cheap to reuse.
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

/** Mean of KNOWN MMRs (0 = unknown, excluded), rounded; 0 when none known. */
export function averageMmr(players: { mmr: number }[]): number {
  const known = players.filter((p) => p.mmr > 0);
  if (known.length === 0) return 0;
  return Math.round(known.reduce((sum, p) => sum + p.mmr, 0) / known.length);
}

/**
 * A roster's average MMR: the known signup MMRs of its members in that season
 * (`averageMmr`, so 0 means none is known). `registrations` may hold anyone's
 * rows for the season; only the members' count, once each. The Teams overview
 * and each team's page both read it, so the two can't disagree.
 */
export function rosterAverageMmr(
  memberUserIds: readonly string[],
  registrations: readonly { userId: string; mmr: number }[],
): number {
  const members = new Set(memberUserIds);
  const mmrByMember = new Map(
    registrations
      .filter((r) => members.has(r.userId))
      .map((r) => [r.userId, r.mmr]),
  );
  return averageMmr([...mmrByMember.values()].map((mmr) => ({ mmr })));
}

/**
 * One line naming the positions too few signups list to give every team one,
 * fewest first; null when there is nothing specific to say.
 *
 * Home's signup view used to draw a whole card of role and MMR bars (empty
 * buckets included) to make this one point. Roles are preferences and a player
 * may list several, so this is a recruiting hint ("we need supports"), not a
 * draft forecast. When EVERY position is short the pool is simply small, and
 * the hero's own count already says how many more players the league needs,
 * so the line stays quiet then too.
 */
export function shortRolesLine(
  coverage: readonly RoleCount[],
  teams: number,
  playerCount: number,
): string | null {
  if (teams <= 0 || playerCount <= 0) return null;
  const scarce = coverage
    .filter((role) => role.count < teams)
    .sort((a, b) => a.count - b.count || a.key.localeCompare(b.key));
  if (scarce.length === 0 || scarce.length === coverage.length) return null;
  const list = (items: string[]) =>
    items.length === 1
      ? items[0]
      : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  const names = list(scarce.map((role) => role.label));
  const counts = list(scarce.map((role) => String(role.count)));
  return `Short on ${names}: ${counts} of ${playerCount} players list ${
    scarce.length === 1 ? "it" : "them"
  }, and ${teams} teams need one each.`;
}

/**
 * The captain call on Home during signups: how many players have offered to
 * captain (or already captain) against the teams the season wants. Teams
 * are captains — Start draft makes one team per captain — so a pool of 31
 * with 3 volunteers drafts 3 teams however many players sign up. Null once
 * there are enough.
 */
export function captainsWantedLine(offered: number, teams: number): string | null {
  if (teams <= 0 || offered >= teams) return null;
  return `Captains wanted: ${offered} of ${teams} so far. Each team needs one.`;
}
