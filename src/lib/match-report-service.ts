import { prisma } from "./prisma";
import { MATCH_STATUS } from "./constants";
import { parseMatchId } from "./dota";
import { autoDetectGamesForMatch, importGameForMatch } from "./match-import";

// Captain-scoped result reporting (reschedule-service pattern: guards live
// here so they're integration-testable; src/app/actions/match-report.ts adds
// auth, cache busting, and toasts). Captains of an unplayed match can pull
// their finished game straight from OpenDota instead of waiting on an admin —
// standings, the bracket, fantasy, pick'em, and honors all move the moment the
// game ends. Import-only: manual score entry stays admin-only (recordResult).
// The abuse surface is small — classifyGame is roster-strict (the fetched game
// must really be these two teams) and Game.dotaMatchId dedupes re-imports.

export type ReportResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** Throws unless the viewer captains one of the match's teams and it's unplayed. */
async function requireMatchCaptain(
  viewerId: string,
  matchId: string,
): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true,
      homeTeam: { select: { captainId: true } },
      awayTeam: { select: { captainId: true } },
    },
  });
  if (!match) throw new Error("Match not found");
  if (match.status === MATCH_STATUS.COMPLETED) {
    throw new Error(
      "This match is already recorded — ask an admin to amend it",
    );
  }
  if (
    match.homeTeam.captainId !== viewerId &&
    match.awayTeam.captainId !== viewerId
  ) {
    throw new Error("Only the two captains can report this match");
  }
}

/** A captain imports a specific finished game by Dota match id/URL. */
export async function reportImportGame(
  viewerId: string,
  matchId: string,
  dotaRef: string,
): Promise<ReportResult> {
  await requireMatchCaptain(viewerId, matchId);
  const dotaMatchId = parseMatchId(dotaRef);
  if (!dotaMatchId) return { ok: false, error: "Enter a valid match id or URL" };
  const res = await importGameForMatch(matchId, dotaMatchId);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, message: "Game imported — result recorded" };
}

/** A captain scans both rosters' recent games and imports what matches. */
export async function reportAutoDetect(
  viewerId: string,
  matchId: string,
): Promise<ReportResult> {
  await requireMatchCaptain(viewerId, matchId);
  const res = await autoDetectGamesForMatch(matchId);
  if (res.error) return { ok: false, error: res.error };
  return {
    ok: true,
    message: `Scanned ${res.scanned} players · imported ${res.imported} game(s)`,
  };
}
