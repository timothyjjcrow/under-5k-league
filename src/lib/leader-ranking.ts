/** Competition placements: equal displayed values share a rank (1, 1, 3). */
export function competitionRanks(valuesDescending: number[]): number[] {
  let rank = 0;
  let previous: number | undefined;
  return valuesDescending.map((value, index) => {
    if (index === 0 || value !== previous) rank = index + 1;
    previous = value;
    return rank;
  });
}

export type ParticipationLine = {
  userId: string | null;
  isRadiant: boolean;
  kills: number;
  assists: number;
};

export type KillParticipation = {
  involved: number;
  teamKills: number;
  scoredGames: number;
  rate: number;
};

/**
 * Credit each player for the share of their team's kills they helped secure.
 * Count the whole team's kills, including unlinked players, as the denominator.
 * A scoreless game has no meaningful participation rate and is left out.
 */
export function killParticipationByPlayer(
  games: { lines: ParticipationLine[] }[],
): Map<string, KillParticipation> {
  const totals = new Map<string, KillParticipation>();
  for (const game of games) {
    const radiantKills = game.lines.reduce(
      (total, line) => total + (line.isRadiant ? line.kills : 0),
      0,
    );
    const direKills = game.lines.reduce(
      (total, line) => total + (line.isRadiant ? 0 : line.kills),
      0,
    );
    for (const line of game.lines) {
      if (!line.userId) continue;
      const teamKills = line.isRadiant ? radiantKills : direKills;
      if (teamKills === 0) continue;
      const previous = totals.get(line.userId) ?? {
        involved: 0,
        teamKills: 0,
        scoredGames: 0,
        rate: 0,
      };
      const involved =
        previous.involved + Math.min(teamKills, line.kills + line.assists);
      const allTeamKills = previous.teamKills + teamKills;
      totals.set(line.userId, {
        involved,
        teamKills: allTeamKills,
        scoredGames: previous.scoredGames + 1,
        rate: (involved / allTeamKills) * 100,
      });
    }
  }
  return totals;
}

export type LeaderIdentity = {
  name: string;
  avatar: string | null;
  rankTier: number | null;
  hasProfile: boolean;
};

/** Keep historical stat lines visible after their User row is removed. */
export function leaderIdentity(
  user:
    | { name: string; avatar: string | null; rankTier: number | null }
    | undefined,
): LeaderIdentity {
  return user
    ? { ...user, hasProfile: true }
    : {
        name: "Former player",
        avatar: null,
        rankTier: null,
        hasProfile: false,
      };
}
