import { describe, expect, it } from "vitest";
import {
  STANDIN_BOARD_AHEAD_DAYS,
  STANDIN_BOARD_BEHIND_HOURS,
  sortStandinOffers,
  standinArrivalAction,
  standinBoardWindow,
  standinHomeLine,
  standinHubPath,
  standinReleasedToast,
  standinNeedLabel,
  standinOfferCountLabel,
  standinOfferOutcomeLine,
  standinOfferPath,
  standinOfferStanding,
  standinSeatLine,
  standinSideNeed,
  type StandinOfferCommitment,
} from "./standin-offer";

const NIGHT = new Date("2026-11-22T23:00:00Z");

function roster(...mmrs: number[]) {
  return mmrs.map((mmr, i) => ({ userId: `p${i + 1}`, name: `P${i + 1}`, mmr }));
}

const none: ReadonlySet<string> = new Set();

describe("standinSideNeed", () => {
  it("needs nobody when the roster is full and everyone can play", () => {
    expect(
      standinSideNeed({
        teamSize: 5,
        roster: roster(3000, 2800, 2600, 2400, 2200),
        outUserIds: none,
        bookedUserIds: none,
        askedUserIds: none,
        emptySeatsTaken: 0,
      }),
    ).toEqual({ seats: 0, emptySeats: 0, baselineMmr: null });
  });

  it("counts a player who is out and judges the seat by their MMR", () => {
    expect(
      standinSideNeed({
        teamSize: 5,
        roster: roster(3000, 2800, 2600, 2400, 2200),
        outUserIds: new Set(["p2"]),
        bookedUserIds: none,
        askedUserIds: none,
        emptySeatsTaken: 0,
      }),
    ).toEqual({ seats: 1, emptySeats: 0, baselineMmr: 2800 });
  });

  it("judges every out seat by the lowest absentee, as the booking does", () => {
    // p1 (3000) and p4 (2400) are both out: naming p1 still counts as 2400.
    expect(
      standinSideNeed({
        teamSize: 5,
        roster: roster(3000, 2800, 2600, 2400, 2200),
        outUserIds: new Set(["p1", "p4"]),
        bookedUserIds: none,
        askedUserIds: none,
        emptySeatsTaken: 0,
      }),
    ).toEqual({ seats: 2, emptySeats: 0, baselineMmr: 2400 });
  });

  it("leaves out a seat a booking or a waiting request already holds", () => {
    expect(
      standinSideNeed({
        teamSize: 5,
        roster: roster(3000, 2800, 2600, 2400, 2200),
        outUserIds: new Set(["p1", "p2", "p3"]),
        bookedUserIds: new Set(["p1"]),
        askedUserIds: new Set(["p2"]),
        emptySeatsTaken: 0,
      }).seats,
    ).toBe(1);
  });

  it("a request is not cover: its player still lowers the other seats", () => {
    // p4 (2400) is asked for, not booked, so p1's seat still counts as 2400.
    expect(
      standinSideNeed({
        teamSize: 5,
        roster: roster(3000, 2800, 2600, 2400, 2200),
        outUserIds: new Set(["p1", "p4"]),
        bookedUserIds: none,
        askedUserIds: new Set(["p4"]),
        emptySeatsTaken: 0,
      }),
    ).toEqual({ seats: 1, emptySeats: 0, baselineMmr: 2400 });
  });

  it("counts empty roster seats against the team's lowest MMR", () => {
    expect(
      standinSideNeed({
        teamSize: 5,
        roster: roster(3000, 2800, 2600),
        outUserIds: none,
        bookedUserIds: none,
        askedUserIds: none,
        emptySeatsTaken: 1,
      }),
    ).toEqual({ seats: 1, emptySeats: 1, baselineMmr: 2600 });
  });

  it("takes the seat that suits a standin best when seats differ", () => {
    // An empty seat (lowest 2200) and p1 out (3000): the out seat is higher.
    expect(
      standinSideNeed({
        teamSize: 5,
        roster: roster(3000, 2800, 2600, 2200),
        outUserIds: new Set(["p1"]),
        bookedUserIds: none,
        askedUserIds: none,
        emptySeatsTaken: 0,
      }),
    ).toEqual({ seats: 2, emptySeats: 1, baselineMmr: 3000 });
  });

  it("keeps an unknown seat unknown", () => {
    expect(
      standinSideNeed({
        teamSize: 5,
        roster: roster(0, 2800, 2600, 2400, 2200),
        outUserIds: new Set(["p1"]),
        bookedUserIds: none,
        askedUserIds: none,
        emptySeatsTaken: 0,
      }),
    ).toEqual({ seats: 1, emptySeats: 0, baselineMmr: null });
  });
});

describe("standinOfferStanding", () => {
  const need = {
    matchId: "m1",
    teamId: "t1",
    baselineMmr: 2400,
    scheduledAt: NIGHT,
    week: 3,
  };
  const base = {
    signedIn: true,
    activeSignup: true,
    rostered: false,
    mmr: 2450,
    offered: false,
    need,
    commitments: [] as StandinOfferCommitment[],
  };
  const commitment = (
    over: Partial<StandinOfferCommitment>,
  ): StandinOfferCommitment => ({
    matchId: "m2",
    teamId: "t9",
    homeName: "Alpha",
    awayName: "Beta",
    scheduledAt: NIGHT,
    week: 3,
    kind: "booked",
    ...over,
  });

  it("sends a signed-out visitor to sign in", () => {
    expect(standinOfferStanding({ ...base, signedIn: false })).toEqual({
      kind: "signed-out",
    });
  });

  it("sends a player without a signup to register", () => {
    expect(standinOfferStanding({ ...base, activeSignup: false })).toEqual({
      kind: "no-signup",
    });
  });

  it("refuses a rostered player, signup or not", () => {
    expect(standinOfferStanding({ ...base, rostered: true }).kind).toBe(
      "blocked",
    );
    expect(
      standinOfferStanding({ ...base, rostered: true, activeSignup: false })
        .kind,
    ).toBe("blocked");
  });

  it("is open, and books straight away within the allowance", () => {
    expect(standinOfferStanding({ ...base, mmr: 2500 })).toEqual({
      kind: "open",
      outcome: "book",
    });
  });

  it("is open over the allowance, but needs the other captain", () => {
    expect(standinOfferStanding({ ...base, mmr: 2501 })).toEqual({
      kind: "open",
      outcome: "ask",
    });
  });

  it("an unknown MMR on either side needs the other captain", () => {
    expect(standinOfferStanding({ ...base, mmr: 0 })).toEqual({
      kind: "open",
      outcome: "ask",
    });
    expect(
      standinOfferStanding({ ...base, need: { ...need, baselineMmr: null } }),
    ).toEqual({ kind: "open", outcome: "ask" });
  });

  it("says they're on the list once offered", () => {
    expect(standinOfferStanding({ ...base, offered: true })).toEqual({
      kind: "offered",
      outcome: "book",
    });
  });

  it("refuses someone already booked or asked for in this match", () => {
    expect(
      standinOfferStanding({
        ...base,
        commitments: [commitment({ matchId: "m1", teamId: "t2" })],
      }),
    ).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/booked in this match/) });
    expect(
      standinOfferStanding({
        ...base,
        commitments: [commitment({ matchId: "m1", kind: "asked" })],
      }),
    ).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/asked for you/) });
  });

  it("refuses someone declined for this team, but not for the other side", () => {
    expect(
      standinOfferStanding({
        ...base,
        commitments: [
          commitment({ matchId: "m1", teamId: "t1", kind: "declined" }),
        ],
      }).kind,
    ).toBe("blocked");
    expect(
      standinOfferStanding({
        ...base,
        commitments: [
          commitment({ matchId: "m1", teamId: "t2", kind: "declined" }),
        ],
      }).kind,
    ).toBe("open");
  });

  it("refuses a clash with a booking the same night, and names it", () => {
    expect(
      standinOfferStanding({ ...base, commitments: [commitment({})] }),
    ).toEqual({
      kind: "blocked",
      reason: "You're booked for Alpha vs Beta that night.",
    });
  });

  it("a request or a decline elsewhere that night doesn't block", () => {
    expect(
      standinOfferStanding({
        ...base,
        commitments: [
          commitment({ kind: "asked" }),
          commitment({ kind: "declined" }),
        ],
      }).kind,
    ).toBe("open");
  });

  it("a booking another night doesn't block", () => {
    expect(
      standinOfferStanding({
        ...base,
        commitments: [
          commitment({
            scheduledAt: new Date("2026-11-29T23:00:00Z"),
            week: 4,
          }),
        ],
      }).kind,
    ).toBe("open");
  });
});

describe("standinArrivalAction", () => {
  it("does nothing without play, or with no game to answer", () => {
    expect(standinArrivalAction(false, { kind: "open", outcome: "book" })).toBe(
      "none",
    );
    expect(standinArrivalAction(true, null)).toBe("none");
  });

  it("offers once for a player who may, and only says so otherwise", () => {
    expect(standinArrivalAction(true, { kind: "open", outcome: "ask" })).toBe(
      "offer",
    );
    expect(
      standinArrivalAction(true, { kind: "offered", outcome: "book" }),
    ).toBe("already");
    expect(standinArrivalAction(true, { kind: "blocked", reason: "x" })).toBe(
      "blocked",
    );
  });

  it("leaves sign-in and signup to the game's own button", () => {
    expect(standinArrivalAction(true, { kind: "signed-out" })).toBe("none");
    expect(standinArrivalAction(true, { kind: "no-signup" })).toBe("none");
  });
});

describe("board window and copy", () => {
  it("lists kickoffs from just past to a week out", () => {
    const now = Date.UTC(2026, 10, 15, 12);
    const { from, to } = standinBoardWindow(now);
    expect(now - from.getTime()).toBe(STANDIN_BOARD_BEHIND_HOURS * 3_600_000);
    expect(to.getTime() - now).toBe(STANDIN_BOARD_AHEAD_DAYS * 86_400_000);
  });

  it("words the need, the count and the seat", () => {
    expect(standinNeedLabel(1)).toBe("needs a standin");
    expect(standinNeedLabel(2)).toBe("needs 2 standins");
    expect(standinOfferCountLabel(0)).toBe("");
    expect(standinOfferCountLabel(3)).toBe("3 said they can play");
    expect(standinSeatLine(2400)).toBe(
      "Best fit: up to 2,500 MMR. Higher can still offer; the other captain then has to agree.",
    );
    expect(standinSeatLine(null)).toMatch(/unknown/);
  });

  it("says what a pick would do, and never that an offer books", () => {
    expect(standinOfferOutcomeLine("book", "Beta")).toBe(
      "You fit this seat: if the captain picks you, you're in.",
    );
    expect(standinOfferOutcomeLine("ask", "Beta")).toBe(
      "You can offer. If the captain picks you, the Beta captain also has to agree.",
    );
    // Once on the list, only what happens next.
    expect(standinOfferOutcomeLine("book", "Beta", true)).toBe(
      "If the captain picks you, you're in.",
    );
    expect(standinOfferOutcomeLine("ask", "Beta", true)).toBe(
      "If the captain picks you, the Beta captain also has to agree.",
    );
    for (const outcome of ["book", "ask"] as const) {
      expect(standinOfferOutcomeLine(outcome, "Beta")).not.toMatch(/booked|straight away/i);
    }
  });

  it("words Home's line by how many games need someone", () => {
    expect(standinHomeLine(0).text).toMatch(/^No game needs a standin/);
    expect(standinHomeLine(0).cta).toBe("Open the Standins page");
    expect(standinHomeLine(1)).toEqual({
      text: "1 game needs a standin. Say you can play, and that team's captain picks from everyone who did.",
      cta: "See the game",
    });
    expect(standinHomeLine(3).text).toMatch(/^3 games need a standin/);
    expect(standinHomeLine(3).cta).toBe("See the games");
  });

  it("never asks a standin to offer again for a game they're on the list for", () => {
    const raccoons = { teamName: "Raccoons", opponentName: "Straits" };
    expect(standinHomeLine(1, [raccoons])).toEqual({
      title: "You said you can play",
      text: "You're on the list for Raccoons vs Straits. The captain picks, and you're pinged on Discord if it's you.",
      cta: "Open the Standins page",
    });
    expect(standinHomeLine(3, [raccoons]).text).toMatch(
      /Raccoons vs Straits\..* 2 more games need a standin\.$/,
    );
    expect(standinHomeLine(2, [raccoons, raccoons]).text).toMatch(
      /^You're on the list for 2 games\./,
    );
    for (const line of [standinHomeLine(1, [raccoons]), standinHomeLine(4, [raccoons])]) {
      expect(line.text).not.toMatch(/Say you can play/);
    }
  });

  it("links a game on the Standins page, which books nothing", () => {
    expect(standinHubPath("m 1")).toBe("/standins?match=m%201");
    expect(standinHubPath("m1")).not.toContain("play=");
  });

  it("tells a standin who gave their seat back that the captain knows", () => {
    expect(standinReleasedToast("Raccoons")).toBe(
      "You're off this match. The Raccoons captain is told, and the seat is back on the Standins page for someone else.",
    );
  });

  it("builds the shared link", () => {
    expect(standinOfferPath("m1", "t1")).toBe(
      "/standins?match=m1&team=t1&play=1",
    );
  });

  it("orders offers first come, first listed", () => {
    const t = (s: number) => new Date(Date.UTC(2026, 10, 15, 12, 0, s));
    expect(
      sortStandinOffers([
        { userId: "b", createdAt: t(5) },
        { userId: "c", createdAt: t(1) },
        { userId: "a", createdAt: t(5) },
      ]).map((o) => o.userId),
    ).toEqual(["c", "a", "b"]);
  });
});
