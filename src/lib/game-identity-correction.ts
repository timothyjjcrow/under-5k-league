import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { decodeGamePlayers, normalizedPlayerStat } from "./player-stats";
import { gamePlayersDigest, rebuildGameParticipants } from "./game-participants";
import { stampResultChange } from "./settings";
import { raceHook } from "./race-hook";
import { UserFacingError } from "./user-facing-error";
import { markWeekHonorsStale } from "./honors-service";
import { claimParticipantAdmin, readParticipantAdmin } from "./participant-admin";

export type GameIdentityCorrection = {
  actorId: string; gameId: string; sourceLineIndex: number;
  expectedSourceDigest: string; userId: string | null; teamId: string | null; reason: string;
};

export async function correctGameIdentity(input: GameIdentityCorrection) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 300 || !Number.isSafeInteger(input.sourceLineIndex) ||
      input.sourceLineIndex < 0 || input.sourceLineIndex > 100 ||
      !/^[a-f0-9]{64}$/.test(input.expectedSourceDigest)) {
    throw new UserFacingError("Review the player line and give a reason (1–300 characters).");
  }
  return prisma.$transaction(async (tx) => {
    const [actor, game] = await Promise.all([
      readParticipantAdmin(tx, input.actorId),
      tx.game.findUnique({ where: { id: input.gameId }, include: { match: true } }),
    ]);
    if (!game) throw new UserFacingError("This game no longer exists.");
    if (gamePlayersDigest(game.players) !== input.expectedSourceDigest) {
      throw new UserFacingError("This box score changed — reload before correcting it.");
    }
    let source: unknown;
    try { source = JSON.parse(game.players); } catch { /* validated below */ }
    if (!Array.isArray(source)) throw new UserFacingError("This box score needs a data repair before identity correction.");
    const before = normalizedPlayerStat(source[input.sourceLineIndex]);
    if (!before) throw new UserFacingError("That player line is not valid — reload the box score.");
    const sideTeamId = before.isRadiant ? game.radiantTeamId : game.direTeamId;
    if (input.teamId !== null && (input.teamId !== sideTeamId ||
        ![game.match.homeTeamId, game.match.awayTeamId].includes(input.teamId))) {
      throw new UserFacingError("Choose this player's recorded fixture side, or leave the team unknown.");
    }
    if (input.userId !== null && !(await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } }))) {
      throw new UserFacingError("That player no longer exists.");
    }
    const changed = before.userId !== input.userId || before.teamId !== input.teamId;
    if (!changed) return { gameId: game.id, matchId: game.matchId, seasonId: game.match.seasonId, changed: false };
    const after = { ...source[input.sourceLineIndex], userId: input.userId, teamId: input.teamId };
    // Observed slot/statistics stay intact. A new mapped identity does not
    // inherit the previous person's planned or confirmed role/rating claims.
    const provenanceKeys = ["plannedPosition", "playedPosition", "positionSource", "ratingSnapshot", "ratingSource", "ratingAt"] as const;
    if (before.userId !== input.userId) {
      for (const key of provenanceKeys) delete after[key];
    } else if (before.teamId !== input.teamId && before.positionSource === "LINEUP_PLANNED") {
      delete after.plannedPosition;
      delete after.positionSource;
    }
    source[input.sourceLineIndex] = after;
    const players = JSON.stringify(source);
    if (!decodeGamePlayers(players).completeRoster) {
      throw new UserFacingError("This correction must leave ten valid, distinct player lines.");
    }
    await raceHook("gameIdentity.beforeClaim");
    await claimParticipantAdmin(tx, actor);
    const saved = await tx.game.updateMany({ where: { id: game.id, players: game.players }, data: { players } });
    if (saved.count !== 1) throw new UserFacingError("This box score changed — reload before correcting it.");
    if (!(await rebuildGameParticipants(tx, { gameId: game.id, expectedPlayers: players }))) {
      throw new UserFacingError("This box score changed — reload before correcting it.");
    }
    await raceHook("gameIdentity.beforeAudit");
    await tx.adminAction.create({ data: {
      actorId: actor.id, actorName: actor.name, seasonId: game.match.seasonId,
      action: "correctGameIdentity",
      summary: `Corrected player line ${input.sourceLineIndex + 1} in Dota game ${game.dotaMatchId}: ${reason}`,
      detailsJson: JSON.stringify({ version: 1, gameId: game.id, matchId: game.matchId,
        dotaMatchId: game.dotaMatchId, sourceLineIndex: input.sourceLineIndex,
        before: { userId: before.userId, teamId: before.teamId,
          ...Object.fromEntries(provenanceKeys.flatMap((key) => before[key] === undefined ? [] : [[key, before[key]]])) },
        after: { userId: input.userId, teamId: input.teamId,
          ...Object.fromEntries(provenanceKeys.flatMap((key) => after[key] === undefined ? [] : [[key, after[key]]])) }, reason }),
    } });
    await markWeekHonorsStale(tx, game.match.seasonId, game.match.week);
    await stampResultChange(tx);
    return { gameId: game.id, matchId: game.matchId, seasonId: game.match.seasonId, changed: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
