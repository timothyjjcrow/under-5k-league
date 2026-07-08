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
 * side has drafted so far. Strict back-and-forth starting with `firstPickTeam`;
 * a full side is skipped, and we return null once both rosters are full.
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
  return totalPicks % 2 === 0 ? firstPickTeam : otherTeam;
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
