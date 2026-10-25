import { describe, it, expect } from "vitest";
import {
  coverBaselineMmr,
  coverChoices,
  standinApprovalReason,
  standinConflict,
  standinMmrLabel,
  standinNeedsApproval,
  standinPickerBlock,
  STANDIN_CONFLICT_HOURS,
  STANDIN_MMR_ALLOWANCE,
} from "./standin";

const at = (iso: string) => new Date(iso);

describe("standinConflict", () => {
  it("catches the same kickoff — one person, two lobbies", () => {
    expect(
      standinConflict(
        { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 },
        { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 },
      ),
    ).toBe(true);
  });

  it("catches a nearby kickoff — a Bo3 runs well past its start", () => {
    expect(
      standinConflict(
        { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 },
        { scheduledAt: at("2026-08-02T20:00:00Z"), week: 3 },
      ),
    ).toBe(true);
  });

  it("allows genuinely separate nights", () => {
    expect(
      standinConflict(
        { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 },
        { scheduledAt: at("2026-08-05T18:00:00Z"), week: 3 },
      ),
    ).toBe(false);
  });

  it("is exclusive at the boundary — exactly the window apart is fine", () => {
    const base = at("2026-08-02T18:00:00Z");
    const edge = new Date(
      base.getTime() + STANDIN_CONFLICT_HOURS * 60 * 60 * 1000,
    );
    expect(
      standinConflict({ scheduledAt: base, week: 3 }, { scheduledAt: edge, week: 3 }),
    ).toBe(false);
  });

  it("is symmetric", () => {
    const a = { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 };
    const b = { scheduledAt: at("2026-08-02T19:00:00Z"), week: 3 };
    expect(standinConflict(a, b)).toBe(standinConflict(b, a));
  });

  // No kickoff to compare, so fall back to the week — the league plays one
  // round a week, so "same week" is the same night until told otherwise.
  it("falls back to the week when a kickoff is missing", () => {
    expect(
      standinConflict(
        { scheduledAt: null, week: 3 },
        { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 },
      ),
    ).toBe(true);
    expect(
      standinConflict({ scheduledAt: null, week: 3 }, { scheduledAt: null, week: 4 }),
    ).toBe(false);
  });
});

// Tim's rule (2026-10-21): a captain books a standin up to the allowance
// above the seat; past it, or with an MMR the site doesn't know, the other
// captain has to agree.
describe("standinNeedsApproval", () => {
  // Pins the boundary the rules page states: "at most 100 above" is fine.
  it("lets a captain book up to the allowance above, and asks past it", () => {
    expect(standinNeedsApproval(2400 + STANDIN_MMR_ALLOWANCE, 2400)).toBe(false);
    expect(standinNeedsApproval(2400 + STANDIN_MMR_ALLOWANCE + 1, 2400)).toBe(true);
  });

  // Covering down or level is the ordinary case and never asks anyone.
  it("never asks for a standin at or below the seat", () => {
    expect(standinNeedsApproval(1800, 2400)).toBe(false);
    expect(standinNeedsApproval(2400, 2400)).toBe(false);
  });

  // Pins the unknown rule: 0 must not pass as "close enough", or leaving the
  // MMR blank would make anyone a free ringer; the other captain judges it.
  it("asks whenever either MMR is unknown", () => {
    expect(standinNeedsApproval(0, 2400)).toBe(true);
    expect(standinNeedsApproval(2400, null)).toBe(true);
    expect(standinNeedsApproval(2400, 0)).toBe(true);
  });
});

describe("coverBaselineMmr", () => {
  it("named cover: the covered player's MMR, with 0 or none as unknown", () => {
    expect(coverBaselineMmr({ replacedMmr: 2400 })).toBe(2400);
    expect(coverBaselineMmr({ replacedMmr: 0 })).toBeNull();
    expect(coverBaselineMmr({ replacedMmr: null })).toBeNull();
  });

  // Pins the empty-seat yardstick: the team's lowest KNOWN MMR, so a short
  // side can't field a stronger fifth than covering its weakest seat allows.
  it("empty seat: the roster's lowest known MMR", () => {
    expect(coverBaselineMmr({ rosterMmrs: [3100, 2400, 0, 2900] })).toBe(2400);
    expect(coverBaselineMmr({ rosterMmrs: [0, 0] })).toBeNull();
    expect(coverBaselineMmr({ rosterMmrs: [] })).toBeNull();
  });
});

describe("standinApprovalReason", () => {
  // Every branch is a clause that reads after "since", and carries no player
  // name, so the same words are safe in a Discord post.
  it("says how far above, measured against the right seat", () => {
    expect(
      standinApprovalReason({ standinMmr: 3100, baselineMmr: 2400, emptySeat: false }),
    ).toBe("the standin is 700 MMR above the player they cover");
    expect(
      standinApprovalReason({ standinMmr: 3500, baselineMmr: 2400, emptySeat: true }),
    ).toBe("the standin is 1,100 MMR above the team's lowest-MMR player");
  });

  it("names which MMR is unknown", () => {
    expect(
      standinApprovalReason({ standinMmr: 0, baselineMmr: 2400, emptySeat: false }),
    ).toBe("the standin's MMR is unknown");
    expect(
      standinApprovalReason({ standinMmr: 2400, baselineMmr: null, emptySeat: false }),
    ).toBe("the covered player's MMR is unknown");
    expect(
      standinApprovalReason({ standinMmr: 2400, baselineMmr: null, emptySeat: true }),
    ).toBe("nobody on the team has a known MMR to compare with");
  });

  it("formats numbers with a fixed locale", () => {
    expect(standinMmrLabel(3100)).toBe("3,100 MMR");
    expect(standinMmrLabel(0)).toBe("MMR unknown");
    expect(standinMmrLabel(null)).toBe("MMR unknown");
  });
});

describe("standinPickerBlock", () => {
  const target = {
    matchId: "m1",
    scheduledAt: at("2026-08-02T18:00:00Z"),
    week: 3,
  };
  const booking = (over: Partial<Parameters<typeof standinPickerBlock>[2][number]>) => ({
    standinUserId: "alice",
    matchId: "m2",
    replacedName: "Player5",
    homeName: "Pudge Party",
    awayName: "Techies",
    scheduledAt: at("2026-08-09T18:00:00Z"),
    week: 4,
    ...over,
  });

  it("offers a standin with no bookings", () => {
    expect(standinPickerBlock("alice", target, [])).toBeNull();
  });

  it("names the seat they already cover in this match", () => {
    expect(
      standinPickerBlock("alice", target, [booking({ matchId: "m1" })]),
    ).toBe("covering Player5 in this match");
    expect(
      standinPickerBlock("alice", target, [
        booking({ matchId: "m1", replacedName: null }),
      ]),
    ).toBe("filling an open seat in this match");
  });

  it("names the other fixture they are booked for the same night", () => {
    expect(
      standinPickerBlock("alice", target, [
        booking({ scheduledAt: at("2026-08-02T20:00:00Z"), week: 3 }),
      ]),
    ).toBe("booked for Pudge Party vs Techies that night");
  });

  it("uses the server's clash rule: a week apart is fine, same week unset is not", () => {
    expect(standinPickerBlock("alice", target, [booking({})])).toBeNull();
    expect(
      standinPickerBlock("alice", target, [
        booking({ scheduledAt: null, week: 3 }),
      ]),
    ).toBe("booked for Pudge Party vs Techies that night");
  });

  it("only reads the candidate's own bookings", () => {
    expect(
      standinPickerBlock("bob", target, [booking({ matchId: "m1" })]),
    ).toBeNull();
  });

  // The server refuses a standin with a request waiting in this match, but a
  // request elsewhere isn't a booking yet: agreeing to it re-checks the night.
  it("holds a standin with a request in this match, not one elsewhere", () => {
    expect(
      standinPickerBlock("alice", target, [
        booking({ matchId: "m1", pending: true }),
      ]),
    ).toBe("waiting for the other captain's OK in this match");
    expect(
      standinPickerBlock("alice", target, [
        booking({ scheduledAt: at("2026-08-02T20:00:00Z"), week: 3, pending: true }),
      ]),
    ).toBeNull();
  });
});

describe("coverChoices", () => {
  const roster = [
    { userId: "p1", name: "Player1" },
    { userId: "p2", name: "Player2" },
    { userId: "p3", name: "Player3" },
    { userId: "p4", name: "Player4" },
  ];

  it("keeps roster order when nobody is out", () => {
    const { choices, preselect } = coverChoices(roster, new Set(), new Set());
    expect(choices.map((c) => c.member.userId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(choices.every((c) => !c.out)).toBe(true);
    expect(preselect).toBeNull();
  });

  it("puts the uncovered out player first and pre-selects them", () => {
    const { choices, preselect } = coverChoices(
      roster,
      new Set(["p3"]),
      new Set(),
    );
    expect(choices.map((c) => c.member.userId)).toEqual(["p3", "p1", "p2", "p4"]);
    expect(choices[0].out).toBe(true);
    expect(preselect).toBe("p3");
  });

  it("drops covered players, even out ones, and never guesses between two", () => {
    const { choices, preselect } = coverChoices(
      roster,
      new Set(["p2", "p3", "p4"]),
      new Set(["p4"]),
    );
    expect(choices.map((c) => [c.member.userId, c.out])).toEqual([
      ["p2", true],
      ["p3", true],
      ["p1", false],
    ]);
    expect(preselect).toBeNull();
  });
});
