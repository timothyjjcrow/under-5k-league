import { describe, expect, it } from "vitest";
import { createLeagueConfig, LEAGUE_CONFIG } from "./league-config";
import { matchNightForWeek } from "./schedule";
import {
  epochToZonedDatetimeLocal,
  formatInZone,
  formatLeagueTime,
  LEAGUE_LOCALE,
  parseDatetimeLocal,
  yourTimeHint,
  zonedDatetimeLocalToEpoch,
  zoneLabel,
} from "./zoned-time";

const BERLIN = "Europe/Berlin";
const LA = "America/Los_Angeles";
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("parseDatetimeLocal", () => {
  it("reads the shapes a datetime-local box posts", () => {
    expect(iso(parseDatetimeLocal("2026-10-07T20:00"))).toBe("2026-10-07T20:00:00.000Z");
    expect(iso(parseDatetimeLocal("2026-10-07T20:00:30"))).toBe("2026-10-07T20:00:30.000Z");
    expect(iso(parseDatetimeLocal("2026-10-07T20:00:30.5"))).toBe("2026-10-07T20:00:30.500Z");
    expect(iso(parseDatetimeLocal(" 2026-10-07 20:00 "))).toBe("2026-10-07T20:00:00.000Z");
  });

  it("refuses anything that is not a real calendar minute", () => {
    for (const bad of [
      "", "garbage", "2026-10-07", "2026-02-30T20:00", "2026-10-07T24:00",
      "2026-13-01T20:00", "2026-10-07T20:60", "2026-10-07T20:00Z",
    ]) {
      expect(parseDatetimeLocal(bad), bad).toBeNull();
    }
  });
});

describe("zonedDatetimeLocalToEpoch", () => {
  it("reads the typed wall time on the league's clock, not the browser's", () => {
    // The reported bug: a Los Angeles browser typing 20:00 for Europe stored
    // 03:00 UTC (05:00 Berlin). On Berlin's clock, 20:00 CEST is 18:00 UTC.
    expect(iso(zonedDatetimeLocalToEpoch("2026-10-07T20:00", BERLIN)))
      .toBe("2026-10-07T18:00:00.000Z");
    // Winter time: CET is UTC+1.
    expect(iso(zonedDatetimeLocalToEpoch("2026-11-04T20:00", BERLIN)))
      .toBe("2026-11-04T19:00:00.000Z");
    // The US league: Sunday 6 PM Pacific (PDT) is Monday 01:00 UTC.
    expect(iso(zonedDatetimeLocalToEpoch("2026-10-11T18:00", LA)))
      .toBe("2026-10-12T01:00:00.000Z");
  });

  it("moves a skipped spring-forward time forward by the jump", () => {
    // Berlin skips 02:00-03:00 on 29 Mar 2026: 02:30 becomes 03:30 CEST.
    expect(iso(zonedDatetimeLocalToEpoch("2026-03-29T02:30", BERLIN)))
      .toBe("2026-03-29T01:30:00.000Z");
    // Los Angeles skips 02:00-03:00 on 8 Mar 2026: 02:30 becomes 03:30 PDT.
    expect(iso(zonedDatetimeLocalToEpoch("2026-03-08T02:30", LA)))
      .toBe("2026-03-08T10:30:00.000Z");
  });

  it("takes the earlier occurrence of a repeated fall-back time", () => {
    // Berlin repeats 02:00-03:00 on 25 Oct 2026; the first pass is CEST.
    expect(iso(zonedDatetimeLocalToEpoch("2026-10-25T02:30", BERLIN)))
      .toBe("2026-10-25T00:30:00.000Z");
    // Los Angeles repeats 01:00-02:00 on 1 Nov 2026; the first pass is PDT.
    expect(iso(zonedDatetimeLocalToEpoch("2026-11-01T01:30", LA)))
      .toBe("2026-11-01T08:30:00.000Z");
  });

  it("returns null for an unreadable value instead of guessing", () => {
    expect(zonedDatetimeLocalToEpoch("", BERLIN)).toBeNull();
    expect(zonedDatetimeLocalToEpoch("2026-02-30T20:00", BERLIN)).toBeNull();
  });
});

describe("epochToZonedDatetimeLocal", () => {
  it("prefills the box with the league's wall clock", () => {
    expect(epochToZonedDatetimeLocal(Date.parse("2026-10-07T18:00:00Z"), BERLIN))
      .toBe("2026-10-07T20:00");
    expect(epochToZonedDatetimeLocal(Date.parse("2026-10-12T01:00:00Z"), LA))
      .toBe("2026-10-11T18:00");
    // Seconds are dropped: the box is minute-precision.
    expect(epochToZonedDatetimeLocal(Date.parse("2026-10-07T18:00:59Z"), BERLIN))
      .toBe("2026-10-07T20:00");
  });

  it.each([
    [BERLIN, "2026-03-29T00:00:00Z"],
    [BERLIN, "2026-10-25T00:00:00Z"],
    [LA, "2026-03-08T00:00:00Z"],
    [LA, "2026-11-01T00:00:00Z"],
  ])("round-trips every quarter hour across the %s clock change on %s", (zone, day) => {
    // An untouched prefilled form must resubmit the instant it was prefilled
    // with — except inside a repeated hour, whose second pass reads back as
    // the first (the one ambiguous case, resolved to the earlier instant).
    const start = Date.parse(day) - 24 * 3_600_000;
    for (let ms = start; ms < start + 72 * 3_600_000; ms += 15 * 60_000) {
      const back = zonedDatetimeLocalToEpoch(epochToZonedDatetimeLocal(ms, zone), zone);
      if (back !== ms) expect(back, new Date(ms).toISOString()).toBe(ms - 3_600_000);
    }
  });

  it("round-trips every typed wall time except the skipped hour", () => {
    const start = Date.UTC(2026, 2, 28);
    for (let wall = start; wall < start + 72 * 3_600_000; wall += 15 * 60_000) {
      const value = new Date(wall).toISOString().slice(0, 16);
      const again = epochToZonedDatetimeLocal(
        zonedDatetimeLocalToEpoch(value, BERLIN)!,
        BERLIN,
      );
      const skipped = value >= "2026-03-29T02:00" && value < "2026-03-29T03:00";
      expect(again, value).toBe(
        skipped ? new Date(wall + 3_600_000).toISOString().slice(0, 16) : value,
      );
    }
  });

  it("agrees with the schedule's weekly match nights across daylight saving", () => {
    // One implementation: a first night typed as 20:00 Berlin keeps week 4
    // (after the October clock change) at 20:00 Berlin too.
    const first = new Date(zonedDatetimeLocalToEpoch("2026-10-07T20:00", BERLIN)!);
    expect(epochToZonedDatetimeLocal(matchNightForWeek(first, 4, BERLIN).getTime(), BERLIN))
      .toBe("2026-10-28T20:00");
  });
});

describe("zoneLabel", () => {
  it("names a zone the way players say it", () => {
    expect(zoneLabel(BERLIN)).toBe("Berlin time");
    expect(zoneLabel("Europe/London")).toBe("London time");
    expect(zoneLabel(LA)).toBe("Pacific time");
    expect(zoneLabel("America/New_York")).toBe("Eastern time");
    expect(zoneLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires time");
  });

  it("falls back to the zone id when there is no city to name", () => {
    expect(zoneLabel("UTC")).toBe("UTC time");
    expect(zoneLabel("Etc/GMT-1")).toBe("Etc/GMT-1 time");
  });

  it("labels both leagues' default zones", () => {
    expect(zoneLabel(createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: "eu" }).timeZone))
      .toBe("Berlin time");
    expect(zoneLabel(createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: "us" }).timeZone))
      .toBe("Pacific time");
  });
});

describe("formatInZone", () => {
  const night = new Date("2026-10-07T18:00:00Z");

  it("states the instant on the named zone's clock, whatever the host zone", () => {
    expect(formatInZone(night, BERLIN, "en-GB")).toBe("Wed 7 Oct, 20:00 Berlin time");
    expect(formatInZone(night, LA, "en-US")).toMatch(/^Wed, Oct 7, 11:00\sAM Pacific time$/);
  });

  it("formatLeagueTime uses the league's zone and locale", () => {
    expect(formatLeagueTime(night)).toBe(formatInZone(night, LEAGUE_CONFIG.timeZone, LEAGUE_LOCALE));
    expect(formatLeagueTime(night)).toContain(zoneLabel(LEAGUE_CONFIG.timeZone));
  });
});

describe("yourTimeHint", () => {
  const night = Date.parse("2026-10-07T18:00:00Z"); // Wed 20:00 Berlin

  it("shows the viewer's own clock when it differs", () => {
    expect(yourTimeHint(night, BERLIN, LA, "en-GB")).toBe("= 11:00 your time");
    expect(yourTimeHint(night, BERLIN, LA, "en-US")).toMatch(/^= 11:00\sAM your time$/);
    expect(yourTimeHint(night, BERLIN, "Europe/London", "en-GB")).toBe("= 19:00 your time");
  });

  it("names the day when the viewer's clock is on another one", () => {
    expect(yourTimeHint(night, BERLIN, "Asia/Tokyo", "en-GB")).toBe("= Thu 8 Oct, 3:00 your time");
  });

  it("stays silent when both clocks read the same", () => {
    expect(yourTimeHint(night, BERLIN, BERLIN, "en-GB")).toBeNull();
    // A different zone id on the same clock tells the viewer nothing.
    expect(yourTimeHint(night, BERLIN, "Europe/Paris", "en-GB")).toBeNull();
    expect(yourTimeHint(NaN, BERLIN, LA, "en-GB")).toBeNull();
  });

  it("stays silent instead of throwing on a zone the browser can't name", () => {
    // Chrome reports "Etc/Unknown" when it can't map the OS zone, and Intl
    // refuses to build a formatter for it. The field calls this from its
    // sync effect, so a throw would break every admin scheduling box.
    expect(() => new Intl.DateTimeFormat("en", { timeZone: "Etc/Unknown" })).toThrow(RangeError);
    expect(yourTimeHint(night, BERLIN, "Etc/Unknown", "en-GB")).toBeNull();
    expect(yourTimeHint(night, BERLIN, "", "en-GB")).toBeNull();
  });
});
