import { describe, expect, it } from "vitest";
import {
  POLL_DEFAULT_FROM_HOUR,
  POLL_DEFAULT_TO_HOUR,
  POLL_DAYS,
  POLL_MAX_SLOTS,
  POLL_RESULT_DAYS,
  describeTimes,
  gridSlots,
  gridSummary,
  nextSlotOccurrence,
  parseAvailability,
  parseSlotKey,
  parseSlots,
  pollGrid,
  pollOnHome,
  pollClockAt,
  pollOpen,
  pollResultsVisible,
  pollSignupsOpen,
  pollTurnoutLine,
  closedPollStatus,
  pollResultMarker,
  slotHour,
  slotInZone,
  slotKey,
  slotLabel,
  slotOnClock,
  slotTime,
  tallyAvailability,
  zoneOffsetMinutes,
  type PollSlot,
} from "./match-night-poll";

const SUN_18: PollSlot = { day: 0, minute: 18 * 60 };
const WED_20: PollSlot = { day: 3, minute: 20 * 60 };
const SAT_17: PollSlot = { day: 6, minute: 17 * 60 };
const LA = "America/Los_Angeles";

/** n copies of one ballot. */
function times(n: number, ballot: string[]): string[][] {
  return Array.from({ length: n }, () => ballot);
}

describe("slots", () => {
  it("keys a slot by weekday and minute, and reads keys back", () => {
    expect(slotKey(SUN_18)).toBe("0@1080");
    expect(parseSlotKey("0@1080")).toEqual(SUN_18);
    expect(parseSlotKey("7@60")).toBeNull();
    expect(parseSlotKey("0@1440")).toBeNull();
    expect(parseSlotKey("x")).toBeNull();
  });

  it("reads stored slots and drops garbage instead of throwing", () => {
    expect(parseSlots('[{"day":0,"minute":1080},{"day":3,"minute":1200}]')).toEqual([
      SUN_18,
      WED_20,
    ]);
    expect(parseSlots("not json")).toEqual([]);
    expect(parseSlots('{"day":0}')).toEqual([]);
    expect(
      parseSlots('[{"day":7,"minute":0},null,{"day":0,"minute":1080},{"day":0,"minute":1080}]'),
    ).toEqual([SUN_18]);
  });

  it("builds the default grid: every day, on the hour, noon to 6 PM", () => {
    const result = gridSlots({
      days: [...POLL_DAYS],
      fromHour: POLL_DEFAULT_FROM_HOUR,
      toHour: POLL_DEFAULT_TO_HOUR,
    });
    if (!("slots" in result)) throw new Error(result.error);
    expect(result.slots).toHaveLength(49);
    // Monday first, hours ascending within a day.
    expect(result.slots[0]).toEqual({ day: 1, minute: 12 * 60 });
    expect(result.slots[6]).toEqual({ day: 1, minute: 18 * 60 });
    expect(result.slots.at(-1)).toEqual({ day: 0, minute: 18 * 60 });
  });

  it("builds a narrower grid and refuses impossible ones by name", () => {
    expect(gridSlots({ days: [6, 0], fromHour: 19, toHour: 20 })).toEqual({
      slots: [
        { day: 6, minute: 1140 },
        { day: 6, minute: 1200 },
        { day: 0, minute: 1140 },
        { day: 0, minute: 1200 },
      ],
    });
    expect(gridSlots({ days: [], fromHour: 12, toHour: 18 })).toEqual({
      error: "Pick at least one day.",
    });
    expect(gridSlots({ days: [1], fromHour: 18, toHour: 12 })).toEqual({
      error: "Pick a start hour no later than the end hour.",
    });
    expect(gridSlots({ days: [...POLL_DAYS], fromHour: 0, toHour: 23 })).toEqual({
      error: `A poll can offer at most ${POLL_MAX_SLOTS} start times.`,
    });
  });

  it("reads a ballot as the poll's slots in poll order, dropping unknowns and repeats", () => {
    const slots = [WED_20, SAT_17, SUN_18];
    expect(parseAvailability('["0@1080","3@1200","0@1080","9@9",4]', slots)).toEqual([
      "3@1200",
      "0@1080",
    ]);
    expect(parseAvailability("[]", slots)).toEqual([]);
    expect(parseAvailability("garbage", slots)).toEqual([]);
  });

  it("lays out a grid of days by start times, leaving missing cells empty", () => {
    const grid = pollGrid([
      { ...SUN_18, key: "0@1080" },
      { ...WED_20, key: "3@1200" },
      { day: 3, minute: 18 * 60, key: "3@1080" },
    ]);
    expect(grid.days).toEqual([3, 0]);
    expect(grid.minutes).toEqual([1080, 1200]);
    expect(grid.at(3, 1080)?.key).toBe("3@1080");
    expect(grid.at(0, 1200)).toBeUndefined();
  });
});

describe("labels", () => {
  it("names a slot the way the season's match night is printed", () => {
    expect(slotLabel(SUN_18, LA, "en-US")).toBe("Sundays at 6:00 PM Pacific time");
    expect(slotLabel(WED_20, "Europe/Berlin", "en-GB")).toBe(
      "Wednesdays at 20:00 Berlin time",
    );
    expect(slotTime(13 * 60 + 5, "en-GB")).toBe("13:05");
  });

  it("prints compact grid hours", () => {
    expect(slotHour(12 * 60, "en-US")).toBe("12 PM");
    expect(slotHour(18 * 60, "en-US")).toBe("6 PM");
    expect(slotHour(18 * 60, "en-GB")).toBe("18:00");
    expect(slotHour(18 * 60 + 30, "en-US")).toBe("6:30 PM");
  });

  it("summarizes a grid in a few words", () => {
    const all = gridSlots({ days: [...POLL_DAYS], fromHour: 12, toHour: 18 });
    const weekdays = gridSlots({ days: [1, 2, 3, 4, 5], fromHour: 19, toHour: 21 });
    const weekend = gridSlots({ days: [6, 0], fromHour: 12, toHour: 12 });
    const sundays = gridSlots({ days: [0], fromHour: 12, toHour: 18 });
    if (!("slots" in all) || !("slots" in weekdays) || !("slots" in weekend) || !("slots" in sundays)) {
      throw new Error("grid");
    }
    expect(gridSummary(all.slots, "en-US")).toBe("Every day, 12 PM–6 PM, on the hour");
    expect(gridSummary(weekdays.slots, "en-US")).toBe("Mon–Fri, 7 PM–9 PM, on the hour");
    expect(gridSummary(weekend.slots, "en-US")).toBe("Sat and Sun, 12 PM");
    expect(gridSummary(sundays.slots, "en-US")).toBe("Sundays, 12 PM–6 PM, on the hour");
    expect(gridSummary([SUN_18, WED_20, SAT_17], "en-US")).toBe("3 start times");
  });

  it("describes picked times as ranges per day", () => {
    expect(
      describeTimes(
        [
          { day: 6, minute: 720 },
          { day: 6, minute: 780 },
          { day: 6, minute: 840 },
          { day: 0, minute: 780 },
          { day: 6, minute: 1020 },
          { day: 1, minute: 720 },
        ],
        "en-US",
      ),
    ).toEqual(["Mon 12 PM", "Sat 12 PM–2 PM", "Sat 5 PM", "Sun 1 PM"]);
    expect(describeTimes([], "en-US")).toEqual([]);
  });
});

describe("clocks", () => {
  it("finds the next time a slot comes round on the league's clock", () => {
    // Wednesday 2026-10-07 12:00 Pacific (19:00 UTC).
    const now = Date.UTC(2026, 9, 7, 19, 0);
    expect(nextSlotOccurrence(SUN_18, now, LA)).toBe(Date.UTC(2026, 9, 12, 1, 0));
    expect(nextSlotOccurrence(WED_20, now, LA)).toBe(Date.UTC(2026, 9, 8, 3, 0));
    // A slot that is now counts as next week's.
    const at = Date.UTC(2026, 9, 8, 3, 0);
    expect(nextSlotOccurrence(WED_20, at, LA)).toBe(Date.UTC(2026, 9, 15, 3, 0));
  });

  it("keeps the local time across a daylight-saving change", () => {
    const now = Date.UTC(2026, 9, 31, 19, 0); // Saturday before the change
    expect(nextSlotOccurrence(SUN_18, now, LA)).toBe(Date.UTC(2026, 10, 2, 2, 0));
  });

  it("converts a slot to the viewer's clock, crossing midnight when it must", () => {
    const sundaySix = Date.UTC(2026, 9, 12, 1, 0); // Sun 18:00 Pacific
    expect(slotInZone(sundaySix, LA)).toEqual(SUN_18);
    expect(slotInZone(sundaySix, "America/New_York")).toEqual({ day: 0, minute: 21 * 60 });
    expect(slotInZone(sundaySix, "Europe/Berlin")).toEqual({ day: 1, minute: 3 * 60 });
    expect(slotInZone(sundaySix, "Etc/Unknown")).toBeNull();
    expect(slotInZone(Number.NaN, LA)).toBeNull();
  });

  it("reads a slot on the viewer's clock, saying when it lands on another day", () => {
    const sat = { day: 6, minute: 18 * 60 }; // Sat 18:00 PT
    expect(slotOnClock(sat, null)).toEqual({ day: 6, minute: 1080, shift: 0 });
    expect(slotOnClock(sat, 180)).toEqual({ day: 6, minute: 1260, shift: 0 }); // New York
    expect(slotOnClock(sat, 540)).toEqual({ day: 0, minute: 180, shift: 1 }); // Berlin
    const monNoon = { day: 1, minute: 720 };
    expect(slotOnClock(monNoon, -240)).toEqual({ day: 1, minute: 480, shift: 0 }); // Pago Pago
    const monEarly = { day: 1, minute: 60 };
    expect(slotOnClock(monEarly, -180)).toEqual({ day: 0, minute: 1320, shift: -1 }); // Honolulu
    // A half-hour zone, and Saturday wrapping round to Sunday.
    expect(slotOnClock({ day: 6, minute: 20 * 60 }, 750)).toEqual({ day: 0, minute: 510, shift: 1 });
  });

  it("converts the whole poll at one instant in the season, so a grid row never mixes two hours", () => {
    // Voting closes Sun Oct 25 2026, 9 PM Pacific. Europe has already left
    // summer time and the US leaves it on Nov 1: converting each slot at its
    // own next occurrence read Mon–Sat at 8 hours and Sunday at 9.
    const closesAt = new Date(Date.UTC(2026, 9, 26, 4, 0));
    const clockAt = pollClockAt(closesAt);
    expect(clockAt).toBe(closesAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(zoneOffsetMinutes(clockAt, LA, "Europe/Berlin")).toBe(540);
    // During that week the offset is 8 hours: not the season's.
    expect(zoneOffsetMinutes(Date.UTC(2026, 9, 28, 19, 0), LA, "Europe/Berlin")).toBe(480);
    // Arizona keeps one clock all year: level with Pacific while voting in
    // October, an hour ahead once the season is played.
    expect(zoneOffsetMinutes(Date.UTC(2026, 9, 20, 19, 0), LA, "America/Phoenix")).toBeNull();
    expect(zoneOffsetMinutes(clockAt, LA, "America/Phoenix")).toBe(60);
    const offset = zoneOffsetMinutes(clockAt, LA, "Europe/Berlin");
    const row = [1, 2, 3, 4, 5, 6, 0].map((day) => slotOnClock({ day, minute: 14 * 60 }, offset));
    expect(new Set(row.map((cell) => cell.minute))).toEqual(new Set([23 * 60]));
  });

  it("measures how far the viewer's clock is from the league's", () => {
    const sundaySix = Date.UTC(2026, 9, 12, 1, 0);
    expect(zoneOffsetMinutes(sundaySix, LA, "America/New_York")).toBe(180);
    expect(zoneOffsetMinutes(sundaySix, LA, "Pacific/Honolulu")).toBe(-180);
    expect(zoneOffsetMinutes(sundaySix, LA, "Asia/Kolkata")).toBe(750);
    expect(zoneOffsetMinutes(sundaySix, LA, LA)).toBeNull();
    expect(zoneOffsetMinutes(sundaySix, LA, "Etc/Unknown")).toBeNull();
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

  it("shows the count to voters and admins while open, to everyone once closed", () => {
    expect(pollResultsVisible({ open: true, hasVoted: false, isAdmin: false })).toBe(false);
    expect(pollResultsVisible({ open: true, hasVoted: true, isAdmin: false })).toBe(true);
    expect(pollResultsVisible({ open: true, hasVoted: false, isAdmin: true })).toBe(true);
    expect(pollResultsVisible({ open: false, hasVoted: false, isAdmin: false })).toBe(true);
  });

  it("knows when a season still takes signups", () => {
    expect(pollSignupsOpen({ isActive: true, status: "SIGNUPS" })).toBe(true);
    expect(pollSignupsOpen({ isActive: true, status: "REGULAR_SEASON" })).toBe(true);
    expect(pollSignupsOpen({ isActive: true, status: "COMPLETE" })).toBe(false);
    expect(pollSignupsOpen({ isActive: false, status: "SIGNUPS" })).toBe(false);
  });
});

describe("tallyAvailability", () => {
  const SAT_12 = { day: 6, minute: 720 };
  const SAT_13 = { day: 6, minute: 780 };
  const SAT_14 = { day: 6, minute: 840 };
  const SUN_13 = { day: 0, minute: 780 };
  const slots = [SAT_12, SAT_13, SAT_14, SUN_13];
  const [s12, s13, s14, u13] = slots.map(slotKey);

  it("picks the time the most players can make", () => {
    const result = tallyAvailability(slots, [
      ...times(3, [s13, u13]),
      [s12, s13],
      [u13],
      [],
    ]);
    expect(result.ballots).toBe(6);
    expect(result.counts).toEqual({ [s12]: 1, [s13]: 4, [s14]: 0, [u13]: 4 });
    // Saturday 1 PM and Sunday 1 PM both have 4; Saturday 1 PM has a
    // neighbour (12 PM) with a player free, Sunday 1 PM has none.
    expect(result.order.slice(0, 2)).toEqual([s13, u13]);
    expect(result.winner).toBe(s13);
  });

  it("breaks a tie by the players free an hour either side, then by week order", () => {
    const byNeighbours = tallyAvailability(slots, [[s12, u13], [s14, u13], [s12], [s14]]);
    // u13 has 2, s12 and s14 have 2 each; s13 has 0. Neighbours: s12 -> s13 (0),
    // s14 -> s13 (0), u13 -> none. All tie on neighbours, so week order decides.
    expect(byNeighbours.winner).toBe(s12);

    const neighbourly = tallyAvailability(slots, [[s13, u13], [s12, s14]]);
    // s13 and u13 tie at 1; s13's neighbours (s12, s14) have 2 between them.
    expect(neighbourly.winner).toBe(s13);
  });

  it("ignores unknown slots and repeats, and has no winner when nobody can play", () => {
    expect(tallyAvailability(slots, [["9@9", s12, s12]]).counts[s12]).toBe(1);
    const empty = tallyAvailability(slots, [[], []]);
    expect(empty.winner).toBeNull();
    expect(empty.order).toEqual([s12, s13, s14, u13]);
  });
});

describe("pollTurnoutLine", () => {
  it("reads the count against the players who could vote", () => {
    expect(pollTurnoutLine(11, { size: 35 }, true)).toBe("11 of 35 players have voted");
    expect(pollTurnoutLine(1, { size: 35 }, true)).toBe("1 of 35 players has voted");
    expect(pollTurnoutLine(0, { size: 35 }, true)).toBe("0 of 35 players have voted");
    expect(pollTurnoutLine(11, { size: 35 }, false)).toBe("11 of 35 players voted");
    expect(pollTurnoutLine(1, { size: 1 }, true)).toBe("1 of 1 player has voted");
  });

  it("falls back to the bare count with no electorate to count", () => {
    expect(pollTurnoutLine(11, null, true)).toBe("11 votes so far");
    expect(pollTurnoutLine(1, null, false)).toBe("1 vote");
    expect(pollTurnoutLine(3, { size: 0 }, true)).toBe("3 votes so far");
  });
});

describe("closedPollStatus", () => {
  const base = {
    winnerLabel: "Sundays at 5:00 PM Pacific time",
    count: 9,
    ballots: 11,
    usedAsMatchNight: false,
    announced: false,
  };

  // A closed poll used to fold away under a generic subtitle, with nothing
  // saying its winner wasn't the match night yet or hadn't been announced.
  it("names the winner and what's still to do", () => {
    expect(closedPollStatus(base)).toEqual({
      line: "Voting closed: Sundays at 5:00 PM Pacific time won (9 of 11 can play) · not yet the season's match night · not announced on Discord.",
      needsFollowUp: true,
    });
    expect(closedPollStatus({ ...base, usedAsMatchNight: true }).line).toBe(
      "Voting closed: Sundays at 5:00 PM Pacific time won (9 of 11 can play) · not announced on Discord.",
    );
  });

  it("stops asking once it's the match night and announced", () => {
    expect(
      closedPollStatus({ ...base, usedAsMatchNight: true, announced: true }),
    ).toEqual({
      line: "Voting closed: Sundays at 5:00 PM Pacific time won (9 of 11 can play).",
      needsFollowUp: false,
    });
    expect(closedPollStatus({ ...base, winnerLabel: null })).toEqual({
      line: "Voting closed with no time anyone can make.",
      needsFollowUp: false,
    });
  });

  it("keys the announce-once marker by poll and closing time", () => {
    expect(pollResultMarker("poll-1", 1_800_000_000_000)).toBe(
      "matchNightPollResult:poll-1:1800000000000",
    );
  });
});
