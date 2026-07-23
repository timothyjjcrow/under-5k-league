import { INHOUSE } from "./constants";

// Pure inhouse-draft rules. All DB effects live in inhouse-service.ts; these
// functions just encode the "who captains / who picks next" math so they can be
// unit-tested in isolation (mirrors src/lib/draft.ts for the league auction).

export type Seedable = {
  userId: string;
  mmr: number;
  joinedAt: Date | number; // epoch ms or Date — earlier wins ties
};

function joinMs(v: Date | number): number {
  return typeof v === "number" ? v : v.getTime();
}

/**
 * Order players the way we seed a lobby: highest MMR first, ties broken by who
 * queued earliest (rewards waiting). Stable + deterministic so it's testable.
 */
export function seedOrder<T extends Seedable>(players: T[]): T[] {
  return [...players].sort(
    (a, b) => b.mmr - a.mmr || joinMs(a.joinedAt) - joinMs(b.joinedAt),
  );
}

// How a filled lobby decides its two captains. Players vote on this so it isn't
// always the same top-2 MMR pairing (see castVote / resolveCaptainVote).
export type CaptainMethod = "MMR" | "RECORD" | "VOTE";
export const CAPTAIN_METHODS: CaptainMethod[] = ["VOTE", "MMR", "RECORD"];

export type CaptainCandidate = Seedable & {
  nominations: number; // captain-votes received from teammates
  wins: number;
  winRate: number; // 0..1
  games: number;
};

// On a tie, lean toward the more variable methods (elect > record > mmr) so the
// lobby doesn't fall back to the same two players every game.
const METHOD_TIEBREAK: CaptainMethod[] = ["VOTE", "RECORD", "MMR"];

/** Winning captain-selection method from the cast ballots (defaults to MMR). */
export function tallyMethod(votes: CaptainMethod[]): CaptainMethod {
  if (votes.length === 0) return "MMR";
  const counts: Record<CaptainMethod, number> = { MMR: 0, RECORD: 0, VOTE: 0 };
  for (const v of votes) if (v in counts) counts[v] += 1;
  let best: CaptainMethod = "MMR";
  let bestN = -1;
  for (const m of METHOD_TIEBREAK) {
    if (counts[m] > bestN) {
      best = m;
      bestN = counts[m];
    }
  }
  return best;
}

/**
 * Rank candidates for captaincy by the winning method. The top two become
 * captains (index 0 = team 1 / Radiant, index 1 = team 2 / Dire). Every method
 * falls back to MMR then earliest-queued so the order is always total.
 */
export function orderCaptains(
  method: CaptainMethod,
  candidates: CaptainCandidate[],
): CaptainCandidate[] {
  const arr = [...candidates];
  if (method === "RECORD") {
    return arr.sort(
      (a, b) =>
        b.wins - a.wins ||
        b.winRate - a.winRate ||
        b.games - a.games ||
        b.mmr - a.mmr ||
        joinMs(a.joinedAt) - joinMs(b.joinedAt),
    );
  }
  if (method === "VOTE") {
    return arr.sort(
      (a, b) =>
        b.nominations - a.nominations ||
        b.mmr - a.mmr ||
        joinMs(a.joinedAt) - joinMs(b.joinedAt),
    );
  }
  return seedOrder(arr); // MMR
}

/**
 * Which team is on the clock to pick, given how many non-captain players each
 * side has drafted so far. Uses a SNAKE (balanced) draft starting with
 * `firstPickTeam`: the first pick is a single, then picks come in pairs and it
 * ends on a single —
 *
 *     F · OO · FF · OO · FF · …
 *
 * so for a 5v5 (8 picks) the order is F O O F F O O F. Strict back-and-forth
 * (F O F O …) instead hands the first team the better player at EVERY tier;
 * the snake gives the second team the next two after the first team's opener,
 * which equalises each side's summed pick position (18 vs 18 for a 5v5) — as
 * fair as a sequential draft gets. A full side is skipped (belt-and-braces:
 * the snake already fills both sides evenly), and we return null once both
 * rosters are full.
 */
export function nextPickTeam(
  team1Picks: number,
  team2Picks: number,
  teamSize: number = INHOUSE.TEAM_SIZE,
  firstPickTeam: 1 | 2 = INHOUSE.FIRST_PICK_TEAM,
): 1 | 2 | null {
  // A captain already fills one slot, so a side needs teamSize-1 draft picks.
  const slots = teamSize - 1;
  const team1Full = team1Picks >= slots;
  const team2Full = team2Picks >= slots;
  if (team1Full && team2Full) return null;
  if (team1Full) return 2;
  if (team2Full) return 1;

  const otherTeam: 1 | 2 = firstPickTeam === 1 ? 2 : 1;
  const totalPicks = team1Picks + team2Picks;
  // Snake pattern by 0-indexed pick number: n=0 → first team; thereafter picks
  // pair up (n=1,2 → other; n=3,4 → first; …). `floor((n+1)/2) % 2 === 0`
  // captures exactly that F,O,O,F,F,O,O,F,… cadence.
  const onFirstPick = Math.floor((totalPicks + 1) / 2) % 2 === 0;
  return onFirstPick ? firstPickTeam : otherTeam;
}

/** The draft is done once both teams have a full roster (captain + picks). */
export function isDraftComplete(
  team1Count: number,
  team2Count: number,
  teamSize: number = INHOUSE.TEAM_SIZE,
): boolean {
  return team1Count >= teamSize && team2Count >= teamSize;
}

/** How many more players still need to queue before a lobby forms. */
export function playersNeeded(
  queueSize: number,
  lobbySize: number = INHOUSE.LOBBY_SIZE,
): number {
  return Math.max(0, lobbySize - queueSize);
}

/**
 * How long the inhouse room should wait before its next state poll. Fast while
 * the viewer has skin in the game — in a lobby (ready check / vote / draft /
 * live) or waiting in the queue, where seconds decide accepts, votes and picks
 * — and slow when just spectating a page that only changes lazily. Anyone IN
 * the queue polls fast, so a filling queue and a forming lobby stay snappy for
 * the players who matter; a pure spectator drops to the idle rate. (Hidden-tab
 * pausing lives in the component — it needs the DOM visibility API.)
 */
export function inhousePollDelayMs(
  hasLobby: boolean,
  inQueue: boolean,
  activeMs: number,
  idleMs: number = INHOUSE.POLL_IDLE_MS,
): number {
  return hasLobby || inQueue ? activeMs : idleMs;
}

// ---- Queue presence (heartbeat math) ----------------------------------------
// A queue spot is held by keeping /inhouse open: every state poll refreshes the
// entry's lastSeenAt (see touchQueueHeartbeat in inhouse-service.ts). These pure
// helpers classify entries by heartbeat age so the service, the queue UI, and
// the dashboard count all agree on who is actually here.

export type QueuePresence = "present" | "away";

/** Present = heartbeat recent enough to count toward forming a lobby. */
export function queuePresence(
  lastSeenAtMs: number,
  nowMs: number,
  awaySeconds: number = INHOUSE.QUEUE_AWAY_SECONDS,
): QueuePresence {
  return nowMs - lastSeenAtMs > awaySeconds * 1000 ? "away" : "present";
}

/** SQL cutoff: entries seen at/after this Date count as present. */
export function queuePresentCutoff(nowMs: number): Date {
  return new Date(nowMs - INHOUSE.QUEUE_AWAY_SECONDS * 1000);
}

/** SQL cutoff: entries seen before this Date are dropped from the queue. */
export function queueDropCutoff(nowMs: number): Date {
  return new Date(nowMs - INHOUSE.QUEUE_DROP_SECONDS * 1000);
}

/**
 * lastSeenAt for players re-queued by a cancelled lobby: stale enough that
 * they DON'T count toward re-forming (no ghost lobby seconds after a cancel),
 * past the heartbeat throttle so a present player's very next poll re-confirms
 * them, yet inside the drop window so nobody is pruned before they get the
 * chance (QUEUE_RECONFIRM_SECONDS of slack).
 */
export function requeueLastSeenAt(nowMs: number): Date {
  return new Date(
    nowMs -
      (INHOUSE.QUEUE_DROP_SECONDS - INHOUSE.QUEUE_RECONFIRM_SECONDS) * 1000,
  );
}

/**
 * Seconds between automatic OpenDota result scans for a game that started
 * `elapsedMs` ago: the base interval while the game is normal-length, growing
 * linearly (1/20 of the game's age) once it runs long, capped. An abandoned
 * IN_PROGRESS lobby decays toward one scan per cap interval instead of
 * scanning at full rate forever.
 */
export function detectIntervalSeconds(elapsedMs: number): number {
  const grown = Math.floor(elapsedMs / 20 / 1000);
  return Math.min(
    Math.max(INHOUSE.DETECT_INTERVAL_SECONDS, grown),
    INHOUSE.DETECT_INTERVAL_MAX_SECONDS,
  );
}

export type MmrBalance = {
  avg1: number;
  avg2: number;
  /** avg1 − avg2 (positive = team 1 is stronger on paper). */
  diff: number;
};

/**
 * Average-MMR comparison between the two drafting teams. MMR 0 means
 * "unknown" (a player who never entered one) and is excluded from averages.
 */
export function mmrBalance(team1: number[], team2: number[]): MmrBalance {
  const avg = (xs: number[]) => {
    const known = xs.filter((x) => x > 0);
    return known.length
      ? Math.round(known.reduce((s, x) => s + x, 0) / known.length)
      : 0;
  };
  const avg1 = avg(team1);
  const avg2 = avg(team2);
  return { avg1, avg2, diff: avg1 - avg2 };
}
