import { describe, expect, it } from "vitest";
import {
  AWAY_RANGE_MAX_DAYS,
  AWAY_SKIP,
  AWAY_SKIP_LABEL,
  awayFixtureLabel,
  awayRangeProblem,
  awayRangeResult,
  awayScheduleVerdict,
  awaySeatVerdict,
  fixturesInAwayRange,
  inAwayRange,
  localDayStartMs,
  parseAwayRange,
  parseSeenFixtures,
  seenFixturesField,
  type AwayRangeReport,
  type SeenFixture,
} from "./away-range";
import { CHECKIN_REFUSAL } from "./availability";
import { MATCH_PHASE, MATCH_STATUS } from "./constants";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1, 12);
const range = { fromMs: NOW + 2 * DAY, backMs: NOW + 16 * DAY };

describe("localDayStartMs", () => {
  it("is the local midnight of the typed day", () => {
    expect(localDayStartMs("2026-10-05")).toBe(new Date(2026, 9, 5).getTime());
    expect(localDayStartMs("2028-02-29")).toBe(new Date(2028, 1, 29).getTime());
  });

  it("refuses anything that isn't a real calendar day", () => {
    for (const bad of [
      "",
      "2026-10-5",
      "10/05/2026",
      "2026-02-31", // would roll into March
      "2026-13-01",
      "2026-00-10",
      "2027-02-29",
      "0099-01-01", // new Date maps two-digit years onto the 1900s
      "2026-10-05T00:00",
    ]) {
      expect(localDayStartMs(bad), bad).toBeNull();
    }
  });
});

describe("awayRangeProblem / parseAwayRange", () => {
  it("asks for both days", () => {
    expect(awayRangeProblem(null, null)).toMatch(/Pick the day you leave/);
    expect(awayRangeProblem(NOW, null)).toMatch(/Pick the day you leave/);
    expect(awayRangeProblem(null, NOW)).toMatch(/Pick the day you leave/);
  });

  it("needs the day back to come after the day away", () => {
    expect(awayRangeProblem(NOW, NOW)).toMatch(/has to be after/);
    expect(awayRangeProblem(NOW + DAY, NOW)).toMatch(/has to be after/);
    expect(awayRangeProblem(NOW, NOW + DAY)).toBeNull();
  });

  it(`caps a range at ${AWAY_RANGE_MAX_DAYS} days, with an hour of clock-change slack`, () => {
    const max = AWAY_RANGE_MAX_DAYS * DAY;
    expect(awayRangeProblem(NOW, NOW + max)).toBeNull();
    expect(awayRangeProblem(NOW, NOW + max + 60 * 60 * 1000)).toBeNull();
    expect(awayRangeProblem(NOW, NOW + max + DAY)).toMatch(/90 days or fewer/);
  });

  it("accepts two browser-computed epochs", () => {
    expect(
      parseAwayRange(String(range.fromMs), ` ${range.backMs} `, NOW),
    ).toEqual({ range });
  });

  it("rejects anything that isn't a positive whole epoch", () => {
    for (const bad of ["", "abc", "-5", "1.5", "1e12", "0", "9".repeat(16), "2026-10-05"]) {
      expect(parseAwayRange(bad, String(range.backMs), NOW), bad).toHaveProperty("error");
    }
  });

  it("refuses a range that is already over", () => {
    expect(parseAwayRange(String(NOW - 3 * DAY), String(NOW - DAY), NOW)).toEqual({
      error: "Those dates are already over.",
    });
    // A range still running (left yesterday, back next week) is fine.
    expect(parseAwayRange(String(NOW - DAY), String(NOW + 7 * DAY), NOW)).toHaveProperty("range");
  });
});

describe("inAwayRange / fixturesInAwayRange", () => {
  it("includes the day you leave and excludes the day you're back", () => {
    expect(inAwayRange(range.fromMs, range)).toBe(true);
    expect(inAwayRange(range.fromMs - 1, range)).toBe(false);
    expect(inAwayRange(range.backMs - 1, range)).toBe(true);
    expect(inAwayRange(range.backMs, range)).toBe(false);
  });

  it("keeps kickoff order and returns nothing without a range", () => {
    const fixtures = [
      { id: "a", kickoffMs: range.fromMs - DAY },
      { id: "b", kickoffMs: range.fromMs + DAY },
      { id: "c", kickoffMs: range.fromMs + 8 * DAY },
      { id: "d", kickoffMs: range.backMs + DAY },
    ];
    expect(fixturesInAwayRange(fixtures, range).map((f) => f.id)).toEqual(["b", "c"]);
    expect(fixturesInAwayRange(fixtures, null)).toEqual([]);
  });
});

describe("seenFixturesField / parseSeenFixtures", () => {
  const seen: SeenFixture[] = [
    { matchId: "cm1abc", scheduleRevision: 0, kickoffMs: range.fromMs + DAY },
    { matchId: "cm2-def_9", scheduleRevision: 12, kickoffMs: range.fromMs + 8 * DAY },
  ];

  it("round-trips what the card showed", () => {
    const parsed = parseSeenFixtures(seenFixturesField(seen));
    expect([...parsed.values()]).toEqual(seen);
    expect(parsed.get("cm2-def_9")?.scheduleRevision).toBe(12);
  });

  it("drops malformed tokens and keeps the rest", () => {
    const parsed = parseSeenFixtures(
      [
        "ok:1:1000",
        "no-revision::1000",
        "lead:01:1000", // a leading zero is not a revision this app writes
        "neg:-1:1000",
        "bad id:1:1000",
        "big:1:" + "9".repeat(16),
        "",
        "ok2:3:2000",
      ].join(","),
    );
    expect([...parsed.keys()]).toEqual(["ok", "ok2"]);
  });

  it("is empty for an empty field, and caps a flooded one", () => {
    expect(parseSeenFixtures("").size).toBe(0);
    const flood = Array.from({ length: 500 }, (_, i) => `m${i}:0:${1000 + i}`).join(",");
    expect(parseSeenFixtures(flood).size).toBe(200);
  });
});

describe("awayScheduleVerdict", () => {
  const seenAt = (kickoffMs: number, scheduleRevision = 2): SeenFixture => ({
    matchId: "m",
    scheduleRevision,
    kickoffMs,
  });
  const inside = range.fromMs + DAY;
  const outside = range.backMs + DAY;
  const facts = (over: Partial<Parameters<typeof awayScheduleVerdict>[0]> = {}) => ({
    seen: seenAt(inside),
    status: MATCH_STATUS.SCHEDULED,
    scheduleRevision: 2,
    kickoffMs: inside,
    closedReason: null,
    ...over,
  });

  it("ignores a fixture neither the page nor the schedule puts in the range", () => {
    expect(
      awayScheduleVerdict(facts({ seen: seenAt(outside), kickoffMs: outside }), range, NOW),
    ).toEqual({ kind: "ignore" });
    expect(
      awayScheduleVerdict(facts({ seen: undefined, kickoffMs: outside }), range, NOW),
    ).toEqual({ kind: "ignore" });
  });

  it("hands an unchanged in-range fixture on to the seat check", () => {
    expect(awayScheduleVerdict(facts(), range, NOW)).toBeNull();
    // Theirs and in range but never shown: the seat check reports it.
    expect(awayScheduleVerdict(facts({ seen: undefined }), range, NOW)).toBeNull();
  });

  it("reports a retime in either direction instead of guessing", () => {
    // Moved INTO the range since the page loaded.
    expect(
      awayScheduleVerdict(
        facts({ seen: seenAt(outside, 1), scheduleRevision: 2, kickoffMs: inside }),
        range,
        NOW,
      ),
    ).toEqual({ kind: "skip", reason: AWAY_SKIP.KICKOFF_CHANGED });
    // Moved OUT of it: the player chose these dates because of that night.
    expect(
      awayScheduleVerdict(
        facts({ seen: seenAt(inside, 1), scheduleRevision: 2, kickoffMs: outside }),
        range,
        NOW,
      ),
    ).toEqual({ kind: "skip", reason: AWAY_SKIP.KICKOFF_CHANGED });
    // Kickoff cleared altogether.
    expect(
      awayScheduleVerdict(
        facts({ seen: seenAt(inside, 1), scheduleRevision: 2, kickoffMs: null }),
        range,
        NOW,
      ),
    ).toEqual({ kind: "skip", reason: AWAY_SKIP.KICKOFF_CHANGED });
  });

  it("puts the check-in gate's own reason first", () => {
    expect(
      awayScheduleVerdict(
        facts({
          status: MATCH_STATUS.COMPLETED,
          scheduleRevision: 3,
          closedReason: CHECKIN_REFUSAL.FINISHED,
        }),
        range,
        NOW,
      ),
    ).toEqual({ kind: "skip", reason: AWAY_SKIP.FINISHED });
    expect(
      awayScheduleVerdict(facts({ closedReason: CHECKIN_REFUSAL.PHASE }), range, NOW),
    ).toEqual({ kind: "skip", reason: AWAY_SKIP.PHASE });
  });

  it("leaves a series that has started alone", () => {
    expect(
      awayScheduleVerdict(facts({ status: MATCH_STATUS.LIVE }), range, NOW),
    ).toEqual({ kind: "skip", reason: AWAY_SKIP.LIVE });
  });

  it("is stricter than check-in about a kickoff that has gone by", () => {
    const past = { fromMs: NOW - 5 * DAY, backMs: NOW + 5 * DAY };
    expect(
      awayScheduleVerdict(
        facts({ seen: seenAt(NOW - DAY), kickoffMs: NOW - DAY }),
        past,
        NOW,
      ),
    ).toEqual({ kind: "skip", reason: AWAY_SKIP.KICKOFF_PASSED });
  });
});

describe("awaySeatVerdict", () => {
  const seen: SeenFixture = { matchId: "m", scheduleRevision: 0, kickoffMs: NOW };

  it("marks a fixture the player can answer and hasn't said OUT for", () => {
    expect(awaySeatVerdict({ seen, seatRefusal: null, priorStatus: null })).toEqual({ kind: "mark" });
    expect(awaySeatVerdict({ seen, seatRefusal: null, priorStatus: "IN" })).toEqual({ kind: "mark" });
  });

  it("leaves an existing OUT untouched (a second save is a no-op)", () => {
    expect(awaySeatVerdict({ seen, seatRefusal: null, priorStatus: "OUT" })).toEqual({
      kind: "already-out",
    });
  });

  it("reports the seat refusal before anything else", () => {
    expect(
      awaySeatVerdict({ seen: undefined, seatRefusal: CHECKIN_REFUSAL.COVERED, priorStatus: "OUT" }),
    ).toEqual({ kind: "skip", reason: AWAY_SKIP.COVERED });
  });

  it("never answers for a fixture the page didn't show", () => {
    expect(awaySeatVerdict({ seen: undefined, seatRefusal: null, priorStatus: null })).toEqual({
      kind: "skip",
      reason: AWAY_SKIP.UNSEEN,
    });
  });
});

describe("awayFixtureLabel", () => {
  it("names the fixture from the viewer's side", () => {
    expect(awayFixtureLabel(MATCH_PHASE.REGULAR, 3, "Dire Wolves")).toBe("Week 3 vs Dire Wolves");
    expect(awayFixtureLabel(MATCH_PHASE.PLAYOFF, 7, "Dire Wolves")).toBe("Playoffs vs Dire Wolves");
  });
});

describe("awayRangeResult", () => {
  const ref = (n: number) => ({ matchId: `m${n}`, label: `Week ${n} vs T${n}` });
  const report = (over: Partial<AwayRangeReport> = {}): AwayRangeReport => ({
    marked: [],
    alreadyOut: [],
    skipped: [],
    gone: 0,
    ...over,
  });

  it("is an error when the dates cover none of their fixtures", () => {
    expect(awayRangeResult(report())).toEqual({
      error: "None of your fixtures fall between those dates.",
    });
  });

  it("names each marked fixture", () => {
    expect(awayRangeResult(report({ marked: [ref(3)] }))).toEqual({
      message: "Marked you out for 1 fixture: Week 3 vs T3. Captains can now line up cover.",
    });
    expect(awayRangeResult(report({ marked: [ref(3), ref(4), ref(5)] }))).toEqual({
      message:
        "Marked you out for 3 fixtures: Week 3 vs T3, Week 4 vs T4 and Week 5 vs T5. Captains can now line up cover.",
    });
  });

  it("shortens a long list without losing the count", () => {
    const marked = [1, 2, 3, 4, 5, 6, 7].map(ref);
    const r = awayRangeResult(report({ marked }));
    expect(r).toHaveProperty("message");
    expect((r as { message: string }).message).toContain(
      "Marked you out for 7 fixtures: Week 1 vs T1, Week 2 vs T2, Week 3 vs T3, Week 4 vs T4, Week 5 vs T5 and 2 more.",
    );
  });

  it("names every skipped fixture with its reason", () => {
    const r = awayRangeResult(
      report({
        marked: [ref(3)],
        alreadyOut: [ref(4)],
        skipped: [
          { ...ref(5), reason: AWAY_SKIP.FINISHED },
          { ...ref(6), reason: AWAY_SKIP.COVERED },
        ],
      }),
    );
    expect(r).toEqual({
      message:
        "Marked you out for 1 fixture: Week 3 vs T3. Already out: Week 4 vs T4. Skipped Week 5 vs T5 (already played) and Week 6 vs T6 (a standin covers your seat). Captains can now line up cover.",
    });
  });

  it("says nothing changed when every fixture was already out", () => {
    expect(awayRangeResult(report({ alreadyOut: [ref(3), ref(4)] }))).toEqual({
      message: "You were already out for Week 3 vs T3 and Week 4 vs T4. Nothing changed.",
    });
  });

  it("is an error that keeps the dates when everything was skipped", () => {
    expect(
      awayRangeResult(report({ skipped: [{ ...ref(3), reason: AWAY_SKIP.KICKOFF_CHANGED }] })),
    ).toEqual({
      error: "Nothing was marked. Skipped Week 3 vs T3 (kickoff moved, reload to check it).",
    });
    expect(awayRangeResult(report({ gone: 1 }))).toEqual({
      error: "Nothing was marked. 1 fixture you saw is no longer on the schedule. Reload the page.",
    });
    expect(awayRangeResult(report({ marked: [ref(1)], gone: 2 }))).toEqual({
      message:
        "Marked you out for 1 fixture: Week 1 vs T1. 2 fixtures you saw are no longer on the schedule. Reload the page. Captains can now line up cover.",
    });
  });

  it("has a label for every skip reason, and no em dashes anywhere", () => {
    for (const reason of Object.values(AWAY_SKIP)) {
      expect(AWAY_SKIP_LABEL[reason], reason).toBeTruthy();
      expect(AWAY_SKIP_LABEL[reason]).not.toContain("—");
    }
    const everything = awayRangeResult(
      report({
        marked: [ref(1)],
        alreadyOut: [ref(2)],
        skipped: Object.values(AWAY_SKIP).map((reason, i) => ({ ...ref(10 + i), reason })),
        gone: 1,
      }),
    );
    expect(JSON.stringify(everything)).not.toContain("—");
    for (const problem of [
      awayRangeProblem(null, null),
      awayRangeProblem(NOW, NOW),
      awayRangeProblem(NOW, NOW + 400 * DAY),
    ]) {
      expect(problem).not.toContain("—");
    }
  });
});
