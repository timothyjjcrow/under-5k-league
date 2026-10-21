import { describe, expect, it } from "vitest";
import {
  buildRollCallView,
  parseMatchNight,
  rollCallCannotOpen,
  rollCallCountLine,
  rollCallLive,
  rollCallPhase,
  sameMatchNight,
} from "./roll-call";

const LA = "America/Los_Angeles";
const BERLIN = "Europe/Berlin";

describe("parseMatchNight", () => {
  it("reads the shape every page prints, in both leagues", () => {
    expect(parseMatchNight("Saturdays at 2:00 PM Pacific time", LA, "en-US")).toEqual({
      day: 6,
      minute: 14 * 60,
    });
    expect(parseMatchNight("Wednesdays at 20:00 Berlin time", BERLIN, "en-GB")).toEqual({
      day: 3,
      minute: 20 * 60,
    });
  });

  it("reads the ways an admin types the night", () => {
    for (const text of [
      "Saturday 2pm PT",
      "Sat 2:00 p.m.",
      "Every Saturday at 2 PM PST",
      "saturdays, 2:00pm pacific.",
      "Saturday 14:00",
      "Saturday at 2 PM Pacific Daylight Time",
    ]) {
      expect(parseMatchNight(text, LA, "en-US"), text).toEqual({ day: 6, minute: 840 });
    }
    expect(parseMatchNight("Sun 8:30 PM CET", BERLIN, "en-GB")).toEqual({
      day: 0,
      minute: 20 * 60 + 30,
    });
    expect(parseMatchNight("Thursdays 12 AM", LA, "en-US")).toEqual({ day: 4, minute: 0 });
    expect(parseMatchNight("Thursdays 12 PM", LA, "en-US")).toEqual({ day: 4, minute: 720 });
  });

  it("gives up rather than guess", () => {
    for (const text of [
      // Another zone: converting it as Pacific would be three hours out.
      "Saturdays at 2 PM EST",
      "Saturdays at 2 PM Pacific, 5 PM Eastern",
      "Saturdays and Sundays at 2 PM",
      "Saturday or Sunday 2 PM",
      // A 12-hour clock without AM or PM.
      "Saturdays at 2:00",
      "Saturday 2",
      "Saturdays",
      "2 PM",
      "Match night to be announced",
      "Saturday 13 PM",
      "Saturday 2:75 PM",
      "",
    ]) {
      expect(parseMatchNight(text, LA, "en-US"), text).toBeNull();
    }
    expect(parseMatchNight(null, LA, "en-US")).toBeNull();
    // Berlin isn't the US league's zone.
    expect(parseMatchNight("Wednesdays at 20:00 Berlin time", LA, "en-US")).toBeNull();
  });

  it("reads a 24-hour time without AM or PM only where it can't be misread", () => {
    expect(parseMatchNight("Wednesdays 8:00", BERLIN, "en-GB")).toEqual({ day: 3, minute: 480 });
    expect(parseMatchNight("Wednesdays 08:00", LA, "en-US")).toEqual({ day: 3, minute: 480 });
    expect(parseMatchNight("Wednesdays 8:00", LA, "en-US")).toBeNull();
    expect(parseMatchNight("Wednesdays 20", BERLIN, "en-GB")).toBeNull();
  });
});

describe("sameMatchNight", () => {
  it("matches a reworded night and refuses a moved one", () => {
    expect(
      sameMatchNight("Saturdays at 2:00 PM Pacific time", "Saturday 2pm PT", LA, "en-US"),
    ).toBe(true);
    expect(
      sameMatchNight("Saturdays at 2:00 PM Pacific time", "Saturdays at 3:00 PM Pacific time", LA, "en-US"),
    ).toBe(false);
    expect(
      sameMatchNight("Saturdays at 2:00 PM Pacific time", "Sundays at 2:00 PM Pacific time", LA, "en-US"),
    ).toBe(false);
  });

  it("compares words when either side can't be read", () => {
    expect(sameMatchNight("Weekends, time TBD", "weekends,  time TBD ", LA, "en-US")).toBe(true);
    expect(sameMatchNight("Weekends, time TBD", "Saturdays at 2 PM", LA, "en-US")).toBe(false);
  });
});

describe("rollCallLive and rollCallCannotOpen", () => {
  const open = new Date("2026-10-20T12:00:00Z");
  const night = "Saturdays at 2:00 PM Pacific time";

  it("runs only during signups and the draft", () => {
    expect(rollCallPhase("SIGNUPS")).toBe(true);
    expect(rollCallPhase("DRAFT")).toBe(true);
    for (const status of ["REGULAR_SEASON", "PLAYOFFS", "COMPLETE"]) {
      expect(rollCallPhase(status)).toBe(false);
      expect(rollCallLive({ status, openedAt: open, night, pollDecidesNight: false })).toBe(false);
      expect(rollCallCannotOpen({ status, night, pollDecidesNight: false })).toMatch(/signups and the draft/);
    }
  });

  it("is up only once opened, with a settled night", () => {
    const base = { status: "SIGNUPS", openedAt: open, night, pollDecidesNight: false };
    expect(rollCallLive(base)).toBe(true);
    expect(rollCallLive({ ...base, openedAt: null })).toBe(false);
    expect(rollCallLive({ ...base, night: null })).toBe(false);
    expect(rollCallLive({ ...base, pollDecidesNight: true })).toBe(false);
  });

  it("names what to fix before it can open", () => {
    expect(rollCallCannotOpen({ status: "SIGNUPS", night, pollDecidesNight: false })).toBeNull();
    expect(rollCallCannotOpen({ status: "SIGNUPS", night, pollDecidesNight: true })).toMatch(/poll/);
    expect(rollCallCannotOpen({ status: "DRAFT", night: null, pollDecidesNight: false })).toMatch(
      /Season settings/,
    );
  });
});

describe("buildRollCallView", () => {
  const night = "Saturdays at 2:00 PM Pacific time";
  const players = [
    { id: "u-zed", name: "zed", avatar: null },
    { id: "u-amy", name: "Amy", avatar: null },
    { id: "u-bo", name: "bo", avatar: "https://avatars.example/bo.jpg" },
    { id: "u-cy", name: "Cy", avatar: null },
  ];
  const at = new Date("2026-10-20T18:00:00Z");
  const view = (
    viewerId: string | null,
    answers: { userId: string; matchNight: string; answeredAt: Date }[],
    status = "SIGNUPS",
  ) =>
    buildRollCallView({
      seasonName: "Season 2",
      status,
      night,
      timeZone: LA,
      locale: "en-US",
      nowMs: at.getTime(),
      clockAt: at.getTime(),
      players,
      answers,
      viewerId,
    });

  it("splits the list into in and still to answer, each by name", () => {
    const v = view(null, [
      { userId: "u-zed", matchNight: night, answeredAt: at },
      { userId: "u-bo", matchNight: night, answeredAt: at },
    ]);
    expect(v.locked.map((p) => p.name)).toEqual(["bo", "zed"]);
    expect(v.waiting.map((p) => p.name)).toEqual(["Amy", "Cy"]);
    expect(v.viewer).toBe("signed-out");
    expect(v.slot).toMatchObject({ day: 6, minute: 840, key: "6@840" });
    expect(v.slot?.label).toBe("Saturdays at 2:00 PM Pacific time");
  });

  it("asks again when the night moved since the answer", () => {
    const v = view("u-amy", [
      { userId: "u-amy", matchNight: "Sundays at 2:00 PM Pacific time", answeredAt: at },
    ]);
    expect(v.viewer).toBe("renew");
    expect(v.locked).toEqual([]);
    expect(v.answeredAtMs).toBeNull();
  });

  it("counts an answer only while its player is on the list", () => {
    const v = view("u-gone", [
      { userId: "u-gone", matchNight: night, answeredAt: at },
      { userId: "u-cy", matchNight: night, answeredAt: at },
    ]);
    expect(v.viewer).toBe("not-listed");
    expect(v.locked.map((p) => p.id)).toEqual(["u-cy"]);
    expect(v.locked.length + v.waiting.length).toBe(players.length);
  });

  it("says where the viewer stands", () => {
    const answers = [{ userId: "u-cy", matchNight: "Saturday 2pm PT", answeredAt: at }];
    expect(view("u-cy", answers)).toMatchObject({ viewer: "in", answeredAtMs: at.getTime() });
    expect(view("u-amy", answers).viewer).toBe("owed");
    expect(view("u-amy", answers).signupsOpen).toBe(true);
    expect(view("u-amy", answers, "DRAFT").signupsOpen).toBe(false);
  });

  it("sorts names the way people read them", () => {
    const v = buildRollCallView({
      seasonName: "Season 2",
      status: "SIGNUPS",
      night,
      timeZone: LA,
      locale: "en-US",
      nowMs: 0,
      clockAt: 0,
      players: ["Player 10", "player 2", "Player 1", "Ärger"].map((name, i) => ({
        id: `u-${i}`,
        name,
        avatar: null,
      })),
      answers: [],
      viewerId: null,
    });
    expect(v.waiting.map((p) => p.name)).toEqual(["Ärger", "Player 1", "player 2", "Player 10"]);
  });

  it("prints a night it can't read as typed, with no slot", () => {
    const v = buildRollCallView({
      seasonName: "Season 2",
      status: "SIGNUPS",
      night: "Weekends, time TBD",
      timeZone: LA,
      locale: "en-US",
      nowMs: 0,
      clockAt: 0,
      players,
      answers: [],
      viewerId: null,
    });
    expect(v.slot).toBeNull();
    expect(v.night).toBe("Weekends, time TBD");
  });
});

describe("rollCallCountLine", () => {
  it("reads against everyone expected", () => {
    expect(rollCallCountLine(41, 66)).toBe("41 of 66 players are in");
    expect(rollCallCountLine(0, 66)).toBe("0 of 66 players are in");
    expect(rollCallCountLine(66, 66)).toBe("All 66 players are in");
    expect(rollCallCountLine(1, 1)).toBe("The 1 player is in");
    expect(rollCallCountLine(0, 0)).toBe("No players signed up yet");
  });
});
