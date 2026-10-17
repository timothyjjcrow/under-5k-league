import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceFile, stripLineComments } from "../../test/support/source-files";
import { INHOUSE_NIGHT_LENGTH_MS } from "./inhouse-night";
import {
  INHOUSE_TIMES_STRIP_SHOWN,
  INHOUSE_TIMES_STRIP_SHOWN_BESIDE_NIGHT,
  INHOUSE_TIME_DURING_NIGHT,
  INHOUSE_TIME_DURING_NIGHT_ON,
  inhouseTimeDuringNightRefusal,
  INHOUSE_TIME_MAX_LEAD_MS,
  INHOUSE_TIME_MAX_PER_PLAYER,
  INHOUSE_TIME_ON_MS,
  INHOUSE_TIME_STEP_MS,
  defaultInhouseTimeClock,
  groupInhouseTimes,
  inhouseChipWhenText,
  inhouseTimeCalendarEvent,
  inhouseTimeCanPost,
  inhouseTimeControls,
  inhouseTimeCountText,
  inhouseTimeDayWord,
  inhouseTimeDuringNight,
  inhouseTimeGoogleCalendarUrl,
  inhouseTimeLinked,
  inhouseTimeLinkPath,
  inhouseTimeParam,
  inhouseTimePhase,
  inhousePlansNightFirst,
  inhouseTimePreviewText,
  inhouseTimeProblem,
  inhouseTimesStrip,
  inhouseTimesStripLinkText,
  inhouseTimesWindow,
  nextInhouseTimeAt,
  parseInhouseTimeParam,
  quarterHourClock,
  upcomingInhouseTimesFor,
} from "./inhouse-times";
import { resolveSiteUrl } from "./site-url";

const MIN = 60_000;
const HOUR = 60 * MIN;
// Saturday 2026-10-10, 6 PM in New York, midnight in Berlin.
const NOW = Date.parse("2026-10-10T22:00:00.000Z");
const START = Date.parse("2026-10-11T00:00:00.000Z");

const player = (id: string) => ({ id, name: id.toUpperCase(), avatar: null });

describe("a time's start in forms and links", () => {
  it("round-trips a quarter-hour start in one exact shape", () => {
    expect(inhouseTimeParam(START)).toBe("2026-10-11T00:00Z");
    expect(parseInhouseTimeParam("2026-10-11T00:00Z")).toBe(START);
    expect(parseInhouseTimeParam("2026-10-11T00:45Z")).toBe(START + 45 * MIN);
    expect(inhouseTimeLinkPath(START)).toBe("/inhouse?at=2026-10-11T00:00Z");
  });

  it("refuses anything else: off the quarter hour, other shapes, rolled-over dates", () => {
    for (const raw of [
      "2026-10-11T00:07Z",
      "2026-10-11T00:00:00Z",
      "2026-10-11T00:00:00.000Z",
      "2026-10-11T00:00",
      "2026-10-11T00:00z",
      "2026-10-11T00:00+02:00",
      "2026-02-30T00:00Z",
      "2026-10-11T24:00Z",
      " 2026-10-11T00:00Z",
      String(START),
      "",
      null,
      undefined,
    ]) {
      expect(parseInhouseTimeParam(raw), String(raw)).toBeNull();
    }
  });
});

describe("when a time is on", () => {
  it("is upcoming before its start, on for an hour, then over", () => {
    expect(inhouseTimePhase(START, START - 1)).toBe("upcoming");
    expect(inhouseTimePhase(START, START)).toBe("on");
    expect(inhouseTimePhase(START, START + INHOUSE_TIME_ON_MS - 1)).toBe("on");
    expect(inhouseTimePhase(START, START + INHOUSE_TIME_ON_MS)).toBe("over");
  });

  it("lists from the times on now to the furthest one can be", () => {
    expect(inhouseTimesWindow(NOW)).toEqual({
      afterMs: NOW - INHOUSE_TIME_ON_MS,
      untilMs: NOW + INHOUSE_TIME_MAX_LEAD_MS,
    });
  });
});

describe("saying I'm in on a start", () => {
  it("takes a quarter-hour start ahead, up to a 25-hour day away", () => {
    expect(inhouseTimeProblem(START, NOW)).toBeNull();
    expect(inhouseTimeProblem(NOW + INHOUSE_TIME_STEP_MS, NOW)).toBeNull();
    expect(inhouseTimeProblem(NOW + INHOUSE_TIME_MAX_LEAD_MS, NOW)).toBeNull();
  });

  it("refuses a start off the quarter hour, started, over or too far off", () => {
    expect(inhouseTimeProblem(START + MIN, NOW)).toMatch(/quarter hour/);
    expect(inhouseTimeProblem(Number.NaN, NOW)).toMatch(/quarter hour/);
    expect(inhouseTimeProblem(NOW, NOW)).toMatch(/started: join the queue/);
    expect(inhouseTimeProblem(NOW - INHOUSE_TIME_ON_MS, NOW)).toMatch(/been and gone/);
    expect(
      inhouseTimeProblem(NOW + INHOUSE_TIME_MAX_LEAD_MS + INHOUSE_TIME_STEP_MS, NOW),
    ).toMatch(/next day/);
  });

  it("keeps a new time out of the inhouse night, from its start to its end", () => {
    const night = { startsAtMs: START };
    expect(inhouseTimeDuringNight(START, night)).toBe(true);
    expect(inhouseTimeDuringNight(START + INHOUSE_NIGHT_LENGTH_MS - INHOUSE_TIME_STEP_MS, night)).toBe(true);
    expect(inhouseTimeDuringNight(START + INHOUSE_NIGHT_LENGTH_MS, night)).toBe(false);
    expect(inhouseTimeDuringNight(START - INHOUSE_TIME_STEP_MS, night)).toBe(false);
    expect(inhouseTimeDuringNight(START, null)).toBe(false);
  });

  it("points a refused time at the night where the page shows it: its card below, the bar at the top", () => {
    // The night's card sits under Play later now; only its chip is at the top.
    expect(INHOUSE_TIME_DURING_NIGHT).toContain("on its card below");
    expect(INHOUSE_TIME_DURING_NIGHT).toContain("in the bar at the top of the page");
    expect(INHOUSE_TIME_DURING_NIGHT).not.toMatch(/its card at the top/);
    // Once the night is on, its "I'm in" is gone: the queue is the way in.
    expect(inhouseTimeDuringNightRefusal(START, START - 1)).toBe(INHOUSE_TIME_DURING_NIGHT);
    expect(inhouseTimeDuringNightRefusal(START, START)).toBe(INHOUSE_TIME_DURING_NIGHT_ON);
    expect(INHOUSE_TIME_DURING_NIGHT_ON).toContain("join the queue");
  });
});

describe("the list", () => {
  it("groups rows by start, soonest first, players first in first, and drops times that are over", () => {
    const times = groupInhouseTimes(
      [
        { startsAtMs: START + HOUR, createdAtMs: 5, player: player("c") },
        { startsAtMs: START, createdAtMs: 9, player: player("b") },
        { startsAtMs: START, createdAtMs: 2, player: player("a") },
        // One stamp for both: the id decides, never the row order.
        { startsAtMs: START + HOUR, createdAtMs: 5, player: player("a") },
        { startsAtMs: NOW - 10 * MIN, createdAtMs: 1, player: player("d") },
        { startsAtMs: NOW - INHOUSE_TIME_ON_MS, createdAtMs: 1, player: player("e") },
      ],
      NOW,
    );
    expect(times).toEqual([
      { startsAtMs: NOW - 10 * MIN, phase: "on", players: [player("d")] },
      { startsAtMs: START, phase: "upcoming", players: [player("a"), player("b")] },
      { startsAtMs: START + HOUR, phase: "upcoming", players: [player("a"), player("c")] },
    ]);
  });

  it("counts only a player's upcoming times toward the cap", () => {
    const times = groupInhouseTimes(
      [
        { startsAtMs: NOW - 10 * MIN, createdAtMs: 1, player: player("a") },
        { startsAtMs: START, createdAtMs: 1, player: player("a") },
        { startsAtMs: START + HOUR, createdAtMs: 1, player: player("b") },
      ],
      NOW,
    );
    expect(upcomingInhouseTimesFor(times, "a")).toBe(1);
    expect(upcomingInhouseTimesFor(times, "b")).toBe(1);
    expect(upcomingInhouseTimesFor(times, "z")).toBe(0);
  });

  it("says how close each time is to a game, then two", () => {
    expect(inhouseTimeCountText(1)).toBe("1 in · 9 more for a game");
    expect(inhouseTimeCountText(9)).toBe("9 in · 1 more for a game");
    expect(inhouseTimeCountText(10)).toBe("10 in · enough for a game");
    expect(inhouseTimeCountText(19)).toBe("19 in · enough for a game");
    expect(inhouseTimeCountText(20)).toBe("20 in · enough for two games");
    expect(inhouseTimeCountText(31)).toBe("31 in · enough for two games");
  });
});

describe("a time's controls", () => {
  const controls = (input: Partial<Parameters<typeof inhouseTimeControls>[0]>) =>
    inhouseTimeControls({ phase: "upcoming", signedIn: true, mine: false, atCap: false, ...input });

  it("offers I'm in while the time is ahead, a sign-in when signed out", () => {
    expect(controls({})).toEqual({ rsvp: "toggle", queue: false, calendar: false });
    expect(controls({ signedIn: false })).toEqual({ rsvp: "sign-in", queue: false, calendar: false });
    expect(controls({ mine: true })).toEqual({ rsvp: "toggle", queue: false, calendar: true });
  });

  it("holds I'm in back at the cap, but never hides taking one back", () => {
    expect(controls({ atCap: true }).rsvp).toBe("none");
    expect(controls({ atCap: true, mine: true }).rsvp).toBe("toggle");
  });

  it("points to the queue once the time is on, keeping the take-back for players in", () => {
    expect(controls({ phase: "on" })).toEqual({ rsvp: "none", queue: true, calendar: false });
    expect(controls({ phase: "on", signedIn: false })).toEqual({
      rsvp: "none",
      queue: true,
      calendar: false,
    });
    expect(controls({ phase: "on", mine: true })).toEqual({
      rsvp: "toggle",
      queue: true,
      calendar: false,
    });
  });

  it("lets a signed-in player under the cap post", () => {
    expect(inhouseTimeCanPost({ signedIn: true, atCap: false })).toBe(true);
    expect(inhouseTimeCanPost({ signedIn: true, atCap: true })).toBe(false);
    expect(inhouseTimeCanPost({ signedIn: false, atCap: false })).toBe(false);
    expect(INHOUSE_TIME_MAX_PER_PLAYER).toBe(3);
  });
});

describe("the banner at the top of /inhouse", () => {
  const at = (hours: number, phase: "upcoming" | "on" | "over" = "upcoming") => ({
    startsAtMs: START + hours * HOUR,
    phase,
  });
  const none = { linked: null };

  it("shows the soonest open times, three at most, and counts the rest", () => {
    // Out of order on purpose: the banner sorts, it doesn't trust the read's order.
    const strip = inhouseTimesStrip([at(5), at(-0.5, "on"), at(3), at(1), at(2)], none);
    expect(INHOUSE_TIMES_STRIP_SHOWN).toBe(3);
    expect(strip).toEqual({
      shown: [at(-0.5, "on"), at(1), at(2)],
      linkedMs: null,
      gone: false,
      more: 2,
    });
    expect(inhouseTimesStrip([at(2), at(1)], none)).toEqual({
      shown: [at(1), at(2)],
      linkedMs: null,
      gone: false,
      more: 0,
    });
  });

  it("leaves out times that are over, and counts only open ones as more", () => {
    expect(
      inhouseTimesStrip([at(-2, "over"), at(1), at(2), at(3), at(4, "over")], none),
    ).toEqual({ shown: [at(1), at(2), at(3)], linkedMs: null, gone: false, more: 0 });
  });

  it("shows nothing while no time is open and no link needs answering", () => {
    expect(inhouseTimesStrip([], none)).toBeNull();
    expect(inhouseTimesStrip([at(-2, "over")], none)).toBeNull();
  });

  it("leads with a link's time, picked out, even when it isn't among the soonest three", () => {
    const times = [at(1), at(2), at(3), at(4), at(5)];
    // Past the soonest three: shown as well, first, so a phone's first chip is it.
    expect(inhouseTimesStrip(times, { linked: at(4).startsAtMs })).toEqual({
      shown: [at(4), at(1), at(2), at(3)],
      linkedMs: at(4).startsAtMs,
      gone: false,
      more: 1,
    });
    // Among them: it moves to the front, and the banner still shows three.
    expect(inhouseTimesStrip(times, { linked: at(2).startsAtMs })).toEqual({
      shown: [at(2), at(1), at(3)],
      linkedMs: at(2).startsAtMs,
      gone: false,
      more: 2,
    });
    // A time that's on counts as open.
    expect(inhouseTimesStrip([at(-0.5, "on")], { linked: at(-0.5).startsAtMs })).toEqual({
      shown: [at(-0.5, "on")],
      linkedMs: at(-0.5).startsAtMs,
      gone: false,
      more: 0,
    });
  });

  it("shows two times at most beside the night, a link's own first, and counts the rest", () => {
    const times = [at(1), at(2), at(3), at(4)];
    const beside = (linked: Parameters<typeof inhouseTimesStrip>[1]["linked"]) =>
      inhouseTimesStrip(times, { linked, night: true });
    expect(INHOUSE_TIMES_STRIP_SHOWN_BESIDE_NIGHT).toBe(2);
    expect(beside(null)).toEqual({
      shown: [at(1), at(2)],
      linkedMs: null,
      gone: false,
      more: 2,
    });
    // A link to a later time leads and takes the second place: still two.
    expect(beside(at(4).startsAtMs)).toEqual({
      shown: [at(4), at(1)],
      linkedMs: at(4).startsAtMs,
      gone: false,
      more: 2,
    });
    expect(beside(at(2).startsAtMs)).toEqual({
      shown: [at(2), at(1)],
      linkedMs: at(2).startsAtMs,
      gone: false,
      more: 2,
    });
    // A gone link's line takes a time's place, so the night's chip still fits.
    expect(beside("gone")).toEqual({ shown: [at(1)], linkedMs: null, gone: true, more: 3 });
    // Without the night, as before: three, and a link adds its own.
    expect(inhouseTimesStrip(times, { linked: null, night: false })!.shown).toHaveLength(3);
    expect(inhouseTimesStrip([...times, at(5)], { linked: at(5).startsAtMs })!.shown).toHaveLength(4);
  });

  it("says a link's time is over in its place, with any open times after it", () => {
    // Over, never posted, or a link that names no one time: one line, even alone.
    for (const linked of [at(-2).startsAtMs, at(7).startsAtMs, "gone" as const]) {
      expect(inhouseTimesStrip([at(-2, "over")], { linked }), String(linked)).toEqual({
        shown: [],
        linkedMs: null,
        gone: true,
        more: 0,
      });
      expect(inhouseTimesStrip([at(1), at(2)], { linked }), String(linked)).toEqual({
        shown: [at(1), at(2)],
        linkedMs: null,
        gone: true,
        more: 0,
      });
    }
  });

  it("reads a time's link as the page gets it", () => {
    expect(inhouseTimeLinked(undefined)).toBeNull();
    expect(inhouseTimeLinked("2026-10-11T00:00Z")).toBe(START);
    // A repeated key (null) or a malformed one names no one time.
    expect(inhouseTimeLinked(null)).toBe("gone");
    expect(inhouseTimeLinked("2026-10-11T00:07Z")).toBe("gone");
    expect(inhouseTimeLinked("tonight")).toBe("gone");
  });

  it("leads with the earliest of the night and the times, a link's own first", () => {
    const lead = (input: Partial<Parameters<typeof inhousePlansNightFirst>[0]>) =>
      inhousePlansNightFirst({
        nightStartsAtMs: START + 2 * HOUR,
        nightOn: false,
        firstTimeMs: START,
        linkedTime: false,
        invite: false,
        ...input,
      });
    // A time sooner than the night leads; a night sooner than any time leads.
    expect(lead({})).toBe(false);
    expect(lead({ firstTimeMs: START + 3 * HOUR })).toBe(true);
    // A tie goes to the night, and a night with no time shown leads alone.
    expect(lead({ firstTimeMs: START + 2 * HOUR })).toBe(true);
    expect(lead({ firstTimeMs: null })).toBe(true);
    // A night that's on leads any time, even one that's on too.
    expect(lead({ nightOn: true, nightStartsAtMs: START - HOUR, firstTimeMs: START - 2 * HOUR })).toBe(true);
    // A time's link leads with its time (or its "over" line), whatever is sooner.
    expect(lead({ linkedTime: true, firstTimeMs: START + 3 * HOUR })).toBe(false);
    expect(lead({ linkedTime: true, nightOn: true })).toBe(false);
    expect(lead({ linkedTime: true, firstTimeMs: null })).toBe(false);
    // The night's invite leads with the night, a time's link or not.
    expect(lead({ invite: true })).toBe(true);
    expect(lead({ invite: true, linkedTime: true })).toBe(true);
  });

  it("names its link by what the card adds", () => {
    expect(inhouseTimesStripLinkText({ more: 2, atCap: false })).toBe("2 more");
    expect(inhouseTimesStripLinkText({ more: 1, atCap: true })).toBe("1 more");
    expect(inhouseTimesStripLinkText({ more: 0, atCap: false })).toBe("Post a time");
    expect(inhouseTimesStripLinkText({ more: 0, atCap: true })).toBe("All times");
  });

  it("names a time's day against now on the given clock", () => {
    // NOW is 6 PM Saturday in New York, and midnight has just struck into
    // Sunday in Berlin.
    expect(inhouseTimeDayWord(NOW + 2 * HOUR, NOW, "America/New_York")).toBe("Today");
    expect(inhouseTimeDayWord(NOW + 7 * HOUR, NOW, "America/New_York")).toBe("Tomorrow");
    expect(inhouseTimeDayWord(NOW - 30 * MIN, NOW, "America/New_York")).toBe("Today");
    expect(inhouseTimeDayWord(NOW + 2 * HOUR, NOW, "Europe/Berlin")).toBe("Today");
    expect(inhouseTimeDayWord(NOW + 24 * HOUR, NOW, "Europe/Berlin")).toBe("Tomorrow");
    // On since 11:30 PM Saturday, Berlin time.
    expect(inhouseTimeDayWord(NOW - 30 * MIN, NOW, "Europe/Berlin")).toBe("Yesterday");
    // Two midnights away (a 25-hour day can do it): the caller writes a full date.
    expect(inhouseTimeDayWord(NOW + 30 * HOUR, NOW, "America/New_York")).toBeNull();
  });

  it("says a chip's start as today or tomorrow, else by weekday, and the night by its date", () => {
    /** Intl may put a narrow no-break space before AM/PM; compare on plain ones. */
    const plain = (text: string) => text.replace(/[\u202f\u00a0]/g, " ");
    const us = (ms: number, dated = false) =>
      plain(inhouseChipWhenText(ms, NOW, "America/New_York", { locale: "en-US", dated }));
    // NOW is Saturday 6 PM in New York.
    expect(us(NOW + 2 * HOUR)).toBe("Today, 8:00 PM");
    expect(us(NOW + 7 * HOUR)).toBe("Tomorrow, 1:00 AM");
    expect(us(NOW + 7 * HOUR, true)).toBe("Tomorrow, 1:00 AM");
    // A Play later time two midnights off (a 25-hour day): its weekday.
    expect(us(NOW + 30 * HOUR)).toBe("Mon 12:00 AM");
    // The night, which can be weeks off, carries its date past tomorrow, so
    // a night 13 days out never reads as this Friday's.
    const fortnight = Date.parse("2026-10-24T00:00:00.000Z"); // Fri Oct 23, 8 PM New York
    expect(us(fortnight, true)).toBe("Fri, Oct 23, 8:00 PM");
    expect(us(fortnight)).toBe("Fri 8:00 PM");
    const nextWeek = NOW + 7 * 24 * HOUR + 2 * HOUR; // Sat Oct 17, 8 PM
    expect(us(nextWeek, true)).toBe("Sat, Oct 17, 8:00 PM");
    // Europe's clock and words: 24-hour, the day first.
    const europeNight = Date.parse("2026-10-23T18:00:00.000Z"); // Fri 23 Oct, 20:00 Berlin
    const berlin = plain(
      inhouseChipWhenText(europeNight, NOW, "Europe/Berlin", { locale: "en-GB", dated: true }),
    );
    expect(berlin).toBe("Fri 23 Oct, 20:00");
    expect(
      plain(inhouseChipWhenText(NOW + 20 * HOUR, NOW, "Europe/Berlin", { locale: "en-GB" })),
    ).toBe("Today, 20:00");
  });
});

describe("a time's link preview", () => {
  it("says when, how many are in and what the link does", () => {
    expect(inhouseTimePreviewText({ when: "Sat, Oct 10, 8:00 PM ET", phase: "upcoming", count: 6 })).toEqual({
      title: "Inhouse · Sat, Oct 10, 8:00 PM ET",
      description:
        "6 in · 4 more for a game. Open this to say you're in, then queue up when it comes round. Inhouse 5v5s: the lobby fires at ten players and captains draft the teams.",
    });
    expect(inhouseTimePreviewText({ when: "Sat, Oct 10, 8:00 PM ET", phase: "on", count: 6 })).toEqual({
      title: "Inhouse is on · Sat, Oct 10, 8:00 PM ET",
      description:
        "6 said they're in. Open this to join the queue: the lobby fires at ten players and captains draft the teams.",
    });
  });
});

describe("the time box", () => {
  it("rounds a typed clock to the nearest quarter hour", () => {
    expect(quarterHourClock("20:00")).toEqual({ hour: 20, minute: 0 });
    expect(quarterHourClock("20:07")).toEqual({ hour: 20, minute: 0 });
    expect(quarterHourClock("20:08")).toEqual({ hour: 20, minute: 15 });
    expect(quarterHourClock("07:52:30")).toEqual({ hour: 7, minute: 45 });
    expect(quarterHourClock("23:53")).toEqual({ hour: 0, minute: 0 });
    for (const bad of ["24:00", "7:00", "20:60", "ab:cd", ""]) {
      expect(quarterHourClock(bad), bad).toBeNull();
    }
  });

  it("means today's time while it's ahead, else tomorrow's, on the viewer's clock", () => {
    const at = (clock: string, zone: string, now = NOW) =>
      new Date(nextInhouseTimeAt(now, quarterHourClock(clock)!, zone)).toISOString();
    expect(at("20:00", "America/New_York")).toBe("2026-10-11T00:00:00.000Z");
    expect(at("17:00", "America/New_York")).toBe("2026-10-11T21:00:00.000Z");
    // Exactly now has already started: tomorrow's.
    expect(at("18:00", "America/New_York")).toBe("2026-10-11T22:00:00.000Z");
    // Midnight has just struck in Berlin, so 20:00 is still today there.
    expect(at("20:00", "Europe/Berlin")).toBe("2026-10-11T18:00:00.000Z");
    expect(at("00:00", "Europe/Berlin")).toBe("2026-10-11T22:00:00.000Z");
  });

  it("follows the clocks at both daylight-saving edges, within the 25-hour limit", () => {
    // New York falls back on Nov 1: 7 PM Saturday to 7 PM Sunday is 25 hours.
    const saturday7pm = Date.parse("2026-10-31T23:00:00.000Z");
    const sunday = nextInhouseTimeAt(saturday7pm, { hour: 19, minute: 0 }, "America/New_York");
    expect(new Date(sunday).toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(sunday - saturday7pm).toBe(INHOUSE_TIME_MAX_LEAD_MS);
    expect(inhouseTimeProblem(sunday, saturday7pm)).toBeNull();
    // It springs forward on Mar 8: 2:30 AM doesn't happen, so it's 3:30.
    const midnight = Date.parse("2026-03-08T05:00:00.000Z");
    expect(
      new Date(nextInhouseTimeAt(midnight, { hour: 2, minute: 30 }, "America/New_York")).toISOString(),
    ).toBe("2026-03-08T07:30:00.000Z");
  });

  it("always lands on a quarter hour after now and within the limit", () => {
    for (const zone of ["America/Los_Angeles", "Europe/Berlin", "Asia/Kathmandu", "Australia/Lord_Howe"]) {
      for (let quarter = 0; quarter < 96; quarter += 7) {
        const clock = { hour: Math.floor(quarter / 4), minute: (quarter % 4) * 15 };
        const ms = nextInhouseTimeAt(NOW + 7 * MIN, clock, zone);
        expect(ms % INHOUSE_TIME_STEP_MS, `${zone} ${quarter}`).toBe(0);
        expect(inhouseTimeProblem(ms, NOW + 7 * MIN), `${zone} ${quarter}`).toBeNull();
      }
    }
  });

  it("starts on the first whole hour at least half an hour away", () => {
    const zone = "America/New_York";
    expect(defaultInhouseTimeClock(Date.parse("2026-10-10T22:20:00Z"), zone)).toBe("19:00");
    expect(defaultInhouseTimeClock(Date.parse("2026-10-10T22:30:00Z"), zone)).toBe("19:00");
    expect(defaultInhouseTimeClock(Date.parse("2026-10-10T22:40:00Z"), zone)).toBe("20:00");
    expect(defaultInhouseTimeClock(Date.parse("2026-10-11T03:20:00Z"), zone)).toBe("00:00");
    expect(defaultInhouseTimeClock(Date.parse("2026-10-11T03:40:00Z"), zone)).toBe("01:00");
  });
});

describe("a time on a calendar", () => {
  const site = "https://ggd2l.example";

  it("opens Google Calendar's add-event page for the hour", () => {
    const url = new URL(inhouseTimeGoogleCalendarUrl(START, site, "GGD2L"));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("text")).toBe("GGD2L inhouse");
    expect(url.searchParams.get("dates")).toBe("20261011T000000Z/20261011T010000Z");
    expect(url.searchParams.get("location")).toBe(`${site}/inhouse`);
  });

  it("is one event per time, with the time's link", () => {
    expect(inhouseTimeCalendarEvent(START, site, "GGD2L", NOW)).toEqual({
      uid: `inhouse-time-${START}@ggd2l.vercel.app`,
      stamp: new Date(NOW),
      sequence: 0,
      start: new Date(START),
      durationMinutes: 60,
      summary: "GGD2L inhouse",
      description: `Inhouse 5v5s: join the queue on the site when it comes round. ${site}/inhouse`,
      url: `${site}/inhouse?at=2026-10-11T00:00Z`,
    });
  });

  // A calendar app matches a re-imported time by its UID, so the UID host is
  // pinned per league: the site moving off vercel.app to the league's own
  // domain must not change it. The event's link follows the site.
  describe("when the site URL changes", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it.each([
      ["us", "https://ggd2l.vercel.app", "https://us.ggd2l.com", "ggd2l.vercel.app"],
      ["eu", "https://ggd2l-europe.vercel.app", "https://eu.ggd2l.com", "ggd2l-europe.vercel.app"],
    ] as const)(
      "keeps the %s league's UID from %s at %s",
      async (region, before, after, uidHost) => {
        vi.stubEnv("NEXT_PUBLIC_LEAGUE_REGION", region);
        vi.resetModules();
        const { inhouseTimeCalendarEvent: build } = await import("./inhouse-times");
        const events = [before, after].map((siteUrl) => {
          // The route passes resolveSiteUrl(), which reads NEXT_PUBLIC_SITE_URL.
          vi.stubEnv("NEXT_PUBLIC_SITE_URL", siteUrl);
          return build(START, resolveSiteUrl(), "GGD2L", NOW);
        });

        expect(events.map((e) => e.uid)).toEqual([
          `inhouse-time-${START}@${uidHost}`,
          `inhouse-time-${START}@${uidHost}`,
        ]);
        expect(events.map((e) => e.url)).toEqual([
          `${before}/inhouse?at=2026-10-11T00:00Z`,
          `${after}/inhouse?at=2026-10-11T00:00Z`,
        ]);
      },
    );
  });
});

describe("the card follows the rules", () => {
  it("decides each row's controls and the post form by the pure rules", () => {
    const card = stripLineComments(sourceFile("src/components/inhouse-times.tsx").text);
    expect(card).toContain("inhouseTimeControls({");
    expect(card).toContain("inhouseTimeCanPost({");
    // One rule for a time's buttons, judged in one place for the card's rows
    // and the strip's tiles alike, so the two can't offer different things.
    expect(card.match(/\binhouseTimeControls\(/g)).toHaveLength(1);
    expect(card.match(/= viewOf\(time, user, atCap\);/g)).toHaveLength(2);
    expect(card.match(/<TimeActions\b/g)).toHaveLength(2);
    // "I'm in" renders only as the rule's kind, never beside it.
    expect(card.match(/<RsvpControl\b/g)).toHaveLength(1);
    expect(card).toContain('controls.rsvp === "none" ? null');
    const box = sourceFile("src/components/inhouse-times-client.tsx").text;
    expect(box).toContain("quarterHourClock(input.value)");
    expect(box).toContain("nextInhouseTimeAt(");
    // A hidden input's defaultValue is its value: React would blank the
    // worked-out time on every re-render of the line under the box.
    expect(box).toMatch(/type="hidden" name="at" \/>/);
    expect(box).not.toMatch(/name="at"[^>]*defaultValue/);
  });

  it("draws the banner by its rule, from the one read the card uses", () => {
    const card = stripLineComments(sourceFile("src/components/inhouse-times.tsx").text);
    // Beside the night's chip it shows two times at most.
    expect(card).toContain("const strip = inhouseTimesStrip(times, { linked, night: !!night });");
    // The bar is nothing only while there's neither a time to show nor a night.
    expect(card).toContain("if (!strip && !night) return null;");
    expect(card).toContain("strip.shown.map((time) => (");
    expect(card).toContain("linked={time.startsAtMs === strip.linkedMs}");
    expect(card).toContain("{strip.gone ? (");
    expect(card).toContain("The time in that link is over, or everyone on it dropped out.");
    expect(card).toContain("inhouseTimesStripLinkText({ more: strip.more, atCap })");
    // One query per request: the banner and the card share a request-cached
    // read, and the bar reads the night through the night card's own.
    expect(card).toMatch(/const loadPlayLater = cache\(async \(\) => \{/);
    expect(card.match(/\breadInhouseTimes\(/g)).toHaveLength(1);
    expect(card.match(/= await loadPlayLater\(\);/g)).toHaveLength(1);
    expect(card).toMatch(
      /= await Promise\.all\(\[\s*loadPlayLater\(\),\s*loadInhouseNightView\(\),\s*\]\);/,
    );
    expect(card).not.toMatch(/\breadInhouseNight(?:Rsvps)?\(|\bloadCurrentInhouseNight\(/);
    const night = stripLineComments(sourceFile("src/components/inhouse-night.tsx").text);
    expect(night).toMatch(/export const loadInhouseNightView = cache\(async \(\) => \{/);
    expect(night.match(/= await loadInhouseNightView\(\);/g)).toHaveLength(1);
    // Which leads is the pure rule's call: the earliest, a link's own first.
    expect(card).toContain("inhousePlansNightFirst({");
    expect(card).toContain("{nightFirst ? nightChip : timesPart}");
    expect(card).toContain("{nightFirst ? timesPart : nightChip}");
    // The row scrolls in one line inside a bar that clips it (CLAUDE.md: an
    // overflow-x-auto scroller needs overflow-hidden around it), and fades
    // each side with more by SectionNav's rule (PlansRow).
    expect(card).toMatch(
      /<Card\b[^>]*className="[^"]*\boverflow-hidden\b[^"]*"[^>]*>[\s\S]*?<PlansRow className="[^"]*\boverflow-x-auto\b/,
    );
    // From xl the times give way to the night's chip, which never shrinks:
    // their section shrinks and the chips swipe in a row of their own, so a
    // laptop keeps the night's chip whole however wide the times' words
    // (CI's DejaVu Sans pushed it 17px off with "Tomorrow, 12:00 AM").
    expect(card.match(/<PlansRow\b/g)).toHaveLength(2);
    const from = card.indexOf('id="play-later-next"');
    const times = card.slice(from, card.indexOf("</section>", from));
    expect(times).toContain('"xl:min-w-0 xl:shrink"');
    expect(times).toMatch(
      /<PlansRow className="[^"]*\bxl:min-w-0 xl:shrink xl:overflow-x-auto\b[^"]*">[\s\S]*?<ul className="flex shrink-0 items-center gap-2">[\s\S]*?<\/ul>[\s\S]*?<\/PlansRow>/,
    );
    const client = sourceFile("src/components/inhouse-times-client.tsx").text;
    const row = client.slice(client.indexOf("export function PlansRow("));
    expect(row).toContain("chipBarEdges(row)");
    expect(row).toContain("chipBarMask(edges)");
    expect(row).toMatch(/maskImage: mask, WebkitMaskImage: mask/);
  });

  it("keeps the banner a sliver: one row, no faces, no countdown", () => {
    const card = stripLineComments(sourceFile("src/components/inhouse-times.tsx").text);
    // The banner's code is the file from its chip on (the card comes first).
    const banner = card.slice(card.indexOf("function StripChip("));
    expect(banner).toContain("export async function InhouseTimesStrip(");
    // Nothing in it may wrap to a second row or stack its contents.
    expect(banner).not.toMatch(/\bflex-wrap\b|\bflex-col\b|\bgrid-rows-|\bspace-y-/);
    expect(banner).not.toMatch(/<Countdown\b|<Avatar\b|<CardHeader\b/);
    // The card under the room no longer says a link's time is over; the
    // banner does, once.
    expect(card.match(/The time in that link is over/g)).toHaveLength(1);
    expect(card).not.toContain("everyone on it has dropped out");
  });

  it("keeps the night's chip in the bar a sliver too: one row, no faces, no countdown", () => {
    const night = stripLineComments(sourceFile("src/components/inhouse-night.tsx").text);
    const from = night.indexOf("export function InhouseNightChip(");
    expect(from).toBeGreaterThan(-1);
    const chip = night.slice(from, night.indexOf("\n}\n", from));
    // One chip box, one button high, that never wraps or stacks.
    expect(chip).toContain('aria-label="Inhouse night"');
    expect(chip).toMatch(/className="flex shrink-0 items-center gap-2 [^"]*\bpy-0\.5\b/);
    expect(chip).not.toMatch(/\bflex-wrap\b|\bflex-col\b|\bgrid-rows-|\bspace-y-/);
    // The card has the countdown, the faces, the note and the links.
    expect(chip).not.toMatch(/<Countdown\b|<InhouseNightWhen\b|<Avatar\b|<WhoIsIn\b|<CardHeader\b|night\.note/);
    // Its "I'm in" is the night's one rule, and a refusal stays in its toast.
    expect(chip).toMatch(/<InhouseNightRsvpControl\b[^>]*\bcompact\b/);
    expect(chip).toContain("<InhouseTimeWhen ts={night.startsAtMs}");
    // A night can be weeks off: past tomorrow its chip names the date.
    expect(chip).toMatch(/<InhouseTimeWhen ts=\{night\.startsAtMs\}[^>]*\bdated\b/);
    const client = sourceFile("src/components/inhouse-times-client.tsx").text;
    expect(client).toContain("inhouseChipWhenText(ms, nowMs, viewerZone(), { dated })");
    expect(client).toContain("() => dayAndTime(ts, Date.now(), dated)");
  });

  it("puts the bar between the title and the live room, streamed, shown only by its rule", () => {
    const page = stripLineComments(sourceFile("src/app/inhouse/page.tsx").text);
    expect(page.match(/<InhouseTimesStrip\b/g)).toHaveLength(1);
    const strip =
      /<Suspense fallback=\{null\}>\s*<InhouseTimesStrip linked=\{linkedTime\} invite=\{invite\} \/>\s*<\/Suspense>/.exec(
        page,
      );
    expect(strip).not.toBeNull();
    // Not wrapped in a condition or fragment of the page's own: between the
    // title row and the bar, and the bar and the room, there is only
    // whitespace and JSX comments, so whether it shows (signed out too) is
    // the bar's own rule alone, and nothing else sits above the queue.
    const title = /<PageTitle\b[\s\S]*?\n {10}\/>/.exec(page);
    expect(title).not.toBeNull();
    expect(title![0]).toContain("compact");
    const room = page.indexOf("<section\n            id=\"live-room\"");
    expect(room).toBeGreaterThan(-1);
    const jsxComments = /\{\/\*[\s\S]*?\*\/\}/g;
    const before = page.slice(title!.index + title![0].length, strip!.index);
    expect(before.replace(jsxComments, "").trim()).toBe("");
    const after = page.slice(strip!.index + strip![0].length, room);
    expect(after.replace(jsxComments, "").trim()).toBe("");
    // The night's card is under the room now: its chip rides the bar.
    expect(page.indexOf("<InhouseNightCard")).toBeGreaterThan(room);
  });

  it("keeps the card under the room in one layout, a time's link too", () => {
    const page = stripLineComments(sourceFile("src/app/inhouse/page.tsx").text);
    // One card, straight after the room's section: no link mode that moves it
    // above the room (Tim, 2026-10-10: a time's link looked like another page).
    expect(page.match(/<PlayLater\b/g)).toHaveLength(1);
    const room = page.indexOf('id="live-room"');
    const card = page.indexOf("<PlayLater linked={linkedTime} />");
    expect(card).toBeGreaterThan(room);
    // Only the first screen's group closes between them.
    const between = page.slice(page.indexOf("</section>", room) + "</section>".length, card);
    expect(between.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").trim()).toBe("</div>");
    expect(page).not.toMatch(/linkedTime (?:!==|===) undefined/);
    expect(page).toContain("const linkedTime = inhouseTimeLinked(singleSearchParam(params.at));");
  });
});
