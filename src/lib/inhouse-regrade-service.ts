// Grades an inhouse game again once OpenDota has parsed its replay (the
// schedule and the merge are pure, in inhouse-regrade.ts). Worker-only: the
// automation pass runs one due check at most, with the OpenDota call outside
// any transaction and every precondition re-asserted in the write. Once the
// new grades commit, the game's Discord result post is edited in place.

import { INHOUSE_STATUS } from "./constants";
import { editInhouseResultMessage } from "./discord";
import {
  canStartOpenDotaFetch,
  fetchOpenDotaMatch,
  type OpenDotaFetchOptions,
} from "./dota";
import {
  INHOUSE_ANNOUNCEMENT_KIND,
  inhouseResultAnnouncementContent,
} from "./inhouse-announcement-outbox";
import {
  isGradedBox,
  parseInhouseBox,
  type InhouseBoxPlayer,
} from "./inhouse-box";
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

type ResultLobby = {
  winnerTeam: number;
  radiantTeam: number;
  radiantScore: number | null;
  direScore: number | null;
  durationSecs: number;
};

const minutesSince = (atMs: number, nowMs: number) =>
  Math.max(0, Math.round((nowMs - atMs) / 60_000));

/** The Discord result post's text for this box score. */
function postContent(
  marker: InhouseRegradeMarker,
  lobby: ResultLobby,
  boxScore: InhouseBoxPlayer[],
  early?: boolean,
): string {
  return inhouseResultAnnouncementContent({
    winnerTeam: lobby.winnerTeam,
    radiantTeam: lobby.radiantTeam,
    radiantScore: lobby.radiantScore ?? 0,
    direScore: lobby.direScore ?? 0,
    durationSecs: lobby.durationSecs,
    dotaMatchId: marker.dotaMatchId,
    boxScore,
    lobbyId: marker.lobbyId,
    early,
  });
}

/**
 * Rewrite the game's Discord result post in place. Best-effort and after
 * every commit: an edit Discord refuses leaves the early post standing.
 */
async function editResultPost(messageId: string | null, content: string) {
  if (!messageId) return;
  try {
    const edited = await editInhouseResultMessage(messageId, content);
    if (edited !== "ok") {
      console.error(
        `[inhouse-regrade] editing the result post failed (${edited === "gone" ? "POST_GONE" : "EDIT_FAILED"})`,
      );
    }
  } catch {
    console.error("[inhouse-regrade] editing the result post failed (EDIT_FAILED)");
  }
}

/** Delete exactly the marker this pass read, never a newer one. */
async function dropMarker(row: MarkerRow): Promise<boolean> {
  const dropped = await prisma.setting.deleteMany({
    where: { key: row.key, value: row.value },
  });
  return dropped.count === 1;
}

/** Book the next check, or give up after the last one. */
async function nextCheck(
  row: MarkerRow,
  marker: InhouseRegradeMarker,
  lobby: ResultLobby & { boxScore: InhouseBoxPlayer[] },
  nowMs: number,
): Promise<"waiting" | "gave-up" | "lost"> {
  const after = { ...marker, tries: marker.tries + 1 };
  await raceHook("inhouse.regradeInhouseGame.beforeNextCheck");
  if (inhouseRegradeDueAtMs(after) === null) {
    if (!(await dropMarker(row))) return "lost";
    console.info(
      `[inhouse-regrade] no parsed replay after ${minutesSince(marker.resultAtMs, nowMs)} min, kept the early grade`,
    );
    // The early grade is now the game's grade: drop "so far" from the post.
    await editResultPost(
      marker.messageId,
      postContent(marker, lobby, lobby.boxScore, false),
    );
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

  const stored = await prisma.inhouseLobby.findUnique({
    where: { id: marker.lobbyId },
    select: {
      status: true,
      dotaMatchId: true,
      boxScore: true,
      winnerTeam: true,
      radiantTeam: true,
      radiantScore: true,
      direScore: true,
      durationSecs: true,
    },
  });
  const box = stored ? parseInhouseBox(stored.boxScore) : [];
  if (
    !stored ||
    stored.status !== INHOUSE_STATUS.COMPLETED ||
    stored.dotaMatchId !== marker.dotaMatchId ||
    stored.winnerTeam == null ||
    stored.durationSecs == null ||
    !needsInhouseRegrade(box)
  ) {
    await dropMarker(row);
    return "dropped";
  }
  const lobby = {
    winnerTeam: stored.winnerTeam,
    radiantTeam: stored.radiantTeam,
    radiantScore: stored.radiantScore,
    direScore: stored.direScore,
    durationSecs: stored.durationSecs,
    boxScore: box,
  };
  if (!canStartOpenDotaFetch(options)) return "idle";

  const od = await fetchOpenDotaMatch(marker.dotaMatchId, options);
  const lines =
    od && String(od.match_id) === marker.dotaMatchId
      ? withParsedStats(box, od)
      : null;
  if (!lines) return nextCheck(row, marker, lobby, nowMs);
  const graded = await gradeInhouseResult(marker.lobbyId, {
    boxScore: lines,
    winnerTeam: lobby.winnerTeam,
    radiantTeam: lobby.radiantTeam,
    durationSecs: lobby.durationSecs,
  });
  // Grading failed (it returns the lines ungraded): keep the stored grade.
  if (!isGradedBox(graded) || needsInhouseRegrade(graded)) {
    return nextCheck(row, marker, lobby, nowMs);
  }
  // Marked, so the site can say these grades came with the replay.
  const regraded: InhouseBoxPlayer[] = graded.map((line) =>
    line.grade
      ? { ...line, grade: { ...line.grade, regraded: true as const } }
      : line,
  );
  const boxScore = JSON.stringify(regraded);
  const content = postContent(marker, lobby, regraded);

  // Seam: OpenDota answered and the new grade is built; nothing is written.
  // A void, a new result or another pass may land here.
  await raceHook("inhouse.regradeInhouseGame.beforeWrite");

  const wrote = await prisma.$transaction(async (tx) => {
    const claim = await tx.inhouseLobby.updateMany({
      where: {
        id: marker.lobbyId,
        status: INHOUSE_STATUS.COMPLETED,
        dotaMatchId: marker.dotaMatchId,
        boxScore: stored.boxScore,
      },
      data: { boxScore },
    });
    // The only write so far: a refusal may return.
    if (claim.count === 0) return { ok: false as const };
    // The outbox may have kept the post's id since this pass read the marker.
    const current = await tx.setting.findUnique({ where: { key: row.key } });
    const messageId =
      (current && parseInhouseRegrade(current.key, current.value)?.messageId) ??
      null;
    await tx.setting.deleteMany({ where: { key: row.key } });
    // An unsent post (Discord down since the result) goes out with the final
    // grades; a sent one keeps this text as the record of the edit below.
    const post = await tx.inhouseAnnouncement.findFirst({
      where: {
        lobbyId: marker.lobbyId,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
      },
      select: { id: true },
    });
    if (post) {
      await tx.inhouseAnnouncement.updateMany({
        where: { id: post.id },
        data: { content },
      });
    }
    await stampResultChange(tx);
    return { ok: true as const, messageId };
  });
  if (!wrote.ok) return "lost";
  console.info(
    `[inhouse-regrade] regraded with the replay at check ${marker.tries + 1}, ${minutesSince(marker.resultAtMs, nowMs)} min after the result`,
  );
  // Rule P: the room's result card shows the new grades.
  await publishInhouseRoomChange();
  await editResultPost(wrote.messageId, content);
  return "regraded";
}
