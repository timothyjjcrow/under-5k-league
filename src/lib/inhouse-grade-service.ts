// Grades a finished inhouse game once, as its result lands, and returns the
// box score with each line's grade stamped on (player-grades.ts does the
// math). The MMR comparison reads the most recent completed games, so it is
// a database read, never a network call: applyResult runs it before its
// transaction opens.

import { INHOUSE_STATUS } from "./constants";
import { parseInhouseBox, type InhouseBoxPlayer } from "./inhouse-box";
import {
  baselineLinesOf,
  gradeGame,
  GRADE,
  type BaselineLine,
} from "./player-grades";
import { prisma } from "./prisma";

/** The recent games' lines that grades compare MMR against. */
async function loadGradeBaseline(excludeLobbyId: string): Promise<BaselineLine[]> {
  const recent = await prisma.inhouseLobby.findMany({
    where: { status: INHOUSE_STATUS.COMPLETED, id: { not: excludeLobbyId } },
    // createdAt, never completedAt: old rows have no completedAt, and
    // Postgres sorts NULLs first in a descending order.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: GRADE.BASELINE_GAMES,
    select: {
      boxScore: true,
      durationSecs: true,
      players: { select: { userId: true, mmr: true } },
    },
  });
  return recent.flatMap((lobby) => {
    const mmr = new Map(lobby.players.map((p) => [p.userId, p.mmr]));
    const lines = parseInhouseBox(lobby.boxScore).map((line) => ({
      ...line,
      mmr: line.userId ? mmr.get(line.userId) ?? null : null,
    }));
    return baselineLinesOf(lines, lobby.durationSecs);
  });
}

/**
 * The box score with every line graded, the MVP, the role award and the
 * highlights stamped on. Best-effort: a grading failure records the result
 * ungraded (its MVP then comes from impact points, as before grades), never
 * blocks it.
 */
export async function gradeInhouseResult(
  lobbyId: string,
  r: {
    boxScore: InhouseBoxPlayer[];
    winnerTeam: number;
    radiantTeam: number;
    durationSecs: number;
  },
): Promise<InhouseBoxPlayer[]> {
  if (r.boxScore.length === 0) return r.boxScore;
  try {
    const [players, baseline] = await Promise.all([
      prisma.inhouseLobbyPlayer.findMany({
        where: { lobbyId },
        select: { userId: true, mmr: true },
      }),
      loadGradeBaseline(lobbyId),
    ]);
    const grades = gradeGame(r.boxScore, {
      radiantWin: r.winnerTeam === r.radiantTeam,
      durationSecs: r.durationSecs,
      mmrByUser: new Map(players.map((p) => [p.userId, p.mmr])),
      baseline,
    });
    return r.boxScore.map((line, i) => ({ ...line, grade: grades[i] }));
  } catch {
    console.error("[inhouse-grades] grading failed (GRADE_FAILED)");
    return r.boxScore;
  }
}
