import { describe, expect, it } from "vitest";
import {
  FEED_MAX,
  draftFeedDiff,
  draftFeedInvalidated,
  draftFeedResetReason,
  seedDraftFeed,
  type FeedSeedSnapshot,
  type FeedSnapshot,
} from "./draft-feed";

// Draft night's marquee widget, and until now the largest piece of the room
// that no test could reach: 60 lines of diffing inside a useEffect, in a
// project whose vitest env is `node` with no jsdom. The browser spec
// (zz-admin-draft) walks one nomination and one outbid; everything below is a
// transition it never reaches.

const member = (
  userId: string,
  over: Partial<FeedSnapshot["teams"][number]["members"][number]> = {},
) => ({ userId, name: userId.toUpperCase(), isCaptain: false, price: 0, ...over });

const snap = (over: Partial<FeedSnapshot> = {}): FeedSnapshot => ({
  teams: [
    { id: "t1", name: "Alpha", members: [member("cap1", { isCaptain: true })] },
    { id: "t2", name: "Bravo", members: [member("cap2", { isCaptain: true })] },
  ],
  nominatedPlayer: null,
  nominatorTeamId: "t1",
  currentBid: 0,
  currentBidTeamId: null,
  me: { userId: "me", canNominate: false },
  ...over,
});

/** The same snapshot with `userId` sold to team `t` for `price`. */
const withSale = (s: FeedSnapshot, teamId: string, userId: string, price: number) => ({
  ...s,
  teams: s.teams.map((t) =>
    t.id === teamId
      ? { ...t, members: [...t.members, member(userId, { price })] }
      : t,
  ),
});

describe("seedDraftFeed", () => {
  const seed = (over: Partial<FeedSeedSnapshot> = {}): FeedSeedSnapshot => ({
    ...snap(),
    recentSales: [],
    ...over,
  });

  it("is empty on a draft that has not started", () => {
    expect(seedDraftFeed(seed())).toEqual([]);
  });

  it("puts the LIVE nomination at the top, over the recent sales", () => {
    // A captain who reloads mid-lot must see what is on the block first; the
    // feed renders newest-first and the live nomination is the newest thing.
    const lines = seedDraftFeed(
      seed({
        nominatedPlayer: { userId: "p9", name: "Pudge" },
        currentBid: 7,
        recentSales: [{ name: "Sniper", teamName: "Bravo", price: 12 }],
      }),
    );
    expect(lines).toEqual([
      { kind: "nominate", text: "Alpha nominated Pudge", amount: 7 },
      { kind: "sold", text: "Sniper → Bravo", amount: 12 },
    ]);
  });

  it("keeps the server's sale order — newest first", () => {
    const lines = seedDraftFeed(
      seed({
        recentSales: [
          { name: "Third", teamName: "Alpha", price: 3 },
          { name: "Second", teamName: "Bravo", price: 2 },
          { name: "First", teamName: "Alpha", price: 1 },
        ],
      }),
    );
    expect(lines.map((l) => l.amount)).toEqual([3, 2, 1]);
  });

  it("caps at FEED_MAX, trimming the tail rather than the head", () => {
    // Defence in depth, not a live constraint: getDraftState already slices
    // recentSales to 8, so the largest seed production can produce is 9 lines.
    // If that bound is ever widened this is what stops a page load pushing the
    // live nomination off the bottom of the feed.
    const lines = seedDraftFeed(
      seed({
        nominatedPlayer: { userId: "p1", name: "Live" },
        recentSales: Array.from({ length: 20 }, (_, i) => ({
          name: `P${i}`,
          teamName: "Alpha",
          price: i,
        })),
      }),
    );
    expect(lines).toHaveLength(FEED_MAX);
    expect(lines[0].kind).toBe("nominate");
  });

  it("names a missing team '—' rather than rendering undefined", () => {
    const lines = seedDraftFeed(
      seed({
        nominatedPlayer: { userId: "p1", name: "Pudge" },
        nominatorTeamId: "gone",
      }),
    );
    expect(lines[0].text).toBe("— nominated Pudge");
  });
});

describe("draftFeedResetReason", () => {
  const lifecycle = (status: string, snapshot: FeedSnapshot = snap()) => ({
    status,
    teams: snapshot.teams,
    nominatedPlayer: snapshot.nominatedPlayer,
  });

  it("invalidates immediately when an auction is aborted before any sale", () => {
    const before = lifecycle("IN_PROGRESS");
    const after = lifecycle("NOT_STARTED");
    expect(draftFeedResetReason(before, after)).toBe("auction-reset");
    expect(draftFeedInvalidated(before, after)).toBe(true);
  });

  it("invalidates when Undo or a correction retracts a purchased roster row", () => {
    const before = withSale(snap(), "t1", "p1", 14);
    expect(
      draftFeedResetReason(
        lifecycle("IN_PROGRESS", before),
        lifecycle("IN_PROGRESS"),
      ),
    ).toBe("roster-retracted");
  });

  it("invalidates a completed auction that is reopened", () => {
    expect(
      draftFeedResetReason(lifecycle("COMPLETE"), lifecycle("IN_PROGRESS")),
    ).toBe("auction-reopened");
  });

  it("invalidates a mistaken lot when an admin voids it while paused", () => {
    const lot = snap({
      nominatedPlayer: { userId: "p1", name: "Pudge" },
      currentBid: 7,
      currentBidTeamId: "t2",
    });
    expect(
      draftFeedResetReason(lifecycle("PAUSED", lot), lifecycle("PAUSED")),
    ).toBe("lot-voided");
  });

  it("keeps the feed for ordinary nominations, bids, and purchases", () => {
    const base = snap();
    const nominated = snap({
      nominatedPlayer: { userId: "p1", name: "Pudge" },
      currentBid: 1,
    });
    const bid = { ...nominated, currentBid: 7, currentBidTeamId: "t2" };
    const sold = withSale(bid, "t2", "p1", 7);

    expect(
      draftFeedResetReason(
        lifecycle("IN_PROGRESS", base),
        lifecycle("IN_PROGRESS", nominated),
      ),
    ).toBeNull();
    expect(
      draftFeedResetReason(
        lifecycle("IN_PROGRESS", nominated),
        lifecycle("IN_PROGRESS", bid),
      ),
    ).toBeNull();
    expect(
      draftFeedResetReason(
        lifecycle("IN_PROGRESS", bid),
        lifecycle("IN_PROGRESS", sold),
      ),
    ).toBeNull();
    expect(
      draftFeedInvalidated(
        lifecycle("IN_PROGRESS", bid),
        lifecycle("IN_PROGRESS", sold),
      ),
    ).toBe(false);
  });

  it("does not confuse a captaincy flag change with a retracted purchase", () => {
    const before = snap({
      teams: [
        {
          id: "t1",
          name: "Alpha",
          members: [
            member("oldcap", { isCaptain: true }),
            member("newcap", { isCaptain: false, price: 5 }),
          ],
        },
      ],
    });
    const after = snap({
      teams: [
        {
          id: "t1",
          name: "Alpha",
          members: [
            member("oldcap", { isCaptain: false }),
            member("newcap", { isCaptain: true, price: 5 }),
          ],
        },
      ],
    });
    expect(
      draftFeedResetReason(
        lifecycle("COMPLETE", before),
        lifecycle("COMPLETE", after),
      ),
    ).toBeNull();
  });
});

describe("draftFeedDiff", () => {
  it("says nothing when nothing changed", () => {
    const s = snap({ nominatedPlayer: { userId: "p1", name: "Pudge" }, currentBid: 3 });
    expect(draftFeedDiff(s, s)).toEqual({ lines: [], sale: null, alerts: [] });
  });

  it("logs a sale and flashes it", () => {
    const before = snap();
    const after = withSale(before, "t1", "p1", 14);
    const { lines, sale } = draftFeedDiff(before, after);
    expect(lines).toEqual([{ kind: "sold", text: "P1 → Alpha", amount: 14 }]);
    expect(sale).toEqual({ name: "P1", team: "Alpha", price: 14, isMe: false });
  });

  it("does NOT report a captain as a sale", () => {
    // Captains arrive on their team as a roster row like anyone else. Reading
    // one as a sale would announce "CAP3 → Charlie, $0" to the whole room the
    // first time a team appears.
    const before = snap();
    const after = {
      ...before,
      teams: [
        {
          id: "t3",
          name: "Charlie",
          members: [member("cap3", { isCaptain: true })],
        },
        ...before.teams,
      ],
    };
    expect(draftFeedDiff(before, after).lines).toEqual([]);
  });

  it("does NOT report a demoted captain as a sale", () => {
    // The case the previous-rosters set really guards, and the reason it is
    // built from ALL members rather than the non-captains: transferCaptaincy
    // flips `isCaptain` to false while leaving that player rostered, and it is
    // legal in exactly the two states where this room is open and polling (the
    // waiting room, and after COMPLETE). Filter captains out of the set and
    // the next poll announces the outgoing captain as a fresh signing.
    const before = snap({
      teams: [
        {
          id: "t1",
          name: "Alpha",
          members: [member("oldcap", { isCaptain: true, price: 0 })],
        },
      ],
    });
    const after = snap({
      teams: [
        {
          id: "t1",
          name: "Alpha",
          members: [
            member("newcap", { isCaptain: true }),
            member("oldcap", { isCaptain: false, price: 0 }),
          ],
        },
      ],
    });
    expect(draftFeedDiff(before, after).lines).toEqual([]);
    expect(draftFeedDiff(before, after).sale).toBeNull();
  });

  it("rings only when the person sold is the VIEWER", () => {
    const before = snap();
    expect(draftFeedDiff(before, withSale(before, "t1", "p1", 5)).alerts).toEqual([]);
    expect(draftFeedDiff(before, withSale(before, "t1", "me", 5)).alerts).toEqual([
      "im-sold",
    ]);
  });

  it("never rings for a signed-out viewer, whoever is sold", () => {
    // `me.userId` is null then, and a null-vs-null match would ring the bell
    // for every sale in the draft.
    const before = snap({ me: { userId: null, canNominate: false } });
    const after = withSale(before, "t1", "p1", 5);
    expect(draftFeedDiff(before, after).alerts).toEqual([]);
    expect(draftFeedDiff(before, after).sale?.isMe).toBe(false);
  });

  it("logs EVERY sale but flashes the last one in PAYLOAD order", () => {
    // Reachable on a slow poll or a hidden tab on the 5s keepalive. Only one
    // banner exists, and the payload gives it nothing to rank by: the server
    // sends teams by draft order and members by price, never by time. So this
    // is "an arbitrary one of them", deliberately — both are seconds old and
    // both are in the feed. Do not let a comment or a name imply recency.
    const before = snap();
    const after = withSale(withSale(before, "t1", "p1", 4), "t2", "p2", 9);
    const { lines, sale } = draftFeedDiff(before, after);
    expect(lines.map((l) => l.text)).toEqual(["P1 → Alpha", "P2 → Bravo"]);
    expect(sale?.name).toBe("P2");
  });

  it("logs a fresh nomination, and rings if it is the viewer on the block", () => {
    const before = snap();
    const after = snap({
      nominatedPlayer: { userId: "p1", name: "Pudge" },
      nominatorTeamId: "t2",
      currentBid: 1,
    });
    const { lines, alerts } = draftFeedDiff(before, after);
    expect(lines).toEqual([
      { kind: "nominate", text: "Bravo nominated Pudge", amount: 1 },
    ]);
    expect(alerts).toEqual([]);

    const meOnBlock = snap({
      nominatedPlayer: { userId: "me", name: "Me" },
      currentBid: 1,
    });
    expect(draftFeedDiff(before, meOnBlock).alerts).toEqual(["im-nominated"]);
  });

  it("does not re-log the same nomination on every poll", () => {
    // The lot is polled at 1.2s; without the changed-id guard the feed would
    // fill with the same line twelve times in fifteen seconds.
    const lot = snap({ nominatedPlayer: { userId: "p1", name: "Pudge" }, currentBid: 1 });
    expect(draftFeedDiff(lot, lot).lines).toEqual([]);
  });

  it("logs a bid only while the lot is unchanged", () => {
    const at1 = snap({
      nominatedPlayer: { userId: "p1", name: "Pudge" },
      currentBid: 1,
      currentBidTeamId: "t1",
    });
    const at5 = { ...at1, currentBid: 5, currentBidTeamId: "t2" };
    expect(draftFeedDiff(at1, at5).lines).toEqual([
      { kind: "bid", text: "Bravo bid", amount: 5 },
    ]);
  });

  it("collapses two bids inside one poll into one line at the higher amount", () => {
    // The feed is a highlight reel; the lot's own bid trail (served as
    // `lotBids`) is the audit log that has every bid.
    const at1 = snap({
      nominatedPlayer: { userId: "p1", name: "Pudge" },
      currentBid: 1,
      currentBidTeamId: "t1",
    });
    const at9 = { ...at1, currentBid: 9, currentBidTeamId: "t1" };
    expect(draftFeedDiff(at1, at9).lines).toEqual([
      { kind: "bid", text: "Alpha bid", amount: 9 },
    ]);
  });

  it("never logs a bid that did not raise the price", () => {
    const at5 = snap({
      nominatedPlayer: { userId: "p1", name: "Pudge" },
      currentBid: 5,
      currentBidTeamId: "t1",
    });
    expect(draftFeedDiff(at5, { ...at5, currentBidTeamId: "t2" }).lines).toEqual([]);
    expect(draftFeedDiff(at5, { ...at5, currentBid: 4 }).lines).toEqual([]);
  });

  it("logs a nomination, never a bid, when the lot itself changed", () => {
    // A sale resolving into the next nomination moves BOTH the player and the
    // price. Only the nomination is true; a "bid" line there would credit the
    // new nominator with a bid nobody made.
    const oldLot = snap({
      nominatedPlayer: { userId: "p1", name: "Pudge" },
      currentBid: 12,
      currentBidTeamId: "t1",
    });
    const newLot = snap({
      nominatedPlayer: { userId: "p2", name: "Sniper" },
      nominatorTeamId: "t2",
      currentBid: 1,
      currentBidTeamId: null,
    });
    const { lines } = draftFeedDiff(oldLot, newLot);
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("nominate");
  });

  it("puts the NOMINATION above the sale it resolved into", () => {
    // One poll routinely carries both: getDraftState runs the expiry resolver
    // and the stalled-nomination resolver before it reads, so any tab coming
    // back from hidden gets the sale and the next lot together. The room
    // prepends this array whole and renders index 0 at the top, so the newer
    // event has to come first — the seed has always ordered itself that way,
    // and the diff used to contradict it.
    const before = snap({
      nominatedPlayer: { userId: "p1", name: "Pudge" },
      currentBid: 12,
      currentBidTeamId: "t1",
    });
    const after = withSale(
      snap({ nominatedPlayer: { userId: "p2", name: "Sniper" }, currentBid: 1 }),
      "t1",
      "p1",
      12,
    );
    expect(draftFeedDiff(before, after).lines.map((l) => l.kind)).toEqual([
      "nominate",
      "sold",
    ]);
  });

  it("handles the commonest transition in a draft: the lot clearing on a sale", () => {
    // ~40 times a night. resolveExpiredNomination writes the roster row and
    // `nominatedUserId: null, currentBid: 0, currentBidTeamId: null` in ONE
    // transaction, and that same payload is the one that flips the next
    // captain's `canNominate` true — so the sale line, the SOLD! flash and the
    // your-turn bell all ride this single diff. Without the truthiness guard
    // on `curNom` it also tries to name a nomination that is null, which
    // throws inside the room's effect.
    const before = snap({
      nominatedPlayer: { userId: "p1", name: "Pudge" },
      currentBid: 12,
      currentBidTeamId: "t2",
      me: { userId: "me", canNominate: false },
    });
    const after = withSale(
      snap({
        nominatedPlayer: null,
        currentBid: 0,
        currentBidTeamId: null,
        me: { userId: "me", canNominate: true },
      }),
      "t2",
      "p1",
      12,
    );

    const { lines, sale, alerts } = draftFeedDiff(before, after);
    expect(lines).toEqual([{ kind: "sold", text: "P1 → Bravo", amount: 12 }]);
    expect(sale).toEqual({ name: "P1", team: "Bravo", price: 12, isMe: false });
    expect(alerts).toEqual(["my-nomination"]);
  });

  it("rings on the RISING edge of your turn to nominate", () => {
    const off = snap();
    const on = snap({ me: { userId: "me", canNominate: true } });
    expect(draftFeedDiff(off, on).alerts).toEqual(["my-nomination"]);
    expect(draftFeedDiff(on, on).alerts).toEqual([]);
    expect(draftFeedDiff(on, off).alerts).toEqual([]);
  });

  it("reports several alerts at once (the room still rings once)", () => {
    // Being sold and being handed the nomination can land together — an admin
    // nominating on your behalf right after your lot resolves. Two
    // playChime() calls in one commit double-strike the same AudioContext.
    const before = snap();
    const after = withSale(
      snap({ me: { userId: "me", canNominate: true } }),
      "t1",
      "me",
      8,
    );
    expect(draftFeedDiff(before, after).alerts).toEqual(["im-sold", "my-nomination"]);
  });

  it("does not mutate either payload", () => {
    // Both are React state; the room re-renders off them.
    const before = snap();
    const after = withSale(before, "t1", "p1", 4);
    const beforeCopy = JSON.parse(JSON.stringify(before));
    const afterCopy = JSON.parse(JSON.stringify(after));
    draftFeedDiff(before, after);
    expect(before).toEqual(beforeCopy);
    expect(after).toEqual(afterCopy);
  });
});
