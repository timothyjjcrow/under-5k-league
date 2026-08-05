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
