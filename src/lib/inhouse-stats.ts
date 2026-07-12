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
  rating: number; // personal Elo, rounded for display
  peak: number; // highest rating ever held after a game
  /** Last ≤5 results, newest first (matches FormStrip's reading order). */
  form: ("W" | "L")[];
  /** Rounded Elo swing of the most recent rated game (0 before any). */
  lastChange: number;
};

// Personal Elo: everyone starts at 1000; each finished lobby moves every
// player on the winning side up and the losing side down by the same amount,
// based on the *average* rating of the two sides (standard team-Elo).
export const INHOUSE_ELO = { START: 1000, K: 32 } as const;

/** Ratings below this many games are provisional — the UI dims them. */
export const PROVISIONAL_GAMES = 5;

function toMs(v: Date | number): number {
  return typeof v === "number" ? v : v.getTime();
}

/**
 * Aggregate finished lobbies into ranked player records. Only lobbies with a
 * reported winner and players with an assigned team count. Sorted by rating,
 * then wins, then win rate.
 */
export function summarizeInhouse(lobbies: FinishedLobby[]): InhouseRecord[] {
  // Oldest → newest so streaks + Elo accumulate in chronological order.
  const chrono = [...lobbies].sort(
    (a, b) => toMs(a.createdAt) - toMs(b.createdAt),
  );

  type Acc = Omit<InhouseRecord, "winRate" | "rating" | "peak"> & {
    rating: number; // unrounded while accumulating
    peak: number;
    lastChange: number; // unrounded while accumulating
  };
  const byUser = new Map<string, Acc>();

  const getRec = (pl: FinishedLobby["players"][number]): Acc => {
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
        rating: INHOUSE_ELO.START,
        peak: INHOUSE_ELO.START,
        form: [],
        lastChange: 0,
      } satisfies Acc);
    rec.name = pl.name; // keep the freshest display name/avatar
    rec.avatar = pl.avatar;
    byUser.set(pl.userId, rec);
    return rec;
  };

  for (const lobby of chrono) {
    if (lobby.winnerTeam !== 1 && lobby.winnerTeam !== 2) continue;
    const sides: [Acc[], Acc[]] = [[], []];
    for (const pl of lobby.players) {
      if (pl.team !== 1 && pl.team !== 2) continue;
      sides[pl.team - 1].push(getRec(pl));
    }
    const [team1, team2] = sides;

    // Elo delta from the sides' average ratings (zero if a side is empty —
    // malformed lobby, nothing to rate against).
    let delta = 0;
    if (team1.length > 0 && team2.length > 0) {
      const avg = (t: Acc[]) => t.reduce((s, r) => s + r.rating, 0) / t.length;
      const expected1 = 1 / (1 + 10 ** ((avg(team2) - avg(team1)) / 400));
      const score1 = lobby.winnerTeam === 1 ? 1 : 0;
      delta = INHOUSE_ELO.K * (score1 - expected1); // team 1's change
    }

    for (const [idx, team] of sides.entries()) {
      const won = lobby.winnerTeam === idx + 1;
      const change = idx === 0 ? delta : -delta;
      for (const rec of team) {
        rec.games += 1;
        if (won) {
          rec.wins += 1;
          rec.streak = rec.streak > 0 ? rec.streak + 1 : 1;
        } else {
          rec.losses += 1;
          rec.streak = rec.streak < 0 ? rec.streak - 1 : -1;
        }
        const result: "W" | "L" = won ? "W" : "L";
        rec.form = [result, ...rec.form].slice(0, 5);
        rec.rating += change;
        rec.lastChange = change;
        if (rec.rating > rec.peak) rec.peak = rec.rating;
      }
    }
  }

  return [...byUser.values()]
    .map((r) => ({
      ...r,
      winRate: r.games > 0 ? r.wins / r.games : 0,
      rating: Math.round(r.rating),
      peak: Math.round(r.peak),
      lastChange: Math.round(r.lastChange),
    }))
    .sort(
      (a, b) =>
        b.rating - a.rating ||
        b.wins - a.wins ||
        b.winRate - a.winRate ||
        b.games - a.games,
    );
}
