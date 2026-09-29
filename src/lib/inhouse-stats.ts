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

/**
 * Map a prisma lobby row (include- or select-shaped) into a FinishedLobby.
 * The three call sites deliberately run DIFFERENT queries (windowed vs
 * unwindowed, include vs select) — only the mapping is shared, so a field
 * added to FinishedLobby needs exactly one edit here.
 */
export function toFinishedLobby(l: {
  id: string;
  winnerTeam: number | null;
  createdAt: Date;
  players: {
    userId: string;
    team: number | null;
    user: { name: string; avatar: string | null };
  }[];
}): FinishedLobby {
  return {
    id: l.id,
    winnerTeam: l.winnerTeam,
    createdAt: l.createdAt,
    players: l.players.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      avatar: p.user.avatar,
      team: p.team,
    })),
  };
}

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

export type RankedInhouse = {
  /** Established players (>= PROVISIONAL_GAMES), ladder order — rank = index+1. */
  ranked: InhouseRecord[];
  /** Under the games floor: listed after the ranked block, never medalled. */
  provisional: InhouseRecord[];
};

/**
 * Split a summarizeInhouse ladder into ranked vs provisional players. The
 * medals and "#N" ranks belong to established accounts only — a 1-game
 * player at 1016 must not sit above a 30-game grinder.
 */
export function rankInhouse(rows: InhouseRecord[]): RankedInhouse {
  return {
    ranked: rows.filter((r) => r.games >= PROVISIONAL_GAMES),
    provisional: rows.filter((r) => r.games < PROVISIONAL_GAMES),
  };
}

// ---------- The monthly form ladder ----------
//
// Career Elo is path-dependent from game one, so a newcomer can never catch a
// veteran on it. The month board is the race anyone can win: RECORD over the
// current calendar month (on the league's clock), reset on the 1st. It runs no
// Elo of its own. The net swing is the SUM of the per-lobby `eloDeltas` that
// finalization stamped, i.e. exactly what each post-game banner showed. That
// is a fact about the moment each game finished: a later void of an EARLIER
// game recomputes the career ladder but never restates those stamps.

/** Games in the month before a player gets a rank on the monthly board. */
export const MONTH_MIN_GAMES = 3;

/**
 * Parse a stored `InhouseLobby.eloDeltas` JSON map (userId → Elo swing).
 * Anything that isn't a finite number is dropped rather than trusted, and
 * unreadable JSON is an empty map: a missing swing must read as MISSING, not
 * as a zero.
 */
export function parseEloDeltas(
  json: string | null | undefined,
): Record<string, number> {
  try {
    const value: unknown = JSON.parse(json ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export type MonthLobby = {
  id: string;
  winnerTeam: number | null;
  /** The immutable result clock. null = pre-completedAt history (never counts). */
  completedAt: Date | number | null;
  /** Parsed `eloDeltas` (see parseEloDeltas). */
  eloDeltas: Record<string, number>;
  players: FinishedLobby["players"];
};

/** Map a prisma lobby row into a MonthLobby (the toFinishedLobby pattern). */
export function toMonthLobby(l: {
  id: string;
  winnerTeam: number | null;
  completedAt: Date | null;
  eloDeltas: string;
  players: {
    userId: string;
    team: number | null;
    user: { name: string; avatar: string | null };
  }[];
}): MonthLobby {
  return {
    id: l.id,
    winnerTeam: l.winnerTeam,
    completedAt: l.completedAt,
    eloDeltas: parseEloDeltas(l.eloDeltas),
    players: l.players.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      avatar: p.user.avatar,
      team: p.team,
    })),
  };
}

export type InhouseMonthRecord = {
  userId: string;
  name: string;
  avatar: string | null;
  games: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  /**
   * Summed stored Elo swings over the month's games. null when ANY counted
   * game has no swing recorded for this player (a finalization that never
   * stamped): a partial sum would read as the whole month.
   */
  eloNet: number | null;
};

export type InhouseMonthBoard = {
  /** >= MONTH_MIN_GAMES this month, board order — rank = index+1. */
  ranked: InhouseMonthRecord[];
  /** Under the floor: listed after the ranked block, never ranked. */
  unranked: InhouseMonthRecord[];
  /** Lobbies that counted (completed in the window, with a winner). */
  games: number;
};

/**
 * Wins, then win rate, then games, then userId: a TOTAL order, so two players
 * on an identical record never swap places between renders.
 */
function compareMonth(a: InhouseMonthRecord, b: InhouseMonthRecord): number {
  return (
    b.wins - a.wins ||
    b.winRate - a.winRate ||
    b.games - a.games ||
    (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
  );
}

/**
 * Roll the lobbies that COMPLETED inside [startMs, endMs) into the monthly
 * board. Same counting rules as summarizeInhouse (a reported winner, players
 * with an assigned side), keyed on `completedAt` because a month is about when
 * results landed, never `createdAt` (formation) or `updatedAt` (the settlement
 * retry cursor).
 */
export function summarizeInhouseMonth(
  lobbies: MonthLobby[],
  window: { startMs: number; endMs: number },
): InhouseMonthBoard {
  const inWindow = lobbies
    .flatMap((l) => {
      if (l.completedAt == null) return [];
      const at = toMs(l.completedAt);
      return at >= window.startMs && at < window.endMs ? [{ l, at }] : [];
    })
    // Oldest first, so the freshest display name wins (summarizeInhouse's rule).
    .sort((a, b) => a.at - b.at || (a.l.id < b.l.id ? -1 : 1))
    .map(({ l }) => l);

  type Acc = Omit<InhouseMonthRecord, "winRate" | "eloNet"> & {
    eloNet: number;
    eloKnown: boolean;
  };
  const byUser = new Map<string, Acc>();
  let games = 0;

  for (const lobby of inWindow) {
    if (lobby.winnerTeam !== 1 && lobby.winnerTeam !== 2) continue;
    games += 1;
    for (const pl of lobby.players) {
      if (pl.team !== 1 && pl.team !== 2) continue;
      const rec =
        byUser.get(pl.userId) ??
        ({
          userId: pl.userId,
          name: pl.name,
          avatar: pl.avatar,
          games: 0,
          wins: 0,
          losses: 0,
          eloNet: 0,
          eloKnown: true,
        } satisfies Acc);
      rec.name = pl.name;
      rec.avatar = pl.avatar;
      rec.games += 1;
      if (pl.team === lobby.winnerTeam) rec.wins += 1;
      else rec.losses += 1;
      const swing = lobby.eloDeltas[pl.userId];
      if (typeof swing === "number" && Number.isFinite(swing)) {
        rec.eloNet += swing;
      } else {
        rec.eloKnown = false;
      }
      byUser.set(pl.userId, rec);
    }
  }

  const rows = [...byUser.values()]
    .map(
      ({ eloKnown, eloNet, ...r }): InhouseMonthRecord => ({
        ...r,
        winRate: r.games > 0 ? r.wins / r.games : 0,
        eloNet: eloKnown ? Math.round(eloNet) : null,
      }),
    )
    .sort(compareMonth);

  return {
    ranked: rows.filter((r) => r.games >= MONTH_MIN_GAMES),
    unranked: rows.filter((r) => r.games < MONTH_MIN_GAMES),
    games,
  };
}
