// Pure signup-capacity math, split out so it can be unit-tested without pulling
// in the Prisma client.

export type CapacityInfo = {
  perTeam: number;
  minPlayers: number;
  teamsFormable: number;
  canDraft: boolean;
  needed: number;
};

/**
 * Given a season config and how many active players have signed up, tell the UI
 * whether a draft can begin and how many more players are needed.
 */
export function capacityInfo(
  season: { teamSize: number; minTeams: number },
  playerCount: number,
): CapacityInfo {
  const perTeam = season.teamSize;
  const minPlayers = season.minTeams * perTeam;
  const teamsFormable = Math.floor(playerCount / perTeam);
  return {
    perTeam,
    minPlayers,
    teamsFormable,
    canDraft: playerCount >= minPlayers,
    needed: Math.max(0, minPlayers - playerCount),
  };
}
