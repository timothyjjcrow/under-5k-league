// Standin offers: a standin says "I can play" for one side of a match that
// needs someone, and that team's captain books from the people who said so.
// Pure rules; the reads and writes live in standin-offer-service.ts.
//
// An offer is not cover and not a request (StandinOffer in the schema): it
// holds no seat and nothing that reads cover sees it. Booking one goes
// through assignStandinGuarded, so every booking rule still decides.

import {
  coverBaselineMmr,
  namedCoverBaseline,
  standinConflict,
  standinNeedsApproval,
  STANDIN_MMR_ALLOWANCE,
  type StandinSlot,
} from "./standin";

/** The board lists a fixture from this long before its kickoff… */
export const STANDIN_BOARD_AHEAD_DAYS = 8;
/** …until this long after it (a series can still need a body for game two). */
export const STANDIN_BOARD_BEHIND_HOURS = 3;

/**
 * How often an offer may ping a side's captain. The first offer is news; the
 * ones that follow within the window only lengthen a list the captain was
 * just told about.
 */
export const STANDIN_OFFER_PING_THROTTLE_SECONDS = 6 * 60 * 60;

/** Kickoffs the board lists at `nowMs`, as an inclusive range. */
export function standinBoardWindow(nowMs: number): { from: Date; to: Date } {
  return {
    from: new Date(nowMs - STANDIN_BOARD_BEHIND_HOURS * 60 * 60 * 1000),
    to: new Date(nowMs + STANDIN_BOARD_AHEAD_DAYS * 24 * 60 * 60 * 1000),
  };
}

/** What one side of a match still needs covered. */
export type StandinSideNeed = {
  /** Seats without cover: players who are out, plus empty roster seats. */
  seats: number;
  /** Of those, the empty roster seats (the rest are players who are out). */
  emptySeats: number;
  /**
   * The MMR a standin is judged against on the seat that suits them best
   * (the highest baseline among the open seats); null when no open seat has
   * a known one.
   */
  baselineMmr: number | null;
};

/**
 * What a side still needs, as the booking rules see it: every rostered
 * player who said they can't make this kickoff and has neither a booking nor
 * a request waiting for them, plus every empty roster seat no booking or
 * request has taken. A waiting request holds its seat exactly as it does for
 * a booking (`judgeCover`), so that seat isn't offered to anyone else.
 *
 * Each seat's baseline is the server's own (`namedCoverBaseline` for a named
 * player, `coverBaselineMmr` over the roster for an empty seat).
 */
export function standinSideNeed(side: {
  teamSize: number;
  /** The side's roster with signup MMRs (0 = unknown). */
  roster: readonly { userId: string; name: string; mmr: number }[];
  /** Who checked in OUT for the match's current scheduleRevision. */
  outUserIds: ReadonlySet<string>;
  /** Rostered players a BOOKING covers in this match. */
  bookedUserIds: ReadonlySet<string>;
  /** Rostered players a waiting request would cover in this match. */
  askedUserIds: ReadonlySet<string>;
  /** Empty seats already taken, by a booking or a waiting request. */
  emptySeatsTaken: number;
}): StandinSideNeed {
  const uncoveredOut = side.roster.filter(
    (m) =>
      side.outUserIds.has(m.userId) &&
      !side.bookedUserIds.has(m.userId) &&
      !side.askedUserIds.has(m.userId),
  );
  const emptySeats = Math.max(
    0,
    side.teamSize - side.roster.length - side.emptySeatsTaken,
  );
  const baselines: (number | null)[] = uncoveredOut.map(
    (m) =>
      namedCoverBaseline({
        replaced: { userId: m.userId, mmr: m.mmr },
        teammates: side.roster,
        outUserIds: side.outUserIds,
        coveredUserIds: side.bookedUserIds,
      }).baselineMmr,
  );
  if (emptySeats > 0) {
    baselines.push(
      coverBaselineMmr({ rosterMmrs: side.roster.map((m) => m.mmr) }),
    );
  }
  const known = baselines.filter((b): b is number => b !== null);
  return {
    seats: uncoveredOut.length + emptySeats,
    emptySeats,
    baselineMmr: known.length > 0 ? Math.max(...known) : null,
  };
}

/** A booking, a waiting request or a decline that names the viewer. */
export type StandinOfferCommitment = StandinSlot & {
  matchId: string;
  /** The side it was for. */
  teamId: string;
  homeName: string;
  awayName: string;
  kind: "booked" | "asked" | "declined";
};

/** Where a viewer stands on one need. */
export type StandinOfferStanding =
  | { kind: "signed-out" }
  /** Signed in, with no ACTIVE signup this season. */
  | { kind: "no-signup" }
  /** Can't offer; `reason` says why, to them. */
  | { kind: "blocked"; reason: string }
  /** On the list already. */
  | { kind: "offered"; outcome: "book" | "ask" }
  /** May offer. `outcome` is what a captain's pick would then do. */
  | { kind: "open"; outcome: "book" | "ask" };

/**
 * Whether this viewer can say "I can play" for a side, and what a captain
 * picking them would do. It mirrors what `judgeCover` refuses at booking, so
 * nobody joins a list they could never be booked from: a roster seat (they'd
 * be in both teams' import sets), a booking or a waiting request in this
 * match, a decline for this team in this match, or cover owed on another
 * fixture the same night (`standinConflict`).
 */
export function standinOfferStanding(input: {
  signedIn: boolean;
  /** An ACTIVE signup this season, of either type. */
  activeSignup: boolean;
  rostered: boolean;
  /** Signup MMR; 0 = unknown. */
  mmr: number;
  offered: boolean;
  need: { matchId: string; teamId: string; baselineMmr: number | null } & StandinSlot;
  /** The viewer's bookings, waiting requests and declines this season. */
  commitments: readonly StandinOfferCommitment[];
}): StandinOfferStanding {
  if (!input.signedIn) return { kind: "signed-out" };
  if (input.rostered) {
    return {
      kind: "blocked",
      reason: "You're on a roster this season, so you can't stand in.",
    };
  }
  if (!input.activeSignup) return { kind: "no-signup" };
  const here = input.commitments.filter(
    (c) => c.matchId === input.need.matchId,
  );
  if (here.some((c) => c.kind === "booked")) {
    return { kind: "blocked", reason: "You're already booked in this match." };
  }
  if (here.some((c) => c.kind === "asked")) {
    return {
      kind: "blocked",
      reason:
        "A captain has already asked for you in this match. You're in once the other captain agrees.",
    };
  }
  if (
    here.some((c) => c.kind === "declined" && c.teamId === input.need.teamId)
  ) {
    return {
      kind: "blocked",
      reason: "You were already declined for this team in this match.",
    };
  }
  const clash = input.commitments.find(
    (c) => c.kind === "booked" && standinConflict(input.need, c),
  );
  if (clash) {
    return {
      kind: "blocked",
      reason: `You're booked for ${clash.homeName} vs ${clash.awayName} that night.`,
    };
  }
  const outcome = standinNeedsApproval(input.mmr, input.need.baselineMmr)
    ? "ask"
    : "book";
  return { kind: input.offered ? "offered" : "open", outcome };
}

const MMR_NUMBER = new Intl.NumberFormat("en-US");

/** "needs a standin" / "needs 2 standins". */
export function standinNeedLabel(seats: number): string {
  return seats === 1 ? "needs a standin" : `needs ${seats} standins`;
}

/** "1 said they can play" / "3 said they can play"; "" for none. */
export function standinOfferCountLabel(count: number): string {
  return count > 0 ? `${count} said they can play` : "";
}

/**
 * Who the seat suits, in one line anyone can read: the MMR a standin can be
 * at for the captain's pick to be final (the seat's baseline plus the
 * allowance), and that a stronger one can still offer.
 */
export function standinSeatLine(baselineMmr: number | null): string {
  return baselineMmr === null
    ? "This seat's MMR is unknown, so the other captain has to agree to whoever is picked."
    : `Best fit: up to ${MMR_NUMBER.format(
        baselineMmr + STANDIN_MMR_ALLOWANCE,
      )} MMR. Higher can still offer; the other captain then has to agree.`;
}

/**
 * What a pick would do, said to the standin. An offer never books by itself:
 * the side's own captain always picks, so neither line says "booked".
 */
export function standinOfferOutcomeLine(
  outcome: "book" | "ask",
  otherTeamName: string,
  /** Already on the list: say only what happens next. */
  offered = false,
): string {
  if (outcome === "book") {
    return offered
      ? "If the captain picks you, you're in."
      : "You fit this seat: if the captain picks you, you're in.";
  }
  const next = `If the captain picks you, the ${otherTeamName} captain also has to agree.`;
  return offered ? next : `You can offer. ${next}`;
}

/** A game the viewer said they can play, as Home names it. */
export type StandinOfferedGame = {
  teamName: string;
  opponentName: string;
};

/**
 * Home's line for a player in the standin pool with no booking coming up:
 * the games they already said they can play (so Home never asks them to say
 * it again), how many others need someone now, and the way to the Standins
 * page.
 */
export function standinHomeLine(
  games: number,
  /** Games still needing someone that the viewer is on the list for. */
  offered: readonly StandinOfferedGame[] = [],
): { title?: string; text: string; cta: string } {
  if (offered.length > 0) {
    const [first] = offered;
    const others = games - offered.length;
    const named =
      offered.length === 1
        ? `${first.teamName} vs ${first.opponentName}`
        : `${offered.length} games`;
    return {
      title: "You said you can play",
      text: `You're on the list for ${named}. The captain picks, and you're pinged on Discord if it's you.${
        others > 0
          ? ` ${others === 1 ? "1 more game needs" : `${others} more games need`} a standin.`
          : ""
      }`,
      cta: "Open the Standins page",
    };
  }
  if (games === 0) {
    return {
      text: "No game needs a standin right now. One shows on the Standins page as soon as a team is a player down.",
      cta: "Open the Standins page",
    };
  }
  return {
    text: `${
      games === 1 ? "1 game needs" : `${games} games need`
    } a standin. Say you can play, and that team's captain picks from everyone who did.`,
    cta: games === 1 ? "See the game" : "See the games",
  };
}

/**
 * The toast after a booked standin said they can't make it and the seat went
 * back (`releaseOwnStandinBooking`): what happened, and that nobody else has
 * to be told.
 */
export function standinReleasedToast(teamName: string): string {
  return `You're off this match. The ${teamName} captain is told, and the seat is back on the Standins page for someone else.`;
}

/** The toast after "I can play". */
export function standinOfferedToast(teamName: string): string {
  // "the list for X", never "X's list": team names end in anything.
  return `You're on the list for ${teamName}. Their captain picks, and you're pinged on Discord if it's you.`;
}

/**
 * The Standins page on one game. Every standin control lives on that page,
 * so this is where every other page and Discord post sends a captain: they
 * land on their team's cover for this game, and anyone else on the game
 * itself. It books and offers nothing.
 */
export function standinHubPath(matchId: string): string {
  return `/standins?match=${encodeURIComponent(matchId)}`;
}

/**
 * The link a captain or a teammate shares: it opens the board on this game,
 * and puts a signed-in standin on the list (`play`). Opening it books
 * nothing, so it is safe to post anywhere.
 */
export function standinOfferPath(matchId: string, teamId: string): string {
  return `/standins?match=${encodeURIComponent(matchId)}&team=${encodeURIComponent(
    teamId,
  )}&play=1`;
}

/**
 * The board's order for one viewer, from the soonest-first list: a rostered
 * player's own team's games lead (the ones they came to share), then the
 * game a shared link named, then the rest as they were. The captain's own
 * sides are never passed in: they are in the captain's section above.
 */
export function orderStandinBoard<T extends { matchId: string; teamId: string }>(
  needs: readonly T[],
  opts: {
    /** The viewer's roster team, when they are a player and not its captain. */
    ownTeamId: string | null;
    /** The game a shared link named. */
    linked: { matchId: string; teamId: string } | null;
  },
): T[] {
  const { ownTeamId, linked } = opts;
  const rank = (n: T) =>
    ownTeamId !== null && n.teamId === ownTeamId
      ? 0
      : linked && n.matchId === linked.matchId && n.teamId === linked.teamId
        ? 1
        : 2;
  // Ties keep the incoming order: the list arrives soonest first.
  return needs
    .map((need, index) => ({ need, index }))
    .sort((a, b) => rank(a.need) - rank(b.need) || a.index - b.index)
    .map((x) => x.need);
}

/** What opening the shared link does for this viewer. */
export type StandinArrivalAction =
  /** Put them on the list now. */
  | "offer"
  /** Tell them they already are. */
  | "already"
  /** Tell them why they can't. */
  | "blocked"
  /** Nothing automatic: the game's own button says what to do next. */
  | "none";

/**
 * A shared link's one-time answer. Only a signed-in player who may offer is
 * added; a signed-out visitor or one without a signup gets the game's own
 * button (sign in, or register as a standin), never a silent nothing.
 */
export function standinArrivalAction(
  play: boolean,
  standing: StandinOfferStanding | null,
): StandinArrivalAction {
  if (!play || !standing) return "none";
  if (standing.kind === "open") return "offer";
  if (standing.kind === "offered") return "already";
  if (standing.kind === "blocked") return "blocked";
  return "none";
}

/** One standin who said they can play, as the captain's card lists them. */
export type StandinOfferRow = {
  userId: string;
  /** When they offered: the list's order, earliest first. */
  createdAt: Date;
};

/** Offers in the order a captain sees them: first come, first listed. */
export function sortStandinOffers<T extends StandinOfferRow>(
  offers: readonly T[],
): T[] {
  // Exact stored keys, the id last: the same order every render.
  return [...offers].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.userId.localeCompare(b.userId),
  );
}
