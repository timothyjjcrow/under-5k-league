import { INHOUSE, INHOUSE_STATUS } from "./constants";
import {
  nextPickTeam,
  orderCaptains,
  tallyMethod,
  type CaptainCandidate,
  type CaptainMethod,
} from "./inhouse";

// Pure wording and turn math for the inhouse room's stage views
// (src/components/inhouse/*-view.tsx): what each stage says the viewer must
// do, what the vote would decide if its clock ran out now, whose picks come
// next, and the toasts for the moments a poll skips past (captains chosen, a
// player drafted). The components render these; vitest has no DOM.

/**
 * Which way into the Dota lobby the setup card shows: the bot's panel once
 * the bot answers that it can host this game, the by-hand steps when it
 * can't (not set up, failing, or busy with the other game, which keeps this
 * game by hand for good: `handHosted`), and one "checking" line while its
 * first answer is on the way. The first answer is bounded by the panel's
 * request timeout (then "unavailable", so by hand), and showing the by-hand
 * steps meanwhile flashed "create a lobby, set the ticket" at every player
 * before the bot's panel folded them away.
 */
export function inhouseSetupPath(o: {
  bot: "checking" | "off" | "on" | "unavailable" | "busy";
  handHosted: boolean;
}): "checking" | "bot" | "hand" {
  if (o.handHosted) return "hand";
  if (o.bot === "on") return "bot";
  if (o.bot === "checking") return "checking";
  return "hand";
}

/** One name per captain method, on the vote's cards and in its lines. */
export const CAPTAIN_METHOD_LABEL: Record<CaptainMethod, string> = {
  VOTE: "Elect captains",
  MMR: "Highest MMR",
  RECORD: "Best record",
};

/**
 * The ready check's heading. It asks only while there is something to answer:
 * once the viewer accepted it says who the game waits on.
 */
export function readyCheckHeading(o: {
  canAccept: boolean;
  hasAccepted: boolean;
  waitingOn: number;
}): string {
  if (!o.canAccept) return "A match is filling up";
  if (!o.hasAccepted) return "Match found. You in?";
  return o.waitingOn > 0
    ? `You’re in — waiting on ${o.waitingOn}`
    : "Everyone’s in";
}

type VoteLike<C extends CaptainCandidate> = {
  candidates: readonly C[];
  methodTallies: Record<CaptainMethod, number>;
};

/**
 * What the captain vote would decide if its clock ran out now: the method
 * `tallyMethod` would pick from these tallies (no votes = MMR, its default)
 * and the two players `orderCaptains` would install with it, index 0 on team
 * 1 (Radiant at formation). The same two functions resolveCaptainVote runs,
 * so the line never names captains the vote wouldn't.
 */
export function projectedCaptains<C extends CaptainCandidate>(
  vote: VoteLike<C>,
): {
  method: CaptainMethod;
  votes: number;
  byDefault: boolean;
  captains: [C, C] | null;
} {
  const ballots: CaptainMethod[] = (
    Object.keys(CAPTAIN_METHOD_LABEL) as CaptainMethod[]
  ).flatMap((m) => Array<CaptainMethod>(vote.methodTallies[m] ?? 0).fill(m));
  const method = tallyMethod(ballots);
  const ordered = orderCaptains(method, [...vote.candidates]);
  return {
    method,
    votes: vote.methodTallies[method] ?? 0,
    byDefault: ballots.length === 0,
    captains: ordered.length >= 2 ? [ordered[0], ordered[1]] : null,
  };
}

/** The projection as one sentence, for the vote's banner. */
export function voteProjectionText(p: {
  method: CaptainMethod;
  votes: number;
  byDefault: boolean;
  captains: [{ name: string }, { name: string }] | null;
}): string {
  const lead = p.byDefault
    ? `No votes yet, so ${CAPTAIN_METHOD_LABEL[p.method]} decides`
    : `${CAPTAIN_METHOD_LABEL[p.method]} leads with ${p.votes} ${p.votes === 1 ? "vote" : "votes"}`;
  if (!p.captains) return `${lead}.`;
  return `${lead}: ${p.captains[0].name} (Radiant) vs ${p.captains[1].name} (Dire).`;
}

/**
 * The whole snake order, one team per pick (`nextPickTeam` walked from an
 * empty draft): `[2, 1, 1, 2, 2, 1, 1, 2]` for a 5v5 with team 2 first.
 */
export function inhousePickOrder(
  teamSize: number = INHOUSE.TEAM_SIZE,
  firstPickTeam: 1 | 2 = INHOUSE.FIRST_PICK_TEAM,
): (1 | 2)[] {
  const order: (1 | 2)[] = [];
  let team1 = 0;
  let team2 = 0;
  for (;;) {
    const next = nextPickTeam(team1, team2, teamSize, firstPickTeam);
    if (next === null) return order;
    order.push(next);
    if (next === 1) team1 += 1;
    else team2 += 1;
  }
}

/** How many picks in a row `team` makes from `start` in the order. */
function runFrom(order: readonly (1 | 2)[], start: number, team: 1 | 2) {
  let end = start;
  while (end < order.length && order[end] === team) end += 1;
  return end - start;
}

export type DraftTurn =
  /** On the clock now: pick `pick` of the `of` this turn makes in a row. */
  | { kind: "mine"; pick: number; of: number }
  /** Up after `wait` more picks by the other side, then `picks` in a row. */
  | { kind: "next"; picks: number; wait: number }
  | null;

/**
 * A captain's own turn, from the snake order: whether they pick now (and
 * which of their picks in a row this is), or how soon their side picks next.
 * Null for anyone who isn't a captain, or once their side is done.
 */
export function draftTurn(o: {
  order: readonly (1 | 2)[];
  picksMade: number;
  pickTeam: number | null;
  myCaptainTeam: number | null;
}): DraftTurn {
  const mine = o.myCaptainTeam;
  if (mine !== 1 && mine !== 2) return null;
  const at = o.picksMade;
  if (o.pickTeam === mine) {
    // The server's turn wins; the order only words it.
    if (o.order[at] !== mine) return { kind: "mine", pick: 1, of: 1 };
    let start = at;
    while (start > 0 && o.order[start - 1] === mine) start -= 1;
    return { kind: "mine", pick: at - start + 1, of: runFrom(o.order, start, mine) };
  }
  for (let k = at; k < o.order.length; k++) {
    if (o.order[k] === mine) {
      return { kind: "next", picks: runFrom(o.order, k, mine), wait: k - at };
    }
  }
  return null;
}

/** The draft turn as the banner's line for its captain. */
export function draftTurnText(turn: DraftTurn): string | null {
  if (!turn) return null;
  if (turn.kind === "mine") {
    return turn.of > 1
      ? `You’re on the clock — pick ${turn.pick} of ${turn.of}`
      : "You’re on the clock";
  }
  const picks = turn.picks === 1 ? "1 pick" : `${turn.picks} picks`;
  return turn.wait <= 1
    ? `You’re up next — ${picks}`
    : `You pick again in ${turn.wait} picks — ${picks}`;
}

type DraftedPlayer = { userId: string; name: string; pickIndex: number | null };
type DraftedTeam<P extends DraftedPlayer> = {
  team: number;
  isRadiant: boolean;
  captain: P | null;
  players: readonly P[];
};

/** The latest drafted player and the side that took them, or null. */
export function lastDraftPick<P extends DraftedPlayer, T extends DraftedTeam<P>>(
  teams: readonly T[],
): { player: P; team: T } | null {
  let best: { player: P; team: T } | null = null;
  for (const team of teams) {
    for (const player of team.players) {
      if (player.pickIndex == null) continue;
      if (!best || player.pickIndex > (best.player.pickIndex ?? -1)) {
        best = { player, team };
      }
    }
  }
  return best;
}

type ToastLobby<P extends DraftedPlayer> = {
  id: string;
  status: string;
  teams: readonly DraftedTeam<P>[];
};

/**
 * "You’re on Radiant": a player (not a captain) whose poll first finds them
 * on a side of the game they were already in. Null on a first poll (a reload
 * mid-draft says nothing), for a captain (installed by the vote, not
 * drafted), and for a viewer who wasn't in this game on the last poll.
 */
export function draftedToast<P extends DraftedPlayer>(
  prev: { lobbyId: string | null; myTeam: number | null } | null,
  next: { myTeam: number | null; isCaptain: boolean; userId: string | null },
  lobby: ToastLobby<P> | null,
): string | null {
  if (!prev || !lobby || prev.lobbyId !== lobby.id) return null;
  if (prev.myTeam != null || next.myTeam == null || next.isCaptain) return null;
  if (
    lobby.status !== INHOUSE_STATUS.DRAFTING &&
    lobby.status !== INHOUSE_STATUS.READY
  ) {
    return null;
  }
  const team = lobby.teams.find((t) => t.team === next.myTeam);
  if (!team) return null;
  const side = team.isRadiant ? "Radiant" : "Dire";
  const me = team.players.find((p) => p.userId === next.userId);
  const by = team.captain ? ` — drafted by ${team.captain.name}` : "";
  const pick = me?.pickIndex != null ? ` (pick ${me.pickIndex + 1})` : "";
  return `You’re on ${side}${by}${pick}.`;
}

/**
 * The vote's result, for its ten: the poll after it resolves shows the draft,
 * so without this the captains appear with no word on how. It names the
 * method only when the last vote the viewer saw projects exactly these two
 * captains; a ballot cast after that poll could have changed it.
 */
export function captainsChosenToast<
  C extends CaptainCandidate,
  P extends DraftedPlayer,
>(
  prev: {
    lobbyId: string | null;
    status: string | null;
    vote: VoteLike<C> | null;
  } | null,
  next: { inLobby: boolean },
  lobby: ToastLobby<P> | null,
): string | null {
  if (!prev || !lobby || !next.inLobby) return null;
  if (prev.lobbyId !== lobby.id) return null;
  if (prev.status !== INHOUSE_STATUS.CAPTAIN_VOTE) return null;
  if (lobby.status !== INHOUSE_STATUS.DRAFTING) return null;
  const [a, b] = lobby.teams;
  if (!a?.captain || !b?.captain) return null;
  const pair = `${a.captain.name} (${a.isRadiant ? "Radiant" : "Dire"}) and ${b.captain.name} (${b.isRadiant ? "Radiant" : "Dire"})`;
  const projected = prev.vote ? projectedCaptains(prev.vote) : null;
  const matches =
    projected?.captains != null &&
    projected.captains[0].userId === a.captain.userId &&
    projected.captains[1].userId === b.captain.userId;
  return matches
    ? `${CAPTAIN_METHOD_LABEL[projected.method]} picked the captains: ${pair}.`
    : `Captains: ${pair}.`;
}
