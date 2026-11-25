// Grades an inhouse game again once OpenDota has parsed its replay (the
// schedule and the merge are pure, in inhouse-regrade.ts). Worker-only: the
// automation pass runs one due check at most, with the OpenDota call outside
// any transaction and every precondition re-asserted in the write.

import { INHOUSE_STATUS } from "./constants";
import {
  canStartOpenDotaFetch,
  fetchOpenDotaMatch,
  type OpenDotaFetchOptions,
} from "./dota";
import { isGradedBox, parseInhouseBox } from "./inhouse-box";
import { gradeInhouseResult } from "./inhouse-grade-service";
import {
  INHOUSE_REGRADE_PREFIX,
  inhouseRegradeDueAtMs,
  inhouseRegradeValue,
  needsInhouseRegrade,
  parseInhouseRegrade,
  withParsedStats,
  type InhouseRegradeMarker,
} from "./inhouse-regrade";
import { publishInhouseRoomChange } from "./inhouse-room-version";
import { prisma } from "./prisma";
import { raceHook } from "./race-hook";
import { stampResultChange } from "./settings";

export type InhouseRegradeOutcome =
  /** Nothing due, or no time left to ask OpenDota. */
  | "idle"
  /** The replay is in: the game was graded again. */
  | "regraded"
  /** Still unparsed (or OpenDota unreachable): the next check is booked. */
  | "waiting"
  /** The last check found no replay: the game keeps its partial grade. */
  | "gave-up"
  /** The marker no longer applies (voided, re-recorded, already full). */
  | "dropped"
  /** A rival changed the game or the marker first; the next pass decides. */
  | "lost";

type MarkerRow = { key: string; value: string };

/** Delete exactly the marker this pass read, never a newer one. */
async function dropMarker(row: MarkerRow): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: row.key, value: row.value } });
}

/** Book the next check, or give up after the last one. */
async function nextCheck(
  row: MarkerRow,
  marker: InhouseRegradeMarker,
): Promise<"waiting" | "gave-up" | "lost"> {
  const after = { ...marker, tries: marker.tries + 1 };
  await raceHook("inhouse.regradeInhouseGame.beforeNextCheck");
  if (inhouseRegradeDueAtMs(after) === null) {
    await dropMarker(row);
    return "gave-up";
  }
  const value = inhouseRegradeValue(after);
  const booked = await prisma.setting.updateMany({
    where: { key: row.key, value: row.value },
    data: { value },
  });
  return booked.count === 0 ? "lost" : "waiting";
}

/**
 * The earliest due re-grade check, run once: re-read the game, ask OpenDota,
 * and when the replay is parsed, grade the game again with every stat and
 * swap the box score in only if it is still the one this pass read.
 */
export async function regradeDueInhouseGame(
  nowMs: number,
  options: OpenDotaFetchOptions = {},
): Promise<InhouseRegradeOutcome> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: INHOUSE_REGRADE_PREFIX } },
    orderBy: { key: "asc" },
    take: 100,
    select: { key: true, value: true },
  });
  let due: { row: MarkerRow; marker: InhouseRegradeMarker; at: number } | null =
    null;
  for (const row of rows) {
    const marker = parseInhouseRegrade(row.key, row.value);
    const at = marker ? inhouseRegradeDueAtMs(marker) : null;
    if (!marker || at === null) {
      // Malformed or spent: nothing can ever run it.
      await dropMarker(row);
      return "dropped";
    }
    if (at <= nowMs && (!due || at < due.at)) due = { row, marker, at };
  }
  if (!due) return "idle";
  const { row, marker } = due;

  const lobby = await prisma.inhouseLobby.findUnique({
    where: { id: marker.lobbyId },
    select: {
      status: true,
      dotaMatchId: true,
      boxScore: true,
      winnerTeam: true,
      radiantTeam: true,
      durationSecs: true,
    },
  });
  const box = lobby ? parseInhouseBox(lobby.boxScore) : [];
  if (
    !lobby ||
    lobby.status !== INHOUSE_STATUS.COMPLETED ||
    lobby.dotaMatchId !== marker.dotaMatchId ||
    lobby.winnerTeam == null ||
    lobby.radiantTeam == null ||
    lobby.durationSecs == null ||
    !needsInhouseRegrade(box)
  ) {
    await dropMarker(row);
    return "dropped";
  }
  if (!canStartOpenDotaFetch(options)) return "idle";

  const od = await fetchOpenDotaMatch(marker.dotaMatchId, options);
  const lines =
    od && String(od.match_id) === marker.dotaMatchId
      ? withParsedStats(box, od)
      : null;
  if (!lines) return nextCheck(row, marker);
  const regraded = await gradeInhouseResult(marker.lobbyId, {
    boxScore: lines,
    winnerTeam: lobby.winnerTeam,
    radiantTeam: lobby.radiantTeam,
    durationSecs: lobby.durationSecs,
  });
  // Grading failed (it returns the lines ungraded): keep the stored grade.
  if (!isGradedBox(regraded) || needsInhouseRegrade(regraded)) {
    return nextCheck(row, marker);
  }
  const boxScore = JSON.stringify(regraded);

  // Seam: OpenDota answered and the new grade is built; nothing is written.
  // A void, a new result or another pass may land here.
  await raceHook("inhouse.regradeInhouseGame.beforeWrite");

  const wrote = await prisma.$transaction(async (tx) => {
    const claim = await tx.inhouseLobby.updateMany({
      where: {
        id: marker.lobbyId,
        status: INHOUSE_STATUS.COMPLETED,
        dotaMatchId: marker.dotaMatchId,
        boxScore: lobby.boxScore,
      },
      data: { boxScore },
    });
    // The only write so far: a refusal may return.
    if (claim.count === 0) return false;
    await tx.setting.deleteMany({ where: { key: row.key } });
    await stampResultChange(tx);
    return true;
  });
  if (!wrote) return "lost";
  // Rule P: the room's result card shows the new grades.
  await publishInhouseRoomChange();
  return "regraded";
}
