import { createHash } from "node:crypto";

export type PlayoffCommandIntent = "start" | "reset";

type RevisionSeason = {
  id: string;
  status: string;
  playoffBestOf: number;
  finalBestOf: number;
  firstMatchNight: Date | null;
};

type RevisionTeam = { id: string; withdrawn: boolean };

type RevisionMatch = {
  id: string;
  week: number;
  phase: string;
  status: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  forfeit: boolean;
  bracketSlot: string | null;
  bestOf: number;
  scheduledAt: Date | null;
  games: { id: string; dotaMatchId: string }[];
  availability: { id: string; userId: string; status: string }[];
  standins: {
    id: string;
    teamId: string;
    standinUserId: string;
    replacingUserId: string | null;
  }[];
  predictions: { id: string; userId: string; pickedTeamId: string }[];
  reschedules: {
    id: string;
    proposedById: string;
    proposedTime: Date;
    status: string;
  }[];
};

/**
 * Content-addressed claim for every input that can change playoff seeding or
 * make a reset delete different data. The value is safe to place in a hidden
 * form field; it is not an authorization token, and the server recomputes it
 * inside the Serializable command before writing anything.
 */
export function playoffSetupRevision(input: {
  season: RevisionSeason;
  teams: RevisionTeam[];
  matches: RevisionMatch[];
}): string {
  const season = {
    id: input.season.id,
    status: input.season.status,
    playoffBestOf: input.season.playoffBestOf,
    finalBestOf: input.season.finalBestOf,
    firstMatchNight: input.season.firstMatchNight?.toISOString() ?? null,
  };
  const teams = input.teams
    .map((team) => ({ id: team.id, withdrawn: !!team.withdrawn }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const matches = input.matches
    .map((match) => ({
      id: match.id,
      week: match.week,
      phase: match.phase,
      status: match.status,
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      winnerTeamId: match.winnerTeamId,
      forfeit: match.forfeit,
      bracketSlot: match.bracketSlot,
      bestOf: match.bestOf,
      scheduledAt: match.scheduledAt?.toISOString() ?? null,
      games: [...match.games]
        .map((game) => ({ id: game.id, dotaMatchId: game.dotaMatchId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      // Only postseason dependents are teardown inputs. Regular-season RSVPs,
      // picks, cover, and proposals survive every playoff command and should
      // not make a harmless match-night update stale an admin's Start form.
      dependents:
        match.phase === "REGULAR"
          ? null
          : {
              availability: [...match.availability]
                .map((row) => ({
                  id: row.id,
                  userId: row.userId,
                  status: row.status,
                }))
                .sort((a, b) => a.id.localeCompare(b.id)),
              standins: [...match.standins]
                .map((row) => ({
                  id: row.id,
                  teamId: row.teamId,
                  standinUserId: row.standinUserId,
                  replacingUserId: row.replacingUserId,
                }))
                .sort((a, b) => a.id.localeCompare(b.id)),
              predictions: [...match.predictions]
                .map((row) => ({
                  id: row.id,
                  userId: row.userId,
                  pickedTeamId: row.pickedTeamId,
                }))
                .sort((a, b) => a.id.localeCompare(b.id)),
              reschedules: [...match.reschedules]
                .map((row) => ({
                  id: row.id,
                  proposedById: row.proposedById,
                  proposedTime: row.proposedTime.toISOString(),
                  status: row.status,
                }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return createHash("sha256")
    .update(JSON.stringify({ season, teams, matches }))
    .digest("hex");
}
