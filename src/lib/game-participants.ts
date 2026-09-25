import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { decodeGamePlayers, decodeIndexedGamePlayers, trustedGamePlayers } from "./player-stats";
import { raceHook } from "./race-hook";
import { claimParticipantAdmin, readParticipantAdmin } from "./participant-admin";

export const PARTICIPANT_VERSION = 1;

export function gamePlayersDigest(players: string) {
  return createHash("sha256").update(players).digest("hex");
}

export function participantCoveredWhere(): Prisma.GameWhereInput {
  return {
    participantVersion: PARTICIPANT_VERSION,
    participantSource: { equals: prisma.game.fields.players },
  };
}

export function participantUncoveredWhere(): Prisma.GameWhereInput {
  return { OR: [
    { participantSource: null },
    { participantVersion: { not: PARTICIPANT_VERSION } },
    { NOT: { participantSource: { equals: prisma.game.fields.players } } },
  ] };
}

export function buildParticipantProjection(players: string) {
  const decoded = decodeIndexedGamePlayers(players);
  return {
    complete: decoded.completeRoster,
    rows: (decoded.indexed.length > 10 ? [] : decoded.indexed).map(({ sourceLineIndex, player }) => ({
      ...player,
      sourceLineIndex,
      benchmarks: player.benchmarks ? JSON.stringify(player.benchmarks) : null,
    })),
  };
}

/** Caller owns the transaction: a failed child write must roll back the proof. */
export async function rebuildGameParticipants(
  tx: Prisma.TransactionClient,
  input: { gameId: string; expectedPlayers: string },
) {
  const projection = buildParticipantProjection(input.expectedPlayers);
  const claimed = await tx.game.updateMany({
    where: { id: input.gameId, players: input.expectedPlayers },
    data: {
      participantSource: input.expectedPlayers,
      participantVersion: PARTICIPANT_VERSION,
      participantComplete: projection.complete,
    },
  });
  if (claimed.count !== 1) return false;
  await tx.gameParticipant.deleteMany({ where: { gameId: input.gameId } });
  await raceHook("gameParticipants.beforeRows");
  if (projection.rows.length) {
    await tx.gameParticipant.createMany({
      data: projection.rows.map((row) => ({ ...row, gameId: input.gameId })),
    });
  }
  return true;
}

export type ParticipantBackfillResult = {
  scanned: number; rebuilt: number; invalid: number; changed: number;
  remaining: number; nextCursor: string | null; deadlineReached: boolean;
};

/** Local work only: no provider requests, one short command per source row. */
export async function backfillGameParticipants(options: {
  limit?: number; cursor?: string; deadlineMs?: number; seasonId?: string; actorId?: string;
} = {}): Promise<ParticipantBackfillResult> {
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(20, Math.floor(options.limit!))) : 20;
  const deadline = Math.min(options.deadlineMs ?? Infinity, Date.now() + 10_000);
  const scope: Prisma.GameWhereInput = {
    AND: [participantUncoveredWhere(), ...(options.seasonId ? [{ match: { seasonId: options.seasonId } }] : [])],
  };
  const batch = await prisma.game.findMany({
    where: { AND: [scope, ...(options.cursor ? [{ id: { gt: options.cursor } }] : [])] },
    select: { id: true, players: true }, orderBy: { id: "asc" }, take: limit,
  });
  const result: ParticipantBackfillResult = {
    scanned: 0, rebuilt: 0, invalid: 0, changed: 0, remaining: 0,
    nextCursor: null, deadlineReached: false,
  };
  for (const game of batch) {
    if (Date.now() >= deadline) { result.deadlineReached = true; break; }
    await raceHook("gameParticipants.backfillBeforeWrite");
    const saved = await prisma.$transaction(async (tx) => {
      if (options.actorId) {
        await claimParticipantAdmin(tx, await readParticipantAdmin(tx, options.actorId));
      }
      return rebuildGameParticipants(tx, { gameId: game.id, expectedPlayers: game.players });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    result.scanned++;
    result.nextCursor = game.id;
    if (saved) {
      result.rebuilt++;
      if (!decodeGamePlayers(game.players).completeRoster) result.invalid++;
    } else result.changed++;
  }
  result.remaining = await prisma.game.count({ where: scope });
  if (result.remaining === 0 || batch.length === 0) result.nextCursor = null;
  return result;
}

// A single Game statement avoids the gap between indexed and fallback reads.
// Only relevant covered games (plus uncovered legacy sources) transfer JSON.
const selectedGame = {
  id: true, matchId: true, dotaMatchId: true, radiantWin: true,
  durationSecs: true, startTime: true, radiantScore: true, direScore: true,
  radiantTeamId: true, direTeamId: true, winnerTeamId: true,
  players: true, fetchedAt: true,
} as const;

export async function fetchGamesForPlayers(
  userIds: string[], seasonId?: string,
  db: Pick<Prisma.TransactionClient, "game"> = prisma,
) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return [];
  if (ids.length > 500) throw new Error("Participant reader supports at most 500 users per request");
  const games = await db.game.findMany({
    where: { AND: [
      ...(seasonId ? [{ match: { seasonId } }] : []),
      { OR: [
        { AND: [participantCoveredWhere(), { participantComplete: true },
          { participants: { some: { userId: { in: ids } } } }] },
        participantUncoveredWhere(),
      ] },
    ] },
    select: selectedGame,
    orderBy: [{ startTime: "desc" }, { id: "asc" }],
  });
  const selected = new Set(ids);
  return games.filter((game) => trustedGamePlayers(decodeGamePlayers(game.players))
    .some((player) => player.userId !== null && selected.has(player.userId)));
}

/** Preserve the match page's uncached nested-Suspense boundary. */
export const fetchGamesForScouting = fetchGamesForPlayers;
