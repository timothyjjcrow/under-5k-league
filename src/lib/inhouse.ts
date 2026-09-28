import { INHOUSE, INHOUSE_STATUS } from "./constants";

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
 * Determinism's last resort, after every meaningful key has tied.
 *
 * It is not decoration. The ten `InhouseLobbyPlayer` rows are written by ONE
 * `createMany`, so every player in a lobby shares a single `createdAt` — the
 * "earliest queued" tiebreak below simply cannot separate them. Without a
 * total order the result then falls out of whatever order the caller's array
 * happened to be in, and the two callers do NOT agree: the server ranks the
 * rows as Prisma returns them, while the room ranks a payload pre-sorted by
 * name. Same function, same inputs, different captains — with the vote's whole
 * premise being that the preview tells you what you are voting for.
 */
const byUserId = (a: Seedable, b: Seedable) => a.userId.localeCompare(b.userId);

/**
 * Order players the way we seed a lobby: highest MMR first, ties broken by who
 * queued earliest (rewards waiting). Total + deterministic so it's testable —
 * and so every caller gets the same answer.
 */
export function seedOrder<T extends Seedable>(players: T[]): T[] {
  return [...players].sort(
    (a, b) =>
      b.mmr - a.mmr ||
      joinMs(a.joinedAt) - joinMs(b.joinedAt) ||
      byUserId(a, b),
  );
}

// How a filled lobby decides its two captains. Players vote on this so it isn't
// always the same top-2 MMR pairing (see castVote / resolveCaptainVote).
export type CaptainMethod = "MMR" | "RECORD" | "VOTE";

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
 *
 * RECORD ranks ONLY players with at least one inhouse win by their record;
 * everyone else follows in plain MMR order. Ranking the whole lobby by record
 * put a 0-3 player ahead of every newcomer (more games broke the 0-win tie),
 * so "Best record" could name the one player who had lost every game. A lobby
 * with no wins at all therefore picks exactly what "Highest MMR" would.
 */
export function orderCaptains<T extends CaptainCandidate>(
  method: CaptainMethod,
  candidates: T[],
): T[] {
  const arr = [...candidates];
  if (method === "RECORD") {
    const winners = arr
      .filter((c) => c.wins > 0)
      .sort(
        (a, b) =>
          b.wins - a.wins ||
          b.winRate - a.winRate ||
          b.games - a.games ||
          b.mmr - a.mmr ||
          joinMs(a.joinedAt) - joinMs(b.joinedAt) ||
          byUserId(a, b),
      );
    const rest = seedOrder(arr.filter((c) => !(c.wins > 0)));
    return [...winners, ...rest];
  }
  if (method === "VOTE") {
    return arr.sort(
      (a, b) =>
        b.nominations - a.nominations ||
        b.mmr - a.mmr ||
        joinMs(a.joinedAt) - joinMs(b.joinedAt) ||
        byUserId(a, b),
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
 * Split the queue into the lobby's visible slots, the present overflow behind
 * them, and the players who are away.
 *
 * THE TEN SLOTS ARE FOR PLAYERS WHO ARE HERE. The headline count, `needed` and
 * lobby formation itself all count present players only, so a slot holding an
 * away player shows something the count above it denies. The room first
 * indexed the raw queue (on a fresh database the seed's six away demo players
 * took slots from real ones), then let away players fill whatever slots were
 * left — which is every slot right after an admin cancel, because the ten
 * re-queued players come back away until their own tabs check in: ten names
 * over a ring reading "0 of 10 players" and "10 more players to play". A
 * newcomer could not tell whether the queue was full or empty.
 *
 * Away entries are still queued (the grace window is the point), so the room
 * lists them on their own line under the slots and says in words that they
 * count again the moment they come back.
 */
export function queueSlots<T extends { away: boolean }>(
  queue: T[],
  lobbySize: number = INHOUSE.LOBBY_SIZE,
): { slots: (T | null)[]; overflow: T[]; away: T[] } {
  const present = queue.filter((q) => !q.away);
  const away = queue.filter((q) => q.away);
  if (lobbySize <= 0) return { slots: [], overflow: present, away };
  return {
    slots: Array.from({ length: lobbySize }, (_, i) => present[i] ?? null),
    // Queue order: it is a waiting LINE, and its order is who queued when.
    overflow: present.slice(lobbySize),
    away,
  };
}

/**
 * A stable 4-digit code for a lobby, derived from its id. The public setup card
 * uses fixed Dota credentials; this per-lobby value is the short "#1234" label
 * the room header shows, so players and admins can tell back-to-back games
 * apart when they talk about one.
 */
export function inhouseLobbyCode(lobbyId: string): string {
  let h = 0;
  for (let i = 0; i < lobbyId.length; i++) {
    // >>> 0 keeps it an unsigned 32-bit int (deterministic across engines).
    h = (h * 31 + lobbyId.charCodeAt(i)) >>> 0;
  }
  return String(1000 + (h % 9000)); // 1000–9999, always four digits
}

/**
 * What the `?join=1` deep link (every Discord ping carries one) should do once
 * the first state payload lands.
 *
 * Queue membership has teeth — a filled queue drags you into a timed ready
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
export type InhouseAlert =
  "lobby-formed" | "vote-opened" | "my-turn" | "teams-ready" | "game-ended";

/**
 * What the room knows about the viewer, per poll. The room keeps ONE ref
 * holding the previous one of these, which is also where `wasInReadyCheck`
 * below comes from — so the chime and the cancelled-toast can never disagree
 * about what the last poll said.
 */
export type InhouseAlertSnapshot = {
  /** `lobby?.status ?? null` — null means no active lobby at all. */
  status: string | null;
  /** MEMBERSHIP (`me.inLobby`), never "a lobby exists". */
  inLobby: boolean;
  isOnClock: boolean;
  /** `lastResult?.lobbyId ?? null`. */
  resultId: string | null;
};

/**
 * The moments worth a bell, given the previous poll and this one.
 *
 * `prev === null` means the first payload since mount and ALWAYS returns
 * nothing: a player who reloads mid-lobby, or inside the 10-minute lastResult
 * window, must not be rung for things that happened before they arrived.
 *
 * Edge-triggered, so it depends on its caller having ordered the payloads —
 * `inhouseAlerts(afterPick, beforePick)` correctly reports "my-turn" again.
 * That is not a flaw in this function; it is why the sequence gate exists (see
 * room-sequence.ts), and the re-fired chime was one of the reported symptoms.
 *
 * The room ORs the result into one `playChime()`: coinciding transitions ring
 * once, never twice on the same AudioContext.
 */
export function inhouseAlerts(
  prev: InhouseAlertSnapshot | null,
  next: InhouseAlertSnapshot,
): InhouseAlert[] {
  if (!prev) return [];
  const alerts: InhouseAlert[] = [];
  // Keyed on the lobby appearing, NOT on status === READY_CHECK: a hidden tab
  // on its keepalive can first SEE the lobby already in CAPTAIN_VOTE or
  // DRAFTING, and that player still needs the bell.
  if (next.status !== null && prev.status === null && next.inLobby) {
    alerts.push("lobby-formed");
  }
  // Its own alert, and the matched pair to the rule above: requiring the
  // previous status to be exactly READY_CHECK is what stops the keepalive case
  // ringing twice. A player may have accepted early and tabbed away — which is
  // precisely what ACCEPT_SECONDS anticipates — so the flip must re-ring.
  if (
    next.status === "CAPTAIN_VOTE" &&
    prev.status === "READY_CHECK" &&
    next.inLobby
  ) {
    alerts.push("vote-opened");
  }
  if (next.isOnClock && !prev.isOnClock) alerts.push("my-turn");
  if (next.status === "READY" && prev.status !== "READY" && next.inLobby) {
    alerts.push("teams-ready");
  }
  // Keyed off lastResult, NOT the lobby vanishing — the active-lobby query
  // drops COMPLETED and CANCELLED identically, so an admin cancel would
  // otherwise ring a victory bell. Compared by id rather than "was null", so
  // back-to-back games inside the 10-minute window each ring.
  if (next.resultId && prev.resultId !== next.resultId) {
    alerts.push("game-ended");
  }
  return alerts;
}

/**
 * The stages where a lobby member has something to press: accept, vote, pick,
 * and (once teams lock) get into the Dota lobby. A game in progress needs
 * nothing, so it is not here.
 */
const FOCUS_STATUSES: readonly string[] = [
  "READY_CHECK",
  "CAPTAIN_VOTE",
  "DRAFTING",
  "READY",
];

export type InhouseFocusSnapshot = {
  /** `lobby?.id ?? null`. */
  lobbyId: string | null;
  /** `lobby?.status ?? null`. */
  status: string | null;
  /** MEMBERSHIP (`me.inLobby`). */
  inLobby: boolean;
};

/**
 * Should the room scroll its current stage to the top of the screen?
 *
 * The page opens with its title, links and the stage strip above the room, so
 * on a phone a captain on the clock saw the pick clock and not one player to
 * pick. When a MEMBER's lobby reaches a stage that needs them (a new lobby, a
 * new status, or their first sight of it, including a reload mid-draft), the
 * room brings that stage up. Only then: it never scrolls a spectator, never
 * again within the same stage (the viewer may have scrolled on purpose), and
 * never for a game in progress.
 */
export function shouldFocusStage(
  prev: InhouseFocusSnapshot | null,
  next: InhouseFocusSnapshot,
): boolean {
  if (!next.inLobby || !next.status || !FOCUS_STATUSES.includes(next.status))
    return false;
  return (
    prev === null ||
    !prev.inLobby ||
    prev.lobbyId !== next.lobbyId ||
    prev.status !== next.status
  );
}

/** Was the viewer sitting in a ready check as of the previous poll? */
export function wasInReadyCheck(prev: InhouseAlertSnapshot | null): boolean {
  return !!prev && prev.inLobby && prev.status === "READY_CHECK";
}

/**
 * The tab-title flag, in strict priority order, or null.
 *
 * Unlike the chime this is STATE-derived, not edge-derived, and carries no
 * sound gate: a player who loads /inhouse mid-ready-check sees "(!) Accept
 * your match" immediately with no bell, and a backgrounded tab shows the "(!)"
 * without ever needing a gesture to unlock audio. That asymmetry is the
 * design, not an oversight.
 *
 * `null` in (no payload yet) means no flag — the pre-payload render must not
 * write one.
 */
export type InhouseTitleSnapshot = {
  status: string | null;
  inLobby: boolean;
  isOnClock: boolean;
  hasAccepted: boolean;
  /** The viewer has cast their captain-selection ballot. */
  hasVoted: boolean;
};

export function inhouseTitleFlag(
  s: InhouseTitleSnapshot | null,
): string | null {
  if (!s) return null;
  // isOnClock is safe without an inLobby guard because the server derives it as
  // DRAFTING && isCaptain && myTeam === pickTeam — all of which imply
  // membership. Recompute it client-side and the guard has to come back.
  if (s.isOnClock) return "(!) Your pick";
  if (!s.inLobby) return null;
  if (s.status === "READY_CHECK" && !s.hasAccepted)
    return "(!) Accept your match";
  // Dropped once they have voted, the same way the accept nag is dropped once
  // they have accepted: a "(!)" that survives the action it is asking for
  // teaches people to ignore the "(!)".
  if (s.status === "CAPTAIN_VOTE" && !s.hasVoted) return "(!) Lobby up — vote";
  if (s.status === "READY") return "(!) Teams locked";
  return null;
}

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
// Membership survives suspended/background tabs. These helpers classify
// availability only; the shared four-hour idle deadline owns queue cleanup.

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

/**
 * lastSeenAt for players re-queued by a cancelled lobby: stale enough that
 * they DON'T count toward re-forming (no ghost lobby seconds after a cancel),
 * past the heartbeat throttle so a present player's very next poll re-confirms
 * them. A delayed background poll cannot delete this reserved queue spot.
 */
export function requeueLastSeenAt(nowMs: number): Date {
  return new Date(queuePresentCutoff(nowMs).getTime() - 1000);
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

/**
 * The clock automatic result detection runs on, for a lobby being played.
 *
 * A lobby counts as played from the moment teams lock (READY): ten people who
 * go straight into Dota without pressing the optional Start must still get
 * their game recorded. So there are two clocks:
 *
 *   - READY: from lobby FORMATION. Teams lock a few minutes after that and the
 *     group still has to host and launch, so DETECT_READY_MIN_MINUTES (longer)
 *     puts the first scan a few minutes after teams lock.
 *   - IN_PROGRESS: from `startedAt` (the Start press, or the bot's launch) —
 *     the game is known to be running, so the scan opens DETECT_MIN_MINUTES in
 *     — unless the formation clock opens earlier. Start is optional and can be
 *     pressed (or the bot's launch first noticed) long after the game began,
 *     so a late stamp must never close a window formation already opened:
 *     that would hide "Check now" on a finished game and hold its result back
 *     another DETECT_MIN_MINUTES. The earlier-opening clock wins, and brings
 *     its `clockMs` with it.
 *
 * `clockMs` also drives the scan's backoff (detectIntervalSeconds) and the
 * bot-match wait. Null for any phase that is not being played. Shared by the
 * service, the automation gate's wake-up and the room's "auto-scan is
 * running" note, so the three can never disagree about when detection starts.
 * (The abandonment floors are NOT on this clock: they stay on formation for
 * READY and on `startedAt` for IN_PROGRESS — see resolveAbandonedLobby.)
 */
export function inhouseDetectWindow(lobby: {
  status: string;
  createdAtMs: number;
  startedAtMs: number | null;
}): { clockMs: number; opensAtMs: number } | null {
  const fromFormation = {
    clockMs: lobby.createdAtMs,
    opensAtMs: lobby.createdAtMs + INHOUSE.DETECT_READY_MIN_MINUTES * 60_000,
  };
  if (lobby.status === INHOUSE_STATUS.IN_PROGRESS) {
    // Every IN_PROGRESS writer stamps startedAt; formation is the fallback so
    // an inconsistent row is still scanned rather than stranded.
    const clockMs = lobby.startedAtMs ?? lobby.createdAtMs;
    const fromStart = {
      clockMs,
      opensAtMs: clockMs + INHOUSE.DETECT_MIN_MINUTES * 60_000,
    };
    return fromStart.opensAtMs <= fromFormation.opensAtMs
      ? fromStart
      : fromFormation;
  }
  if (lobby.status === INHOUSE_STATUS.READY) return fromFormation;
  return null;
}

/**
 * Where the automatic result scan stands, for the room: `live` once the scan
 * window (`inhouseDetectWindow`'s opensAtMs, sent as `lobby.scanOpensAt`) has
 * opened, otherwise the whole minutes until it does (at least 1).
 *
 * `live` also gates the manual "Game over? Check now" button. A press scans
 * all ten players' recent OpenDota games, and before the window opens the
 * game can't plausibly be over, so an early press could only fail while
 * spending the OpenDota budget league result sync shares. A null window is
 * treated as open, so the button is never lost to a missing value.
 *
 * `serverNow` is the server clock of the last poll: calling Date.now() while
 * rendering would make the render non-idempotent.
 */
export function inhouseScanStatus(
  scanOpensAt: number | null,
  serverNow: number,
): { live: boolean; minutesLeft: number } {
  if (scanOpensAt == null || serverNow >= scanOpensAt) {
    return { live: true, minutesLeft: 0 };
  }
  return {
    live: false,
    minutesLeft: Math.max(1, Math.ceil((scanOpensAt - serverNow) / 60_000)),
  };
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
