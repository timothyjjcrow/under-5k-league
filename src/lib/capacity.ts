// Pure signup-capacity math, split out so it can be unit-tested without pulling
// in the Prisma client.

export type CapacityInfo = {
  perTeam: number;
  minPlayers: number;
  teamsFormable: number;
  canDraft: boolean;
  needed: number;
  /**
   * Signups past `minPlayers`. `minTeams` is a FLOOR, not a cap — nothing
   * refuses a signup once it's reached (`registrationGate` only checks the MMR
   * ceiling and that the season is in SIGNUPS), and `startDraft` forms one team
   * per CAPTAIN, so extra players become extra teams. The UI has to say so:
   * "31 / 30 players to start" over a pegged progress bar reads as full, and
   * the 31st player is the one who has to decide from it whether to bother.
   */
  extra: number;
  /** Players past the last FULL team — the odd bodies a draft can't seat. */
  leftover: number;
  /**
   * How many more signups round the pool up to another full team. Never 0: at
   * an exact multiple it's a whole `perTeam`, because the question it answers
   * is always "how many more for one MORE team".
   */
  toNextTeam: number;
};

/**
 * Given a season config and how many active players have signed up, tell the UI
 * whether a draft can begin, how many more players are needed to reach the
 * MINIMUM, and — past it — how far the pool is from the next whole team.
 */
export function capacityInfo(
  season: { teamSize: number; minTeams: number },
  playerCount: number,
): CapacityInfo {
  const perTeam = season.teamSize;
  const minPlayers = season.minTeams * perTeam;
  const teamsFormable = perTeam > 0 ? Math.floor(playerCount / perTeam) : 0;
  const leftover = perTeam > 0 ? playerCount % perTeam : 0;
  return {
    perTeam,
    minPlayers,
    teamsFormable,
    canDraft: playerCount >= minPlayers,
    needed: Math.max(0, minPlayers - playerCount),
    extra: Math.max(0, playerCount - minPlayers),
    leftover,
    toNextTeam: perTeam > 0 ? perTeam - leftover : 0,
  };
}
