// The two right-hand tiles in /fantasy's summary row. Before rosters lock
// they describe the pick window: the pool to choose from and the salary cap.
// After the lock nobody can choose anyone, so they report the season instead.

export type FantasyTile = { label: string; value: string; hint: string };

type Scored = { name: string; points: number };

export function fantasyWindowTiles(input: {
  locked: boolean;
  /** Drafted players a manager can pick. */
  poolSize: number;
  /** The salary cap; 0 when no player has a rating (fantasyCap). */
  cap: number;
  /** The viewer's place in the standings, when they entered. */
  mine: { rank: number; points: number } | null;
  /** First place in the standings, when anyone entered. */
  leader: Scored | null;
  /** The league player with the most points, once any game is scored. */
  topPlayer: Scored | null;
  /** League players with at least one scored game. */
  playersScored: number;
}): [FantasyTile, FantasyTile] {
  if (!input.locked) {
    return [
      {
        label: "Draft pool",
        value: String(input.poolSize),
        hint: "Players to choose from",
      },
      input.cap > 0
        ? {
            label: "Salary cap",
            value: input.cap.toLocaleString(),
            hint: "MMR across five players",
          }
        : { label: "Salary cap", value: "Open", hint: "No ratings available" },
    ];
  }
  const top: FantasyTile = input.topPlayer
    ? {
        label: "Top player",
        value: String(input.topPlayer.points),
        hint: `${input.topPlayer.name}'s points`,
      }
    : { label: "Top player", value: "—", hint: "No games scored yet" };
  const second: FantasyTile = input.mine
    ? {
        label: "Your rank",
        value: `#${input.mine.rank}`,
        hint: `${input.mine.points} points`,
      }
    : input.leader && input.leader.points > 0
      ? {
          label: "Leader",
          value: String(input.leader.points),
          hint: `${input.leader.name}'s points`,
        }
      : {
          label: "Players scored",
          value: String(input.playersScored),
          hint: "Played in a scored game",
        };
  return [top, second];
}
