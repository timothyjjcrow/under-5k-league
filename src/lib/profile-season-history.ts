// A player's league seasons, read once for their profile and for its link
// picture, so the two can never disagree: every season they played in, were
// rostered in or stood in for, as the Seasons card's rows (profileSeasonRows,
// from three separate records, never today's roster), with each season's
// champion resolved the way every public page resolves it.

import { appearanceCareers } from "./appearance-careers";
import { resolveChampionPresentation } from "./champion-presentation";
import type { getRosterHistory } from "./player-roster-history";
import { prisma } from "./prisma";
import { profileSeasonRows, type ProfileSeasonRow } from "./profile-seasons";

type TeamRef = { id: string; name: string; logoUrl: string | null };
type MatchTeams = { seasonId: string; homeTeam: TeamRef; awayTeam: TeamRef };

export async function loadProfileSeasonRows(
  userId: string,
  input: {
    /** Games with a trusted line of theirs, each with its match's season and
     *  teams. */
    games: readonly {
      id: string;
      matchId: string;
      players: string;
      radiantWin: boolean;
      match: MatchTeams;
    }[];
    /** getRosterHistory(userId). */
    rosterHistory: Awaited<ReturnType<typeof getRosterHistory>>;
    /** Completed matches they were booked to cover. */
    covers: readonly { matchId: string; teamId: string; match: MatchTeams }[];
  },
): Promise<{
  rows: ProfileSeasonRow[];
  /** Every team those rows name, by id: its logo (null for none). */
  teamLogos: Map<string, string | null>;
}> {
  const { games, rosterHistory, covers } = input;
  const seasonIds = [
    ...new Set([
      ...games.map((game) => game.match.seasonId),
      ...rosterHistory.map((row) => row.seasonId),
      ...covers.map((cover) => cover.match.seasonId),
    ]),
  ];
  const [seasons, matches] = seasonIds.length
    ? await Promise.all([
        prisma.season.findMany({
          where: { id: { in: seasonIds } },
          select: {
            id: true,
            name: true,
            createdAt: true,
            status: true,
            championTeamId: true,
          },
        }),
        prisma.match.findMany({ where: { seasonId: { in: seasonIds } } }),
      ])
    : [[], []];
  const champions = new Map(
    seasons.flatMap((season) => {
      const teamId = resolveChampionPresentation(
        season,
        matches.filter((match) => match.seasonId === season.id),
      ).championTeamId;
      return teamId ? [[season.id, teamId] as const] : [];
    }),
  );
  const appearances = appearanceCareers(
    games,
    matches,
    [...champions].map(([seasonId, teamId]) => ({ seasonId, teamId })),
  ).rows.filter((row) => row.userId === userId);
  const teams = [
    ...games.flatMap((game) => [game.match.homeTeam, game.match.awayTeam]),
    ...covers.flatMap((cover) => [cover.match.homeTeam, cover.match.awayTeam]),
    ...rosterHistory.flatMap((row) =>
      row.teamId
        ? [{ id: row.teamId, name: row.teamName, logoUrl: row.teamLogoUrl }]
        : [],
    ),
  ];
  return {
    rows: profileSeasonRows({
      seasons: new Map(seasons.map((season) => [season.id, season])),
      appearances,
      tenures: rosterHistory,
      covers: covers.map((cover) => ({
        seasonId: cover.match.seasonId,
        teamId: cover.teamId,
        matchId: cover.matchId,
      })),
      teamNames: new Map(teams.map((team) => [team.id, team.name])),
      champions,
    }),
    teamLogos: new Map(teams.map((team) => [team.id, team.logoUrl ?? null])),
  };
}
