// Hall-of-fame math — pure and unit-tested. Careers span seasons: titles,
// series wins, and (via the fantasy/pick'em libs) career points and oracle
// records are all computed from the archive, not just the active season.

export type CareerMembership = { userId: string; teamId: string };

/**
 * Count, per player, how many entries of `teamIds` belong to one of their
 * teams. With championship team ids this yields career titles; with the
 * winners of completed series it yields career series wins. Team ids are
 * globally unique (cuid), so cross-season membership just works.
 */
export function careerCounts(
  memberships: CareerMembership[],
  teamIds: (string | null | undefined)[],
): Map<string, number> {
  const membersOfTeam = new Map<string, string[]>();
  for (const m of memberships) {
    const arr = membersOfTeam.get(m.teamId) ?? [];
    arr.push(m.userId);
    membersOfTeam.set(m.teamId, arr);
  }
  const counts = new Map<string, number>();
  for (const teamId of teamIds) {
    if (!teamId) continue;
    for (const userId of membersOfTeam.get(teamId) ?? []) {
      counts.set(userId, (counts.get(userId) ?? 0) + 1);
    }
  }
  return counts;
}

export type HofRow = { userId: string; value: number };

/** Top-N of a per-user count map (value desc, id tiebreak for stability). */
export function topCounts(
  counts: Map<string, number>,
  limit = 5,
  min = 1,
): HofRow[] {
  return [...counts.entries()]
    .filter(([, v]) => v >= min)
    .map(([userId, value]) => ({ userId, value }))
    .sort((a, b) => b.value - a.value || a.userId.localeCompare(b.userId))
    .slice(0, limit);
}
