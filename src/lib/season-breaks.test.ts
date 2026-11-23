import { describe, expect, it } from "vitest";
import {
  breakNight,
  breakNightOptions,
  breakRemoveRefusal,
  breakShift,
  chooseBreak,
  parseBreakDates,
  seasonBreakViews,
  serializeBreakDates,
  upcomingBreak,
} from "./season-breaks";
import { leagueDateKey, matchNightForWeek } from "./schedule";

const LA = "America/Los_Angeles";
// US Season 2's rhythm: Saturdays at 2 PM Pacific from Nov 7.
const first = new Date("2026-11-07T14:00:00-08:00");
const week = (n: number) => matchNightForWeek(first, n, LA);
const key = (date: Date) => leagueDateKey(date, LA);
const now = new Date("2026-11-22T09:00:00-08:00").getTime();

describe("parseBreakDates / serializeBreakDates", () => {
  it("round-trips sorted, unique dates", () => {
    const raw = serializeBreakDates(["2027-01-02", "2026-12-26", "2026-12-26"]);
    expect(raw).toBe('["2026-12-26","2027-01-02"]');
    expect(parseBreakDates(raw)).toEqual(["2026-12-26", "2027-01-02"]);
  });

  it("stores no breaks as null", () => {
    expect(serializeBreakDates([])).toBeNull();
    expect(parseBreakDates(null)).toEqual([]);
    expect(parseBreakDates("")).toEqual([]);
  });

  it("reads anything it didn't write as no breaks", () => {
    expect(parseBreakDates("{")).toEqual([]);
    expect(parseBreakDates('{"v":1}')).toEqual([]);
    expect(parseBreakDates('["2026-12-26", 5, "2026-02-30", "soon"]')).toEqual(["2026-12-26"]);
  });
});

describe("chooseBreak", () => {
  const base = { firstMatchNight: first, breaks: [] as string[], nowMs: now, timeZone: LA };

  it("stores the night nearest the date", () => {
    expect(chooseBreak({ ...base, date: "2026-12-26" })).toEqual({
      ok: true,
      date: "2026-12-26",
      night: week(8),
    });
    // Christmas Day (Friday) is the Saturday's break.
    expect(chooseBreak({ ...base, date: "2026-12-25" })).toMatchObject({ ok: true, date: "2026-12-26" });
  });

  it("refuses week 1's night or earlier", () => {
    expect(chooseBreak({ ...base, date: "2026-11-07" })).toMatchObject({ ok: false });
    expect(chooseBreak({ ...base, date: "2026-11-01" })).toMatchObject({ ok: false });
  });

  it("refuses a night that has started", () => {
    // Nov 21 (week 3) is past by Nov 22.
    expect(chooseBreak({ ...base, date: "2026-11-21" })).toMatchObject({ ok: false });
    // Tonight, an hour after kickoff.
    expect(
      chooseBreak({ ...base, date: "2026-11-28", nowMs: week(4).getTime() + 3_600_000 }),
    ).toMatchObject({ ok: false });
    // Tonight, before kickoff: allowed (an emergency call-off).
    expect(
      chooseBreak({ ...base, date: "2026-11-28", nowMs: week(4).getTime() - 3_600_000 }),
    ).toMatchObject({ ok: true, date: "2026-11-28" });
  });

  it("refuses a night that is a break already", () => {
    const refused = chooseBreak({ ...base, breaks: ["2026-12-26"], date: "2026-12-24" });
    expect(refused).toMatchObject({ ok: false, error: "That night is already a break." });
  });

  it("plans a date before week 1's night is set", () => {
    const planned = { ...base, firstMatchNight: null };
    expect(chooseBreak({ ...planned, date: "2026-12-25" })).toEqual({
      ok: true,
      date: "2026-12-25",
      night: null,
    });
    expect(chooseBreak({ ...planned, date: "2026-11-22" })).toMatchObject({ ok: false });
    // Two planned dates in one week could cover the same night.
    expect(
      chooseBreak({ ...planned, breaks: ["2026-12-25"], date: "2026-12-29" }),
    ).toMatchObject({ ok: false, error: "There's already a break that week." });
    expect(
      chooseBreak({ ...planned, breaks: ["2026-12-25"], date: "2027-01-01" }),
    ).toMatchObject({ ok: true });
  });

  it("refuses junk", () => {
    expect(chooseBreak({ ...base, date: "" })).toMatchObject({ ok: false });
    expect(chooseBreak({ ...base, date: "2026-02-30" })).toMatchObject({ ok: false });
  });
});

describe("breakRemoveRefusal", () => {
  const base = { firstMatchNight: first, breaks: ["2026-12-26"], nowMs: now, timeZone: LA };

  it("lets a future break go", () => {
    expect(breakRemoveRefusal({ ...base, date: "2026-12-26" })).toBeNull();
  });

  it("keeps a break whose night has passed", () => {
    expect(
      breakRemoveRefusal({ ...base, date: "2026-12-26", nowMs: week(8).getTime() }),
    ).toMatch(/passed/);
  });

  it("names a break that is already gone", () => {
    expect(breakRemoveRefusal({ ...base, date: "2027-01-02" })).toMatch(/already removed/);
  });
});

describe("breakShift", () => {
  const fixture = (id: string, w: number, at: Date, status = "SCHEDULED") => ({
    id,
    week: w,
    status,
    scheduledAt: at,
  });

  it("moves the fixtures on each later round's night, keeping their time of day", () => {
    const fixtures = [
      fixture("w3", 3, week(3), "COMPLETED"),
      fixture("w4a", 4, week(4)),
      // Same night, an hour later (moved by a ready check): moves too.
      fixture("w4b", 4, new Date(week(4).getTime() + 3_600_000)),
      fixture("w5", 5, week(5)),
    ];
    const shift = breakShift({
      firstMatchNight: first,
      before: [],
      after: ["2026-11-28"],
      fixtures,
      timeZone: LA,
    });
    expect(shift.started).toEqual([]);
    expect(shift.kept).toEqual([]);
    expect(shift.moves.map((m) => [m.id, key(m.to)])).toEqual([
      ["w4a", "2026-12-05"],
      ["w4b", "2026-12-05"],
      ["w5", "2026-12-12"],
    ]);
    expect(shift.moves[1].to.getTime() - shift.moves[0].to.getTime()).toBe(3_600_000);
  });

  it("leaves a fixture off its round's night where its captains put it", () => {
    const thursday = new Date("2026-12-24T18:00:00-08:00");
    const shift = breakShift({
      firstMatchNight: first,
      before: [],
      after: ["2026-12-26"],
      fixtures: [fixture("sf1", 8, week(8)), fixture("sf2", 8, thursday)],
      timeZone: LA,
    });
    expect(shift.moves.map((m) => m.id)).toEqual(["sf1"]);
    expect(shift.kept).toEqual([{ id: "sf2", week: 8, at: thursday }]);
  });

  it("refuses to move a round that has started", () => {
    const shift = breakShift({
      firstMatchNight: first,
      before: [],
      after: ["2026-11-28"],
      fixtures: [fixture("live", 4, week(4), "LIVE"), fixture("w4", 4, week(4))],
      timeZone: LA,
    });
    expect(shift.started).toEqual([{ id: "live", week: 4 }]);
  });

  it("moves everything back when a break is removed", () => {
    const after = ["2026-12-26"];
    const moved = breakShift({
      firstMatchNight: first,
      before: [],
      after,
      fixtures: [fixture("sf", 8, week(8))],
      timeZone: LA,
    }).moves[0].to;
    const back = breakShift({
      firstMatchNight: first,
      before: after,
      after: [],
      fixtures: [fixture("sf", 8, moved)],
      timeZone: LA,
    });
    expect(back.moves.map((m) => m.to.getTime())).toEqual([week(8).getTime()]);
  });

  it("does nothing for rounds before the break or untimed fixtures", () => {
    const shift = breakShift({
      firstMatchNight: first,
      before: [],
      after: ["2026-12-26"],
      fixtures: [fixture("w5", 5, week(5)), { id: "untimed", week: 9, status: "SCHEDULED", scheduledAt: null }],
      timeZone: LA,
    });
    expect(shift).toEqual({ moves: [], kept: [], started: [] });
  });
});

describe("breakNightOptions", () => {
  it("offers each night still to come, through two past the last round", () => {
    const options = breakNightOptions({
      firstMatchNight: first,
      breaks: ["2026-12-26"],
      lastRound: 9,
      nowMs: now,
      timeZone: LA,
    });
    expect(options.map((o) => [o.date, o.round])).toEqual([
      ["2026-11-28", 4],
      ["2026-12-05", 5],
      ["2026-12-12", 6],
      ["2026-12-19", 7],
      ["2027-01-02", 8],
      ["2027-01-09", 9],
      ["2027-01-16", null],
      ["2027-01-23", null],
    ]);
  });
});

describe("seasonBreakViews", () => {
  it("names the round each break delays", () => {
    const views = seasonBreakViews({
      firstMatchNight: first,
      breaks: ["2026-11-28", "2026-12-26", "2027-03-06"],
      lastRound: 9,
      nowMs: now,
      timeZone: LA,
    });
    expect(views.map((v) => [v.date, v.delays, v.past])).toEqual([
      ["2026-11-28", 4, false],
      ["2026-12-26", 7, false],
      ["2027-03-06", null, false],
    ]);
    expect(views[0].night?.getTime()).toBe(week(4).getTime());
  });

  it("has no night before week 1's is set", () => {
    const [view] = seasonBreakViews({
      firstMatchNight: null,
      breaks: ["2026-12-25"],
      lastRound: 9,
      nowMs: now,
      timeZone: LA,
    });
    expect(view).toEqual({ date: "2026-12-25", night: null, delays: null, past: false });
    expect(breakNight(null, "2026-12-25", LA)).toBeNull();
  });
});

describe("upcomingBreak", () => {
  const breaks = ["2026-12-26"];
  const base = { firstMatchNight: first, breaks, lastRound: 9, timeZone: LA };

  it("speaks up in the week before the break, through its day", () => {
    const sf = new Date("2027-01-02T14:00:00-08:00");
    const tooEarly = new Date("2026-12-19T13:00:00-08:00").getTime();
    expect(upcomingBreak({ ...base, kickoffs: [sf], nowMs: tooEarly })).toBeNull();
    const weekBefore = new Date("2026-12-20T12:00:00-08:00").getTime();
    expect(upcomingBreak({ ...base, kickoffs: [sf], nowMs: weekBefore })).toEqual({
      night: week(8),
      resumesAt: sf,
    });
    const breakEvening = new Date("2026-12-26T21:00:00-08:00").getTime();
    expect(upcomingBreak({ ...base, kickoffs: [sf], nowMs: breakEvening })?.resumesAt).toEqual(sf);
    const dayAfter = new Date("2026-12-27T09:00:00-08:00").getTime();
    expect(upcomingBreak({ ...base, kickoffs: [sf], nowMs: dayAfter })).toBeNull();
  });

  it("points at the next planned round when it has no fixtures yet", () => {
    const weekBefore = new Date("2026-12-20T12:00:00-08:00").getTime();
    expect(upcomingBreak({ ...base, kickoffs: [], nowMs: weekBefore })?.resumesAt.toISOString()).toBe(
      "2027-01-02T22:00:00.000Z",
    );
  });

  it("skips the reserved tiebreaker week, which may not be played", () => {
    // Weeks 1-5, the tiebreaker week 6 and round one 7. A break on Dec 12
    // sends the tiebreaker week to Dec 19 and round one to Dec 26: the league
    // is surely back on Dec 26, not on a tiebreaker night that may not happen.
    const beforeTb = new Date("2026-12-07T12:00:00-08:00").getTime();
    const tbBreak = { ...base, breaks: ["2026-12-12"] };
    expect(
      upcomingBreak({ ...tbBreak, kickoffs: [], nowMs: beforeTb })?.resumesAt.toISOString(),
    ).toBe("2026-12-19T22:00:00.000Z");
    expect(
      upcomingBreak({ ...tbBreak, tiebreakerRound: 6, kickoffs: [], nowMs: beforeTb })?.resumesAt.toISOString(),
    ).toBe("2026-12-26T22:00:00.000Z");
  });

  it("says nothing when the season ends before the break", () => {
    const weekBefore = new Date("2026-12-20T12:00:00-08:00").getTime();
    expect(upcomingBreak({ ...base, lastRound: 7, kickoffs: [], nowMs: weekBefore })).toBeNull();
  });
});
