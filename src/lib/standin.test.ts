import { describe, it, expect } from "vitest";
import {
  agreeTooLateError,
  coverBaselineMmr,
  coverChoices,
  namedCoverBaseline,
  standinApprovalReason,
  standinConflict,
  standinDeclinedError,
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

// The lowest-out loophole: naming the strongest player as "covered" while
// the standin really takes a weaker absentee's seat.
describe("namedCoverBaseline", () => {
  const teammates = [
    { userId: "high", name: "High", mmr: 3200 },
    { userId: "mid", name: "Mid", mmr: 2600 },
    { userId: "low", name: "Low", mmr: 2000 },
    { userId: "anon", name: "Anon", mmr: 0 },
  ];
  const judge = (
    replaced: { userId: string; mmr: number | null },
    out: string[],
    covered: string[] = [],
  ) =>
    namedCoverBaseline({
      replaced,
      teammates,
      outUserIds: new Set(out),
      coveredUserIds: new Set(covered),
    });

  it("is the covered player's MMR when nobody lower is out", () => {
    expect(judge({ userId: "high", mmr: 3200 }, [])).toEqual({
      baselineMmr: 3200,
      lowerOut: null,
    });
    // Out but higher than the named player: no effect.
    expect(judge({ userId: "low", mmr: 2000 }, ["mid"])).toEqual({
      baselineMmr: 2000,
      lowerOut: null,
    });
  });

  it("drops to the lowest uncovered teammate who said they can't make it", () => {
    expect(judge({ userId: "high", mmr: 3200 }, ["mid", "low"])).toEqual({
      baselineMmr: 2000,
      lowerOut: { userId: "low", name: "Low", mmr: 2000 },
    });
    // Booked players are already accounted for (the caller passes bookings
    // only: a request is not cover).
    expect(judge({ userId: "high", mmr: 3200 }, ["mid", "low"], ["low"])).toEqual({
      baselineMmr: 2600,
      lowerOut: { userId: "mid", name: "Mid", mmr: 2600 },
    });
  });

  it("never lowers it with an unknown MMR, and an unknown named player stays unknown", () => {
    expect(judge({ userId: "high", mmr: 3200 }, ["anon"])).toEqual({
      baselineMmr: 3200,
      lowerOut: null,
    });
    expect(judge({ userId: "high", mmr: 0 }, ["low"])).toEqual({
      baselineMmr: null,
      lowerOut: null,
    });
    expect(judge({ userId: "high", mmr: null }, ["low"])).toEqual({
      baselineMmr: null,
      lowerOut: null,
    });
  });

  it("ignores the named player's own row and a tie, and breaks ties by id", () => {
    expect(judge({ userId: "low", mmr: 2000 }, ["low"])).toEqual({
      baselineMmr: 2000,
      lowerOut: null,
    });
    expect(judge({ userId: "high", mmr: 2000 }, ["low"])).toEqual({
      baselineMmr: 2000,
      lowerOut: null,
    });
    const twins = namedCoverBaseline({
      replaced: { userId: "high", mmr: 3200 },
      teammates: [
        { userId: "b", name: "B", mmr: 2000 },
        { userId: "a", name: "A", mmr: 2000 },
      ],
      outUserIds: new Set(["a", "b"]),
      coveredUserIds: new Set(),
    });
    expect(twins.lowerOut?.userId).toBe("a");
  });
});

describe("standinApprovalReason", () => {
  // Every branch is a clause that reads after "since"; the only name it
  // carries is the lower teammate's, which the caller formats.
  it("names the lower teammate who said they can't make it", () => {
    expect(
      standinApprovalReason({
        standinMmr: 2300,
        baselineMmr: 2000,
        emptySeat: false,
        lowerOutName: "Low Lou",
      }),
    ).toBe("the standin is 300 MMR above Low Lou (2,000), who said they can't make it");
    // Unknown wins over the name: there is no gap to state.
    expect(
      standinApprovalReason({
        standinMmr: 0,
        baselineMmr: 2000,
        emptySeat: false,
        lowerOutName: "Low Lou",
      }),
    ).toBe("the standin's MMR is unknown");
  });

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

  // The server refuses asking again for a standin the other captain declined
  // for this team in this match; a booking or a waiting request here wins.
  it("greys out a standin the other captain declined here, and only here", () => {
    const declined = booking({ matchId: "m1", replacedName: null, declinedBy: "Techies" });
    expect(standinPickerBlock("alice", target, [declined])).toBe(
      "already declined for your team in this match",
    );
    expect(
      standinPickerBlock("alice", target, [
        declined,
        booking({ matchId: "m1", pending: true }),
      ]),
    ).toBe("waiting for the other captain's OK in this match");
    // A declined request is no booking: elsewhere the same night it holds nothing.
    expect(
      standinPickerBlock("alice", target, [
        booking({
          matchId: "m9",
          declinedBy: "Techies",
          scheduledAt: at("2026-08-02T18:00:00Z"),
          week: 3,
        }),
      ]),
    ).toBeNull();
  });
});

describe("agreeTooLateError", () => {
  // The booking check's advice is for whoever books; the approver is told to
  // decline instead.
  it("keeps the reason, drops the booker's advice, and says to decline", () => {
    expect(agreeTooLateError("This match is already played", "Radiant")).toBe(
      "This can't be agreed to any more: This match is already played — decline it so Radiant can line up someone else",
    );
    expect(
      agreeTooLateError(
        "Sub Sam is already covering A vs B that night — they can't play both. Remove that assignment first.",
        "Radiant",
      ),
    ).toBe(
      "This can't be agreed to any more: Sub Sam is already covering A vs B that night — decline it so Radiant can line up someone else",
    );
    expect(
      agreeTooLateError("That standin has no active signup this season", "Radiant"),
    ).toBe(
      "This can't be agreed to any more: That standin has no active signup this season — decline it so Radiant can line up someone else",
    );
  });

  // A reason can open with a standin's name, and a name keeps its case:
  // "The Rock" is not "the Rock".
  it("never changes the reason's case", () => {
    expect(
      agreeTooLateError(
        "The Rock is already covering A vs B that night — they can't play both. Remove that assignment first.",
        "Radiant",
      ),
    ).toBe(
      "This can't be agreed to any more: The Rock is already covering A vs B that night — decline it so Radiant can line up someone else",
    );
    expect(agreeTooLateError("That match was moved.", "Radiant")).toBe(
      "This can't be agreed to any more: That match was moved — decline it so Radiant can line up someone else",
    );
  });

  // Not attributed to the other captain: an admin may have declined.
  it("words the declined refusal for the asking captain", () => {
    expect(standinDeclinedError("Sub Sam", "Radiant")).toBe(
      "Sub Sam was already declined for Radiant in this match — pick someone else, or ask an admin",
    );
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
