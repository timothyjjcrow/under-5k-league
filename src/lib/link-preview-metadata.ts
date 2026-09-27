// generateMetadata for pages whose link preview names the season or the
// fixture. Each loader reads only what its preview needs: request-cached
// reads the page itself also makes (the active season, Home's snapshot), or
// a few small rows. The sentences themselves live in link-preview.ts.

import type { Metadata } from "next";
import { prisma } from "./prisma";
import { getActiveSeason } from "./season";
import { getSessionUser } from "./auth";
import { getSeasonMatches, getSeasonSnapshot } from "./queries";
import { LEAGUE_CONFIG } from "./league-config";
import { shareMetadata } from "./share-metadata";
import { MATCH_PHASE, SEASON_STATUS } from "./constants";
import { resolveChampionPresentation } from "./champion-presentation";
import { groupPlayoffRounds, matchRoundLabel } from "./schedule";
import {
  homePreview,
  matchPreview,
  seasonPagePreview,
  type SeasonPage,
} from "./link-preview";

const SEASON_PAGE_PATHS: Record<SeasonPage, string> = {
  schedule: "/schedule",
  teams: "/teams",
  players: "/players",
  draft: "/draft",
};

/**
 * Home: "Copy invite link" shares this page, so its preview carries the
 * season. The tab keeps the plain league name. Every read here is one Home's
 * page makes in the same request (its snapshot, and its match list once the
 * season is complete), so the preview adds no queries.
 */
export async function homeMetadata(): Promise<Metadata> {
  const user = await getSessionUser();
  const snapshot = await getSeasonSnapshot(user?.id);
  const season = snapshot?.season;
  const preview = homePreview(
    snapshot && season
      ? {
          name: season.name,
          status: season.status,
          draftStatus: snapshot.draftStatus,
          playerCount: snapshot.playerCount,
          draftAt: season.draftAt,
          matchSchedule: season.matchSchedule,
          championName:
            season.status === SEASON_STATUS.COMPLETE
              ? await championName(season, snapshot.teams)
              : null,
        }
      : null,
    Date.now(),
  );
  return {
    ...shareMetadata(preview.title, preview.description, "/"),
    title: { absolute: LEAGUE_CONFIG.name },
  };
}

/**
 * The champion Home may name, by the resolver Home's page uses: the bracket
 * must agree with the season row.
 */
async function championName(
  season: { id: string; status: string; championTeamId: string | null },
  teams: readonly { id: string; name: string }[],
): Promise<string | null> {
  if (!season.championTeamId) return null;
  const { championTeamId } = resolveChampionPresentation(
    season,
    await getSeasonMatches(season.id),
  );
  return teams.find((team) => team.id === championTeamId)?.name ?? null;
}

/** Schedule, Teams, Players and Draft: the page's name and the season. */
export async function seasonPageMetadata(page: SeasonPage): Promise<Metadata> {
  const season = await getActiveSeason();
  const preview = seasonPagePreview(
    page,
    season
      ? { name: season.name, status: season.status, draftAt: season.draftAt }
      : null,
    Date.now(),
  );
  return shareMetadata(
    preview.title,
    preview.description,
    SEASON_PAGE_PATHS[page],
  );
}

/**
 * A match: its round, teams and kickoff or result. Null when there is no such
 * match (the page's generateMetadata turns that into a real 404).
 */
export async function matchMetadata(id: string): Promise<Metadata | null> {
  const match = await prisma.match.findUnique({
    where: { id },
    select: {
      seasonId: true,
      week: true,
      phase: true,
      bracketSlot: true,
      bestOf: true,
      status: true,
      homeScore: true,
      awayScore: true,
      winnerTeamId: true,
      forfeit: true,
      scheduledAt: true,
      homeTeamId: true,
      awayTeamId: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      season: { select: { name: true } },
    },
  });
  if (!match) return null;
  // A playoff round's name depends on the bracket's depth.
  const bracket =
    match.phase === MATCH_PHASE.PLAYOFF || match.phase === MATCH_PHASE.FINAL
      ? await prisma.match.findMany({
          where: {
            seasonId: match.seasonId,
            phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
          },
          select: { phase: true, bracketSlot: true },
        })
      : [];
  const preview = matchPreview({
    round: matchRoundLabel(match, groupPlayoffRounds(bracket).totalRounds),
    seasonName: match.season.name,
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    homeName: match.homeTeam.name,
    awayName: match.awayTeam.name,
    status: match.status,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    winnerTeamId: match.winnerTeamId,
    forfeit: match.forfeit,
    scheduledAt: match.scheduledAt,
    bestOf: match.bestOf,
  });
  return shareMetadata(preview.title, preview.description);
}
