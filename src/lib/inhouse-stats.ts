// Pure inhouse leaderboard math. Rolls completed lobbies up into per-player
// records so the /inhouse page can rank regulars. No DB here — testable.

export type FinishedLobby = {
  id: string;
  winnerTeam: number | null; // 1 | 2
  createdAt: Date | number; // ordering key; newest first is not assumed
  players: {
    userId: string;
    name: string;
    avatar: string | null;
    team: number | null; // 1 | 2
  }[];
};

export type InhouseRecord = {
  userId: string;
  name: string;
  avatar: string | null;
  games: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  streak: number; // +N win streak / -N loss streak (most recent games)
};

function toMs(v: Date | number): number {
  return typeof v === "number" ? v : v.getTime();
}

/**
 * Aggregate finished lobbies into ranked player records. Only lobbies with a
 * reported winner and players with an assigned team count. Sorted by wins, then
 * win rate, then games played.
 */
export function summarizeInhouse(lobbies: FinishedLobby[]): InhouseRecord[] {
  // Oldest → newest so streaks accumulate in chronological order.
  const chrono = [...lobbies].sort(
    (a, b) => toMs(a.createdAt) - toMs(b.createdAt),
  );

  type Acc = Omit<InhouseRecord, "winRate">;
  const byUser = new Map<string, Acc>();

  for (const lobby of chrono) {
    if (lobby.winnerTeam !== 1 && lobby.winnerTeam !== 2) continue;
    for (const pl of lobby.players) {
      if (pl.team !== 1 && pl.team !== 2) continue;
      const won = pl.team === lobby.winnerTeam;
      const rec =
        byUser.get(pl.userId) ??
        ({
          userId: pl.userId,
          name: pl.name,
          avatar: pl.avatar,
          games: 0,
          wins: 0,
          losses: 0,
          streak: 0,
        } satisfies Acc);
      rec.name = pl.name; // keep the freshest display name/avatar
      rec.avatar = pl.avatar;
      rec.games += 1;
      if (won) {
        rec.wins += 1;
        rec.streak = rec.streak > 0 ? rec.streak + 1 : 1;
      } else {
        rec.losses += 1;
        rec.streak = rec.streak < 0 ? rec.streak - 1 : -1;
      }
      byUser.set(pl.userId, rec);
    }
  }

  return [...byUser.values()]
    .map((r) => ({ ...r, winRate: r.games > 0 ? r.wins / r.games : 0 }))
    .sort(
      (a, b) =>
        b.wins - a.wins || b.winRate - a.winRate || b.games - a.games,
    );
}
