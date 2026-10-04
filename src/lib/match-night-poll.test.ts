import { describe, expect, it } from "vitest";
import {
  POLL_MAX_SLOTS,
  POLL_RESULT_DAYS,
  eliminatedInRound,
  instantRunoff,
  nextSlotOccurrence,
  ordinal,
  parseRanking,
  parseSlotRows,
  parseSlots,
  parseTimeOfDay,
  pollOnHome,
  pollOpen,
  pollResultsVisible,
  roundStory,
  roundTransfers,
  runoffPlacement,
  slotKey,
  slotLabel,
  slotTime,
  yourSlotTime,
  type PollSlot,
} from "./match-night-poll";

const SUN_18: PollSlot = { day: 0, minute: 18 * 60 };
const WED_20: PollSlot = { day: 3, minute: 20 * 60 };
const SAT_17: PollSlot = { day: 6, minute: 17 * 60 };

/** n copies of one ballot. */
function times(n: number, ballot: string[]): string[][] {
  return Array.from({ length: n }, () => ballot);
}

describe("slots", () => {
  it("keys a slot by weekday and minute", () => {
    expect(slotKey(SUN_18)).toBe("0@1080");
  });

  it("reads stored slots and drops garbage instead of throwing", () => {
    expect(parseSlots('[{"day":0,"minute":1080},{"day":3,"minute":1200}]')).toEqual([
      SUN_18,
      WED_20,
    ]);
    expect(parseSlots("not json")).toEqual([]);
    expect(parseSlots('{"day":0}')).toEqual([]);
    expect(
      parseSlots(
        '[{"day":7,"minute":0},{"day":0,"minute":1440},{"day":1.5,"minute":0},null,{"day":0,"minute":1080},{"day":0,"minute":1080}]',
      ),
    ).toEqual([SUN_18]);
  });

  it("parses an <input type=time> value", () => {
    expect(parseTimeOfDay("19:30")).toBe(19 * 60 + 30);
    expect(parseTimeOfDay("7:05")).toBe(7 * 60 + 5);
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("12:60")).toBeNull();
    expect(parseTimeOfDay("noon")).toBeNull();
  });

  it("turns the admin's rows into slots, Monday first, skipping blank rows", () => {
    expect(
      parseSlotRows(["0", "", "3", "6"], ["18:00", "", "20:00", "17:00"]),
    ).toEqual({ slots: [WED_20, SAT_17, SUN_18] });
  });

  it("refuses a half-filled row, a repeat, or a count outside the limits by name", () => {
    expect(parseSlotRows(["0", "3"], ["18:00", ""])).toEqual({
      error: "Slot 2 needs both a day and a time.",
    });
    expect(parseSlotRows(["0", "0"], ["18:00", "18:00"])).toEqual({
      error: "Sundays at 6:00 PM is listed twice.",
    });
    expect(parseSlotRows(["9", "0"], ["18:00", "19:00"])).toEqual({
      error: "Slot 1 isn't a real day and time.",
    });
    expect(parseSlotRows(["0"], ["18:00"])).toEqual({
      error: "Offer at least 2 slots to vote between.",
    });
    const many = Array.from({ length: POLL_MAX_SLOTS + 1 }, (_, i) => i);
    expect(
      parseSlotRows(
        many.map((i) => String(i % 7)),
        many.map((i) => `${10 + i}:00`),
      ),
    ).toEqual({ error: `A poll can offer at most ${POLL_MAX_SLOTS} slots.` });
  });

  it("reads a ballot, dropping unknown slots and repeats (the higher rank stays)", () => {
    const slots = [SUN_18, WED_20, SAT_17];
    expect(parseRanking('["3@1200","0@1080","3@1200","9@9"]', slots)).toEqual([
      "3@1200",
      "0@1080",
    ]);
    expect(parseRanking("[]", slots)).toEqual([]);
    expect(parseRanking("garbage", slots)).toEqual([]);
    expect(parseRanking('{"a":1}', slots)).toEqual([]);
  });
});

describe("labels", () => {
  it("names a slot the way the season's match night is printed", () => {
    expect(slotLabel(SUN_18, "America/Los_Angeles", "en-US")).toBe(
      "Sundays at 6:00 PM Pacific time",
    );
    expect(slotLabel(WED_20, "Europe/Berlin", "en-GB")).toBe(
      "Wednesdays at 20:00 Berlin time",
    );
    expect(slotTime(0, "en-US")).toBe("12:00 AM");
    expect(slotTime(13 * 60 + 5, "en-GB")).toBe("13:05");
  });

  it("orders ballot positions", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd",
    ]);
  });
});

describe("nextSlotOccurrence", () => {
  const LA = "America/Los_Angeles";

  it("finds the next time the slot comes round on the league's clock", () => {
    // Wednesday 2026-10-07 12:00 Pacific (19:00 UTC).
    const now = Date.UTC(2026, 9, 7, 19, 0);
    // Sunday 2026-10-11 18:00 PDT = 2026-10-12 01:00 UTC.
    expect(nextSlotOccurrence(SUN_18, now, LA)).toBe(Date.UTC(2026, 9, 12, 1, 0));
    // Later the same day.
    expect(nextSlotOccurrence(WED_20, now, LA)).toBe(Date.UTC(2026, 9, 8, 3, 0));
  });

  it("treats a slot that is now, or earlier today, as next week's", () => {
    const now = Date.UTC(2026, 9, 8, 3, 0); // Wednesday 20:00 Pacific exactly
    expect(nextSlotOccurrence(WED_20, now, LA)).toBe(Date.UTC(2026, 9, 15, 3, 0));
  });

  it("keeps the local time across a daylight-saving change", () => {
    // Saturday 2026-10-31 noon PDT; the clocks go back on Sunday 1 November.
    const now = Date.UTC(2026, 9, 31, 19, 0);
    // Sunday 2026-11-01 18:00 PST = 2026-11-02 02:00 UTC (not 01:00).
    expect(nextSlotOccurrence(SUN_18, now, LA)).toBe(Date.UTC(2026, 10, 2, 2, 0));
  });
});

describe("yourSlotTime", () => {
  const sundayEvening = Date.UTC(2026, 9, 12, 1, 0); // Sun 18:00 Pacific

  it("says what the slot is on the viewer's clock", () => {
    expect(
      yourSlotTime(sundayEvening, "America/Los_Angeles", "America/New_York", "en-US"),
    ).toBe("Sun 9:00 PM your time");
    expect(
      yourSlotTime(sundayEvening, "America/Los_Angeles", "Europe/London", "en-GB"),
    ).toBe("Mon 02:00 your time");
  });

  it("says nothing when both clocks agree, or the viewer's zone is unknown", () => {
    expect(
      yourSlotTime(sundayEvening, "America/Los_Angeles", "America/Los_Angeles"),
    ).toBeNull();
    expect(yourSlotTime(sundayEvening, "America/Los_Angeles", "Etc/Unknown")).toBeNull();
    expect(yourSlotTime(Number.NaN, "America/Los_Angeles", "UTC")).toBeNull();
  });
});

describe("poll state", () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const day = 24 * 60 * 60 * 1000;

  it("is open until closesAt, and on Home for a week after", () => {
    expect(pollOpen({ closesAt: new Date(now + 1) }, now)).toBe(true);
    expect(pollOpen({ closesAt: new Date(now) }, now)).toBe(false);
    expect(pollOnHome({ closesAt: new Date(now - (POLL_RESULT_DAYS * day - 1)) }, now)).toBe(true);
    expect(pollOnHome({ closesAt: new Date(now - POLL_RESULT_DAYS * day) }, now)).toBe(false);
  });

  it("shows the standings to voters and admins while open, to everyone once closed", () => {
    expect(pollResultsVisible({ open: true, hasVoted: false, isAdmin: false })).toBe(false);
    expect(pollResultsVisible({ open: true, hasVoted: true, isAdmin: false })).toBe(true);
    expect(pollResultsVisible({ open: true, hasVoted: false, isAdmin: true })).toBe(true);
    expect(pollResultsVisible({ open: false, hasVoted: false, isAdmin: false })).toBe(true);
  });
});

describe("instantRunoff", () => {
  const A = "A";
  const B = "B";
  const C = "C";
  const D = "D";

  it("has no winner and no rounds when nobody ranked anything", () => {
    expect(instantRunoff([A, B], [])).toEqual({
      ballots: 0,
      rounds: [],
      winner: null,
      reach: { A: 0, B: 0 },
    });
    const empty = instantRunoff([A, B], [[], []]);
    expect(empty.ballots).toBe(2);
    expect(empty.winner).toBeNull();
  });

  it("crowns a first-round majority without a runoff", () => {
    const result = instantRunoff([A, B, C], [
      ...times(3, [A]),
      ...times(1, [B]),
      ...times(1, [C]),
    ]);
    expect(result.winner).toBe(A);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].eliminated).toEqual([]);
  });

  it("moves a dropped slot's ballots to their next choice", () => {
    // A leads on first choices, but C's voters prefer B to A.
    const result = instantRunoff([A, B, C], [
      ...times(4, [A, B]),
      ...times(3, [B, A]),
      ...times(2, [C, B]),
    ]);
    expect(result.rounds.map((r) => r.tallies)).toEqual([
      [
        { key: A, votes: 4 },
        { key: B, votes: 3 },
        { key: C, votes: 2 },
      ],
      [
        { key: A, votes: 4 },
        { key: B, votes: 5 },
      ],
    ]);
    expect(result.rounds[0].eliminated).toEqual([C]);
    expect(result.winner).toBe(B);
    expect(roundTransfers(result, 0)).toEqual({
      gained: [{ key: B, votes: 2 }],
      exhausted: 0,
    });
    expect(roundTransfers(result, 1)).toEqual({ gained: [], exhausted: 0 });
  });

  it("counts the majority among ballots still in play", () => {
    // C's voters can make nothing else, so their ballots exhaust; A then has
    // 4 of the 7 ballots still counting, a majority of those.
    const result = instantRunoff([A, B, C], [
      ...times(4, [A]),
      ...times(3, [B]),
      ...times(2, [C]),
      [],
    ]);
    expect(result.ballots).toBe(10);
    expect(result.rounds[0].exhausted).toBe(1);
    expect(result.rounds[1].exhausted).toBe(3);
    expect(result.winner).toBe(A);
    expect(roundTransfers(result, 0)).toEqual({ gained: [], exhausted: 2 });
  });

  it("drops every zero-vote slot at once", () => {
    const result = instantRunoff([A, B, C, D], [
      ...times(2, [A, C]),
      ...times(2, [B, D]),
      [A],
      [B],
    ]);
    // A and B are tied 3-3 with no majority, C and D have no first choices.
    expect(result.rounds[0].eliminated).toEqual([C, D]);
    expect(result.rounds[0].tiebreak).toBeNull();
  });

  it("breaks a tie for fewest by the latest earlier round that separates them", () => {
    // Round 1: A 4, B 3, C 3, D 2 → D out, D's ballots go to C.
    // Round 2: A 4, B 3, C 5 → B out (no tie).
    const clear = instantRunoff([A, B, C, D], [
      ...times(4, [A]),
      ...times(3, [B]),
      ...times(3, [C]),
      ...times(2, [D, C]),
    ]);
    expect(clear.rounds[1].eliminated).toEqual([B]);

    // Round 1: A 5, B 4, C 3, D 2 → D out, its 2 go to C.
    // Round 2: A 5, B 4, C 5 → B out. B's 4 go 2 to A, 2 to C.
    // Round 3: A 7, C 7 tied, with 14 counted: no majority. C had fewer
    // votes in round 1 (3 vs 5), so C drops on the earlier-round rule.
    const tied = instantRunoff([A, B, C, D], [
      ...times(5, [A]),
      ...times(2, [B, A]),
      ...times(2, [B, C]),
      ...times(3, [C]),
      ...times(2, [D, C]),
    ]);
    expect(tied.rounds[2].tallies).toEqual([
      { key: A, votes: 7 },
      { key: C, votes: 7 },
    ]);
    expect(tied.rounds[2].eliminated).toEqual([C]);
    expect(tied.rounds[2].tiebreak).toBe("earlier-round");
    expect(tied.winner).toBe(A);
  });

  it("then by how many ballots rank the slot at all, then by poll order", () => {
    // A and B tie 2-2 in the only round; B appears on one more ballot.
    const reach = instantRunoff([A, B, C], [
      [A],
      [A],
      [B],
      [B],
      [C, B],
    ]);
    // C goes first (1 vote), its ballot moves to B: B 3, A 2.
    expect(reach.winner).toBe(B);

    const byReach = instantRunoff([A, B], [[A], [A, B], [B], [B]]);
    // 2-2 in round one, no earlier round; A is on 2 ballots, B on 3.
    expect(byReach.rounds[0].eliminated).toEqual([A]);
    expect(byReach.rounds[0].tiebreak).toBe("reach");
    expect(byReach.winner).toBe(B);

    const byOrder = instantRunoff([A, B], [[A], [B]]);
    expect(byOrder.rounds[0].eliminated).toEqual([B]);
    expect(byOrder.rounds[0].tiebreak).toBe("order");
    expect(byOrder.winner).toBe(A);
  });

  it("ignores unknown slots and repeats on a ballot", () => {
    const result = instantRunoff([A, B], [
      ["X", A, A],
      [B, "Y"],
      [B],
    ]);
    expect(result.reach).toEqual({ A: 1, B: 2 });
    expect(result.winner).toBe(B);
  });

  it("is deterministic whatever order the ballots arrive in", () => {
    const ballots = [
      ...times(5, [A]),
      ...times(2, [B, A]),
      ...times(2, [B, C]),
      ...times(3, [C]),
      ...times(2, [D, C]),
    ];
    const winner = instantRunoff([A, B, C, D], ballots).winner;
    for (let i = 0; i < 20; i++) {
      const shuffled = [...ballots].sort(() => Math.random() - 0.5);
      expect(instantRunoff([A, B, C, D], shuffled).winner).toBe(winner);
    }
  });
});

describe("runoffPlacement", () => {
  it("lists the winner first, then by how long each slot lasted", () => {
    const result = instantRunoff(["A", "B", "C", "D"], [
      ...times(5, ["A"]),
      ...times(2, ["B", "A"]),
      ...times(2, ["B", "C"]),
      ...times(3, ["C"]),
      ...times(2, ["D", "C"]),
    ]);
    expect(runoffPlacement(["A", "B", "C", "D"], result)).toEqual([
      "A",
      "C",
      "B",
      "D",
    ]);
    expect(eliminatedInRound(result, "D")).toBe(0);
    expect(eliminatedInRound(result, "A")).toBeNull();
  });

  it("keeps poll order when nobody has voted", () => {
    const result = instantRunoff(["A", "B", "C"], []);
    expect(runoffPlacement(["A", "B", "C"], result)).toEqual(["A", "B", "C"]);
  });
});

describe("roundStory", () => {
  const name = (key: string) => `Slot ${key}`;
  const tied = instantRunoff(["A", "B", "C", "D"], [
    ...times(5, ["A"]),
    ...times(2, ["B", "A"]),
    ...times(2, ["B", "C"]),
    ...times(3, ["C"]),
    ...times(2, ["D", "C"]),
  ]);

  it("tells who dropped out and where their ballots went", () => {
    expect(roundStory({ result: tied, round: 0, open: false, name })).toBe(
      "No slot has a majority yet: it takes 8 of the 14 ballots in play. Slot D has the fewest votes and drops out. Its 2 ballots move on: 2 to Slot C.",
    );
    expect(roundStory({ result: tied, round: 1, open: false, name })).toBe(
      "No slot has a majority yet: it takes 8 of the 14 ballots in play. Slot B has the fewest votes and drops out. Its 4 ballots move on: 2 to Slot A and 2 to Slot C.",
    );
  });

  it("says which rule broke a tie", () => {
    expect(roundStory({ result: tied, round: 2, open: false, name })).toBe(
      "No slot has a majority yet: it takes 8 of the 14 ballots in play. Slot C drops out: it tied for the fewest votes, and it had fewer votes in an earlier round. Its 7 ballots move on: 7 with no choice left.",
    );
  });

  it("names the winner, or the leader while voting is open", () => {
    expect(roundStory({ result: tied, round: 3, open: false, name })).toBe(
      "Slot A wins with 7 of the 7 ballots in play (100%) after 3 runoff rounds.",
    );
    const first = instantRunoff(["A", "B"], [["A"], ["A"], ["B"]]);
    expect(roundStory({ result: first, round: 0, open: true, name })).toBe(
      "Slot A leads with 2 of the 3 ballots in play (67%), a majority on first choices.",
    );
  });

  it("counts ballots that ran out of choices, and zero-vote drops", () => {
    const exhausting = instantRunoff(["A", "B", "C"], [
      ...times(4, ["A"]),
      ...times(3, ["B"]),
      ...times(2, ["C"]),
    ]);
    expect(roundStory({ result: exhausting, round: 0, open: false, name })).toContain(
      "Its 2 ballots move on: 2 with no choice left.",
    );
    const zero = instantRunoff(["A", "B", "C", "D"], [
      ...times(2, ["A", "C"]),
      ...times(2, ["B", "D"]),
      ["A"],
      ["B"],
    ]);
    expect(roundStory({ result: zero, round: 0, open: false, name })).toBe(
      "No slot has a majority yet: it takes 4 of the 6 ballots in play. Slot C and Slot D have no first-choice votes and drop out.",
    );
  });
});
