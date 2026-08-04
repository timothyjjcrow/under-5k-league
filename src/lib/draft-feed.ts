/**
 * The draft room's live feed, as a pure diff.
 *
 * WHAT MAKES THIS DIFFERENT from the room's other extracted rules: the feed is
 * an append-only LOG of state transitions, so it genuinely cannot be derived
 * from the current payload — a captain who reloads mid-draft has no way to know
 * that team B bid $4 thirty seconds ago. What CAN be pure is the step: given
 * the previous payload and this one, which lines did this poll earn. The
 * component keeps the accumulated list (and hands out React keys); everything
 * that decides CONTENT lives here, where a test can reach it.
 *
 * The rules below are small and each of them has a visible failure mode on
 * draft night, in front of everyone, with no error anywhere:
 *
 *  - A SALE is a new NON-CAPTAIN roster row. The previous-rosters set is built
 *    from every member INCLUDING captains, and that is load-bearing:
 *    `transferCaptaincy` flips a member's `isCaptain` to false while leaving
 *    them rostered, and it is legal in exactly the two states where this room
 *    is open and polling (the waiting room, and after COMPLETE). Filter
 *    captains out of the set and the next poll announces the outgoing captain
 *    as a fresh signing, at whatever their `price` happens to be.
 *  - A NOMINATION and a BID are mutually exclusive on one poll, and a bid line
 *    only fires while the lot is unchanged. Two bids landing inside one poll
 *    interval collapse into one line at the higher amount — the feed is a
 *    highlight reel, not the audit log (the lot's own bid trail is).
 *  - Lines come back NEWEST FIRST, because that is how the room renders them:
 *    it prepends this array whole. One poll routinely carries a sale AND the
 *    nomination it resolved into — `getDraftState` runs both resolvers before
 *    it reads — and the nomination is the newer of the two, so it goes on top.
 *    (The seed below has always ordered itself this way; the diff used to
 *    disagree with it and show the sale above the nomination that followed.)
 *
 * Team names are looked up in the NEW payload, so a line about a team that has
 * somehow vanished renders "—" rather than crashing the room.
 */

export type FeedKind = "nominate" | "bid" | "sold";

/** One line of the feed. Ids are the component's business — see FEED_MAX. */
export type FeedLine = {
  kind: FeedKind;
  text: string;
  amount: number;
};

/** The SOLD! flash: the sale worth interrupting the room for. */
export type FeedSale = {
  name: string;
  team: string;
  price: number;
  /** The viewer themself was just sold — their personal draft moment. */
  isMe: boolean;
};

/** Moments in a draft transition that are worth a bell. */
export type DraftAlert = "im-sold" | "im-nominated" | "my-nomination";

/** The slice of a draft payload this module reads. `DraftState` satisfies it. */
export type FeedSnapshot = {
  teams: {
    id: string;
    name: string;
    members: { userId: string; name: string; isCaptain: boolean; price: number }[];
  }[];
  nominatedPlayer: { userId: string; name: string } | null;
  nominatorTeamId: string | null;
  currentBid: number;
  currentBidTeamId: string | null;
  me: { userId: string | null; canNominate: boolean };
};

/** …plus the server's reconstructed sale history, for the first paint. */
export type FeedSeedSnapshot = FeedSnapshot & {
  recentSales: { name: string; teamName: string; price: number }[];
};

/** The lifecycle slice used to decide whether an accumulated client feed is
 * still describing the authoritative auction. */
export type FeedResetSnapshot = Pick<FeedSnapshot, "teams" | "nominatedPlayer"> & {
  status: string;
};

export type DraftFeedResetReason =
  | "auction-reset"
  | "auction-reopened"
  | "lot-voided"
  | "roster-retracted";

/** How many lines the feed keeps. */
export const FEED_MAX = 12;

const teamName = (s: FeedSnapshot, id: string | null) =>
  s.teams.find((t) => t.id === id)?.name ?? "—";

/**
 * Why an append-only feed must be discarded and reconstructed from the latest
 * server snapshot, or null when it remains valid.
 *
 * Ordinary transitions only add facts, but recovery actions do the opposite:
 * Abort returns the auction to NOT_STARTED, while Undo/roster correction removes
 * a purchased player. Keeping the old client log then asserts a voided sale is
 * still real, and an abort followed by Start leaks the previous run's prices
 * into the new auction. COMPLETE → IN_PROGRESS is called out independently as
 * defence in depth for a reopened draft, even if a malformed/intermediate
 * payload does not expose the expected roster removal.
 */
export function draftFeedResetReason(
  prev: FeedResetSnapshot,
  next: FeedResetSnapshot,
): DraftFeedResetReason | null {
  if (next.status === "NOT_STARTED" && prev.status !== "NOT_STARTED") {
    return "auction-reset";
  }
  if (prev.status === "COMPLETE" && next.status === "IN_PROGRESS") {
    return "auction-reopened";
  }
  if (
    prev.nominatedPlayer &&
    !next.nominatedPlayer &&
    next.status === "PAUSED"
  ) {
    return "lot-voided";
  }

  const nextRostered = new Set(
    next.teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  const purchaseRetracted = prev.teams.some((t) =>
    t.members.some((m) => !m.isCaptain && !nextRostered.has(m.userId)),
  );
  return purchaseRetracted ? "roster-retracted" : null;
}

/** Boolean convenience for consumers that only need to know whether to reset. */
export function draftFeedInvalidated(
  prev: FeedResetSnapshot,
  next: FeedResetSnapshot,
): boolean {
  return draftFeedResetReason(prev, next) !== null;
}

/**
 * The feed as reconstructed from the FIRST payload after a page load: the live
 * nomination on top, then recent sales. Without it, joining mid-draft shows an
 * empty feed on the busiest screen in the app.
 */
export function seedDraftFeed(s: FeedSeedSnapshot): FeedLine[] {
  const seed: FeedLine[] = [];
  if (s.nominatedPlayer) {
    seed.push({
      kind: "nominate",
      text: `${teamName(s, s.nominatorTeamId)} nominated ${s.nominatedPlayer.name}`,
      amount: s.currentBid,
    });
  }
  for (const sale of s.recentSales) {
    seed.push({
      kind: "sold",
      text: `${sale.name} → ${sale.teamName}`,
      amount: sale.price,
    });
  }
  return seed.slice(0, FEED_MAX);
}

/**
 * What one poll changed: the lines to prepend (newest first), the sale to
 * flash, and the alerts it earned.
 *
 * When several sales land together — a slow poll, or a hidden tab returning on
 * the keepalive — every one gets a line, but only one can have the banner.
 * `sale` is the last one in PAYLOAD order, which is not necessarily the most
 * recent: the server sends teams by draft order and members by price, and no
 * timestamp reaches the client. That is acceptable rather than ideal (both
 * sales are seconds old and both are in the feed underneath), and it is stated
 * here so nobody reads recency into it later.
 */
export function draftFeedDiff(
  prev: FeedSnapshot,
  next: FeedSnapshot,
): { lines: FeedLine[]; sale: FeedSale | null; alerts: DraftAlert[] } {
  const sold: FeedLine[] = [];
  const lot: FeedLine[] = [];
  const alerts: DraftAlert[] = [];
  let sale: FeedSale | null = null;

  const rostered = new Set(
    prev.teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  for (const t of next.teams) {
    for (const m of t.members) {
      if (m.isCaptain || rostered.has(m.userId)) continue;
      sold.push({
        kind: "sold",
        text: `${m.name} → ${t.name}`,
        amount: m.price,
      });
      const isMe = !!next.me.userId && m.userId === next.me.userId;
      sale = { name: m.name, team: t.name, price: m.price, isMe };
      if (isMe) alerts.push("im-sold");
    }
  }

  const prevNom = prev.nominatedPlayer?.userId ?? null;
  const curNom = next.nominatedPlayer?.userId ?? null;
  if (curNom && curNom !== prevNom) {
    lot.push({
      kind: "nominate",
      text: `${teamName(next, next.nominatorTeamId)} nominated ${next.nominatedPlayer!.name}`,
      amount: next.currentBid,
    });
    // On the block yourself — worth a bell even for a non-captain, who has
    // nothing else on this screen telling them to pay attention.
    if (curNom === next.me.userId) alerts.push("im-nominated");
  } else if (curNom && curNom === prevNom && next.currentBid > prev.currentBid) {
    lot.push({
      kind: "bid",
      text: `${teamName(next, next.currentBidTeamId)} bid`,
      amount: next.currentBid,
    });
  }

  // Your turn to nominate — the moment auto-skip punishes hardest, since the
  // resolver will pick for you when the clock runs out.
  if (next.me.canNominate && !prev.me.canNominate) alerts.push("my-nomination");

  // Newest first: whatever happened to the LOT is later than the sale that
  // freed it.
  return { lines: [...lot, ...sold], sale, alerts };
}
