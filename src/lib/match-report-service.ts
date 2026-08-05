import { prisma } from "./prisma";
import { MATCH_STATUS } from "./constants";
import { parseMatchId } from "./dota";
import { autoDetectGamesForMatch, importGameForMatch } from "./match-import";
import { matchResultsOpen } from "./league-lifecycle";
import { UserFacingError } from "./user-facing-error";
import { claimProviderCooldown } from "./settings";

// Captain-scoped result reporting (reschedule-service pattern: guards live
// here so they're integration-testable; src/app/actions/match-report.ts adds
// auth, cache busting, and toasts). Captains of an unplayed match can pull
// their finished game straight from OpenDota instead of waiting on an admin —
// standings, the bracket, fantasy, pick'em, and honors all move the moment the
// game ends. Import-only: manual score entry stays admin-only (recordResult).
// The abuse surface is small — classifyGame is roster-strict (the fetched game
// must really be these two teams) and Game.dotaMatchId dedupes re-imports.

export type ReportResult =
  { ok: true; message: string } | { ok: false; error: string };

/** Throws unless the viewer captains one of the match's teams and it's unplayed. */
async function requireMatchCaptain(
  viewerId: string,
  matchId: string,
): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true,
      phase: true,
      seasonId: true,
      season: { select: { isActive: true, status: true } },
      homeTeam: { select: { captainId: true } },
      awayTeam: { select: { captainId: true } },
    },
  });
  if (!match) throw new UserFacingError("Match not found");
  // The standin-service rule: an archived season's unplayed match keeps its
  // captains, and an import here still runs recomputeSeries → the bracket and
  // every cross-season board — silently rewriting a finished season's history.
  // Amending archives is deliberate admin work: reactivate the season and
  // move it back to the fixture's result phase first (then reseed playoffs if
  // a regular result changes). Neither captain nor admin import controls write
  // directly into an archived season.
  if (!match.season.isActive) {
    throw new UserFacingError(
      "This match belongs to an archived season — ask an admin to amend it",
    );
  }
  if (!matchResultsOpen(match.season.status, match.phase)) {
    throw new UserFacingError(
      "Results are locked for this fixture in the league's current phase",
    );
  }
  if (match.status === MATCH_STATUS.COMPLETED) {
    throw new UserFacingError(
      "This match is already recorded — ask an admin to amend it",
    );
  }
  if (
    match.homeTeam.captainId !== viewerId &&
    match.awayTeam.captainId !== viewerId
  ) {
    throw new UserFacingError("Only the two captains can report this match");
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
  if (!dotaMatchId)
    return { ok: false, error: "Enter a valid match id or URL" };
  const res = await importGameForMatch(matchId, dotaMatchId, {
    expectedCaptainId: viewerId,
    enforceFixtureWindow: true,
    providerActorId: viewerId,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    message:
      res.status === MATCH_STATUS.COMPLETED
        ? `Game imported — series final ${res.homeScore}–${res.awayScore}`
        : `Game imported — series ${res.homeScore}–${res.awayScore}; add the next game when it finishes`,
  };
}

/** A captain scans both rosters' recent games and imports what matches. */
export async function reportAutoDetect(
  viewerId: string,
  matchId: string,
): Promise<ReportResult> {
  await requireMatchCaptain(viewerId, matchId);
  // The captain/fixture/phase guard deliberately comes first: invalid direct
  // action calls cannot burn a real captain's durable provider allowance.
  // A Setting-row claim elects one caller across tabs and serverless instances.
  const claim = await claimProviderCooldown(
    "open-dota-match-scan",
    viewerId,
    matchId,
  );
  if (claim === "cooldown") {
    return {
      ok: false,
      error:
        "This match was auto-fetched recently — wait about three minutes before scanning it again, or add the Dota match ID directly.",
    };
  }
  if (claim === "unavailable") {
    return {
      ok: false,
      error:
        "Couldn't safely start the OpenDota scan — wait a minute and try again, or add the Dota match ID directly.",
    };
  }
  const res = await autoDetectGamesForMatch(matchId, {
    expectedCaptainId: viewerId,
  });
  if (res.error) return { ok: false, error: res.error };
  if (res.imported === 0 && res.unreachable) {
    return {
      ok: false,
      error:
        "Couldn't reach OpenDota for some players, so this scan proves nothing — wait about three minutes before trying again",
    };
  }
  const current =
    res.imported > 0
      ? await prisma.match.findUnique({
          where: { id: matchId },
          select: { homeScore: true, awayScore: true, status: true },
        })
      : null;
  return {
    ok: true,
    message:
      res.imported === 0
        ? `Scanned ${res.scanned} players · no matching games found yet. Check that players expose public match data, or add the Dota match ID.`
        : current?.status === MATCH_STATUS.COMPLETED
          ? `Imported ${res.imported} game(s) · series final ${current.homeScore}–${current.awayScore}`
          : `Imported ${res.imported} game(s) · series ${current?.homeScore ?? 0}–${current?.awayScore ?? 0}; add the next game when it finishes`,
  };
}
