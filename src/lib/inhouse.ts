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

/** How many more players still need to queue before a lobby forms. */
export function playersNeeded(
  queueSize: number,
  lobbySize: number = INHOUSE.LOBBY_SIZE,
): number {
  return Math.max(0, lobbySize - queueSize);
}

/**
 * A stable 4-digit code for a lobby, derived from its id — so all ten players
 * see the SAME suggested Dota 2 lobby name (`GGD2L #4821`) and password (`4821`)
 * with no server round-trip or stored field. The host types them; everyone else
 * finds that exact lobby in Dota's custom-lobby list and joins with the code.
 */
export function inhouseLobbyCode(lobbyId: string): string {
  let h = 0;
  for (let i = 0; i < lobbyId.length; i++) {
    // >>> 0 keeps it an unsigned 32-bit int (deterministic across engines).
    h = (h * 31 + lobbyId.charCodeAt(i)) >>> 0;
  }
  return String(1000 + (h % 9000)); // 1000–9999, always four digits
}

export type PollCadenceInput = {
  /** document.visibilityState === "hidden". */
  hidden: boolean;
  /** The VIEWER's own stake: queued, or a member of the live lobby. */
  hasStake: boolean;
  /** The response was a 429 from the route's per-IP speed bump. */
  rateLimited?: boolean;
  /** A state payload came back (false = failed, aborted, or not attempted). */
  reached?: boolean;
  /** The room's fast cadence (its `pollMs` prop, default 1500). */
  activeMs: number;
  /** Overridable for tests; the room always takes the constant. */
  idleMs?: number;
};

export type PollCadence = {
  /** Don't fetch at all this tick — just wait `delayMs` and re-check. */
  skip: boolean;
  delayMs: number;
};

/**
 * The inhouse room's whole poll cadence, in one place: the loop asks before it
 * fetches (is this tick worth a request?) and again after the response settles
 * (how long until the next one?). It is the ~1800-line room's most consequential
 * logic and lived entirely inside a `useEffect`, where the only thing that could
 * assert it was a browser spec.
 *
 * The four rules, in the order they take precedence:
 *
 * 1. **429 is not a failure — it's a signal to ease off.** The route's speed
 *    bump is per-IP and a queued tab polls 40/min, so one household or one
 *    NAT'd office crosses it just by having a lobby. Treating it as a
 *    disconnect greyed out ACCEPT MATCH mid-ready-check, and retrying at 1.5s
 *    kept the fixed window saturated so it never cleared. Dropping to the idle
 *    rate is what actually drains the bucket — and the bucket is shared with
 *    the mutations, so this is how the next ACCEPT gets through.
 * 2. **A hidden tab WITH a stake keepalives; without one it doesn't fetch.**
 *    Queued or in a lobby, the poll IS the presence heartbeat (and carries the
 *    ready-check chime + tab title), so it must outrun QUEUE_AWAY_SECONDS even
 *    after Chrome clamps background timers. A hidden spectator is pure cost:
 *    the sitewide /api/sync ping advances lobbies without them.
 * 3. **A poll that didn't land retries at the FAST rate** — sustained failures
 *    are what flip `disconnected` (see pollHealthAfter), and backing off would
 *    delay the recovery as much as the diagnosis.
 * 4. Otherwise it turns on MEMBERSHIP, not on a lobby merely existing: five
 *    people watching a 45-minute game were each firing 40 req/min because one
 *    did. Anyone IN it (or in the queue) still polls fast — a filling queue is
 *    exactly when responsiveness decides whether a game happens.
 */
export function inhousePollCadence(o: PollCadenceInput): PollCadence {
  const idleMs = o.idleMs ?? INHOUSE.POLL_IDLE_MS;
  if (o.rateLimited) return { skip: false, delayMs: idleMs };
  // Visibility is whatever the CALLER sees at the moment it asks, so a tab
  // refocused mid-fetch reschedules at the active rate, not the keepalive.
  if (o.hidden) {
    return o.hasStake
      ? { skip: false, delayMs: INHOUSE.POLL_KEEPALIVE_MS }
      : { skip: true, delayMs: idleMs };
  }
  if (o.reached === false) return { skip: false, delayMs: o.activeMs };
  return { skip: false, delayMs: o.hasStake ? o.activeMs : idleMs };
}

/**
 * What the `?join=1` deep link (every Discord ping carries one) should do once
 * the first state payload lands.
 *
 * Queue membership has teeth — a filled queue drags you into a 45-second ready
 * check whose failure DROPS you — so the room fires this at most once per page
 * load and scrubs the param. A live lobby is deliberately NOT a refusal: only
 * one lobby exists at a time, so a new joiner simply queues for the next game,
 * and refusing here broke the board's own "Queue for the next one →" link,
 * which exists for precisely that case.
 */
export type AutoJoinDecision = "join" | "already-in" | "signed-out";

export function autoJoinDecision(me: {
  isLoggedIn: boolean;
  inQueue: boolean;
  inLobby: boolean;
}): AutoJoinDecision {
  if (!me.isLoggedIn) return "signed-out"; // the page's own CTA takes over
  if (me.inQueue || me.inLobby) return "already-in";
  return "join";
}

/**
 * The toast for a ready check that ended under the viewer, or null.
 *
 * Gated on MEMBERSHIP, never on a list of lobby statuses. The status list got
 * two things wrong, both of which told a player the opposite of the truth:
 * (1) it said the decliner and the timed-out no-shows were "back in the queue"
 * when failReadyCheck deliberately DROPPED them, contradicting the dialog they
 * had just confirmed; (2) ACCEPT_SECONDS + VOTE_SECONDS fit inside one hidden-
 * tab POLL_KEEPALIVE_MS gap, so a player who accepted early and tabbed away
 * could come back to "match cancelled" about a match that was already
 * DRAFTING. Membership survives both: the same-poll READY_CHECK→CAPTAIN_VOTE
 * flip keeps `inLobby` true, and so does a poll that skips the vote entirely.
 */
export function readyCheckEndedToast(o: {
  /** The viewer was in a READY_CHECK lobby as of the previous poll. */
  wasInReadyCheck: boolean;
  inLobby: boolean;
  inQueue: boolean;
}): string | null {
  if (!o.wasInReadyCheck || o.inLobby) return null;
  return o.inQueue
    ? "Match cancelled — someone didn't accept. You're back in the queue."
    : "Match cancelled — you're no longer in the queue.";
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
 * A team's average MMR, where 0 means UNKNOWN (a player who never entered one)
 * and is excluded rather than averaged in as a zero. Returns 0 when nobody on
 * the side has a known MMR, which every caller renders as "no chip" rather
 * than "0 MMR".
 *
 * Exported because the room shows this figure on three different screens and
 * each used to compute it inline: the drafting columns and the balance banner
 * excluded unknowns, while the READY/IN_PROGRESS matchup grid divided by the
 * whole roster. One unregistered player therefore dropped his side by ~20% at
 * the exact moment the last pick landed and one view replaced the other — a
 * team the banner had just called 120 MMR stronger rendered 620 weaker with
 * nothing changed, on the screen ten people use to decide whether the game
 * looks worth playing. One definition, one test.
 */
export function avgKnownMmr(mmrs: number[]): number {
  const known = mmrs.filter((m) => m > 0);
  return known.length
    ? Math.round(known.reduce((s, m) => s + m, 0) / known.length)
    : 0;
}

/**
 * Average-MMR comparison between the two drafting teams. MMR 0 means
 * "unknown" (a player who never entered one) and is excluded from averages.
 */
export function mmrBalance(team1: number[], team2: number[]): MmrBalance {
  const avg1 = avgKnownMmr(team1);
  const avg2 = avgKnownMmr(team2);
  return { avg1, avg2, diff: avg1 - avg2 };
}
