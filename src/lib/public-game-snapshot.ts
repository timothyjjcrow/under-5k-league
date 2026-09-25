import { prisma } from "./prisma";
import { createPublicSnapshot } from "./public-cache";

/** Null is all history; a string always applies a SQL season predicate. */
export async function fetchPublicGameSnapshot(seasonId: string | null) {
  const rows = await prisma.game.findMany({
    ...(seasonId === null ? {} : { where: { match: { seasonId } } }),
    select: {
      id: true, matchId: true, startTime: true, fetchedAt: true,
      radiantWin: true, durationSecs: true, radiantScore: true, direScore: true,
      players: true,
    },
  });
  // Cache misses and hits must expose identical types: Next serializes Dates.
  return rows.map(({ fetchedAt, ...row }) => ({ ...row, fetchedAtMs: fetchedAt.getTime() }));
}

export type PublicGameSnapshot = Awaited<ReturnType<typeof fetchPublicGameSnapshot>>;

/** Metadata and page projections share one version and one snapshot per render.
 * A UUID committed with each mutation fences work on other server instances;
 * old refreshes can finish only under their old persistent/in-flight key. */
export const getPublicGameSnapshot = createPublicSnapshot("public-game-snapshot-v2", fetchPublicGameSnapshot);

// Prisma5 measured four datasource queries for a nested Game/Match/two-Team
// select. Keep score-only views at one query; only context readers load these.
export function fetchPublicMatchContext(seasonId: string | null) {
  return prisma.match.findMany({
    where: { ...(seasonId === null ? {} : { seasonId }), games: { some: {} } },
    select: { id: true, seasonId: true, week: true, phase: true, homeTeamId: true, awayTeamId: true },
  });
}
export function fetchPublicTeamNames(seasonId: string | null) {
  return prisma.team.findMany({
    ...(seasonId === null ? {} : { where: { seasonId } }),
    select: { id: true, name: true },
  });
}
export type PublicMatchContext = Awaited<ReturnType<typeof fetchPublicMatchContext>>;
export type PublicTeamNames = Awaited<ReturnType<typeof fetchPublicTeamNames>>;
export const getPublicMatchContext = createPublicSnapshot("public-game-context-v1", fetchPublicMatchContext);
export const getPublicTeamNames = createPublicSnapshot("public-game-team-names-v1", fetchPublicTeamNames);
