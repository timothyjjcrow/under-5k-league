import { describe, expect, it } from "vitest";
import {
  MAX_RESCHEDULE_OPTIONS,
  buildReadyCheckView,
  withMyAnswer,
  RESCHEDULE_NOTE_MAX,
  SUGGESTION_MIN_LEAD_MS,
  leadingOption,
  lockRefusal,
  normalizeRescheduleNote,
  normalizeRescheduleOptions,
  optionStatusLine,
  parseRescheduleOptions,
  serializeRescheduleOptions,
  suggestRescheduleTimes,
  tallyOption,
  type ReadySide,
  type ReadyVote,
} from "./reschedule-ready-check";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T1 = Date.UTC(2026, 9, 10, 1, 0); // Fri 6 PM Pacific
const T2 = T1 + DAY;

const home: ReadySide = {
  teamId: "h",
  captainId: "hc",
  seatIds: ["hc", "h1", "h2", "h3", "h4"],
};
const away: ReadySide = {
  teamId: "a",
  captainId: "ac",
  seatIds: ["ac", "a1", "a2", "a3", "a4"],
};
const captains = { homeCaptainId: "hc", awayCaptainId: "ac" };

function votes(timeMs: number, ids: string[], ready = true): ReadyVote[] {
  return ids.map((userId) => ({ userId, timeMs, ready }));
}

describe("parseRescheduleOptions", () => {
  it("falls back to the proposed time for a pre-ready-check proposal", () => {
    expect(parseRescheduleOptions(null, new Date(T1))).toEqual([T1]);
  });

  it("reads stored options ascending and unique", () => {
    expect(
      parseRescheduleOptions(
        serializeRescheduleOptions([T2, T1, T2]),
        new Date(T1),
      ),
    ).toEqual([T1, T2]);
  });

  it("degrades garbage to the proposed time instead of throwing", () => {
    for (const bad of ["{", "{}", "[]", '["x"]', "null"]) {
      expect(parseRescheduleOptions(bad, new Date(T2))).toEqual([T2]);
    }
  });
});

describe("normalizeRescheduleOptions", () => {
  it("sorts and de-duplicates", () => {
    expect(normalizeRescheduleOptions([T2, T1, T1])).toEqual({
      times: [T1, T2],
    });
  });

  it("refuses an empty, invalid or oversized list rather than trimming it", () => {
    expect(normalizeRescheduleOptions([])).toHaveProperty("error");
    expect(normalizeRescheduleOptions([T1, Number.NaN])).toHaveProperty(
      "error",
    );
    const tooMany = Array.from(
      { length: MAX_RESCHEDULE_OPTIONS + 1 },
      (_, i) => T1 + i * HOUR,
    );
    expect(normalizeRescheduleOptions(tooMany)).toEqual({
      error: `Offer at most ${MAX_RESCHEDULE_OPTIONS} times — pick the ones that work best`,
    });
  });
});

describe("normalizeRescheduleNote", () => {
  it("trims and collapses whitespace; blank is no note", () => {
    expect(normalizeRescheduleNote("  exams   sunday \n")).toEqual({
      note: "exams sunday",
    });
    expect(normalizeRescheduleNote("   ")).toEqual({ note: null });
    expect(normalizeRescheduleNote(undefined)).toEqual({ note: null });
  });

  it("refuses a note that is too long instead of cutting it", () => {
    const long = "x".repeat(RESCHEDULE_NOTE_MAX + 1);
    expect(normalizeRescheduleNote(long)).toEqual({
      error: `Keep the note under ${RESCHEDULE_NOTE_MAX} characters (it has ${RESCHEDULE_NOTE_MAX + 1})`,
    });
  });
});

describe("tallyOption", () => {
  it("counts each side's answers for this option only", () => {
    const tally = tallyOption(
      T1,
      { home, away },
      [
        ...votes(T1, ["hc", "h1"]),
        ...votes(T1, ["h2"], false),
        // Another option's answers never count here.
        ...votes(T2, ["h3", "a1", "a2"]),
      ],
      5,
    );
    expect(tally.home).toMatchObject({
      ready: 2,
      out: 1,
      pending: 2,
      need: 5,
      full: false,
    });
    expect(tally.away).toMatchObject({ ready: 0, pending: 5 });
    expect(tally.captains).toEqual({ home: "ready", away: null });
    expect(tally.captainsAgree).toBe(false);
    expect(tally.readyTotal).toBe(2);
    expect(tally.seatTotal).toBe(10);
  });

  it("is everyone-in only with both captains and a full lineup each side", () => {
    const all = [...home.seatIds, ...away.seatIds];
    expect(tallyOption(T1, { home, away }, votes(T1, all), 5).everyoneIn).toBe(
      true,
    );
    // One player short on one side is not everyone.
    const missing = all.filter((id) => id !== "a4");
    expect(
      tallyOption(T1, { home, away }, votes(T1, missing), 5).everyoneIn,
    ).toBe(false);
  });

  it("needs a full five, not every seat, on a six-player roster", () => {
    const six = { ...home, seatIds: [...home.seatIds, "h5"] };
    const tally = tallyOption(
      T1,
      { home: six, away },
      [
        ...votes(T1, ["hc", "h1", "h2", "h3", "h4"]),
        ...votes(T1, ["h5"], false),
        ...votes(T1, away.seatIds),
      ],
      5,
    );
    expect(tally.home).toMatchObject({ need: 5, full: true, out: 1 });
    expect(tally.everyoneIn).toBe(true);
  });

  it("needs every seat on a short side, and never fills an empty one", () => {
    const short = { ...away, seatIds: ["ac", "a1", "a2"] };
    const tally = tallyOption(
      T1,
      { home, away: short },
      votes(T1, [...home.seatIds, ...short.seatIds]),
      5,
    );
    expect(tally.away).toMatchObject({ need: 3, full: true });
    expect(tally.everyoneIn).toBe(true);
    const empty = tallyOption(
      T1,
      { home, away: { ...away, seatIds: [] } },
      votes(T1, [...home.seatIds, "ac"]),
      5,
    );
    expect(empty.away).toMatchObject({ need: 0, full: false });
    expect(empty.everyoneIn).toBe(false);
  });

  it("counts a captain covered by a standin as a captain, not a seat", () => {
    const covered = { ...home, seatIds: ["s1", "h1", "h2", "h3", "h4"] };
    const tally = tallyOption(
      T1,
      { home: covered, away },
      votes(T1, [...covered.seatIds, "hc", ...away.seatIds]),
      5,
    );
    expect(tally.captains.home).toBe("ready");
    expect(tally.home.answers.map((a) => a.userId)).not.toContain("hc");
    expect(tally.everyoneIn).toBe(true);
  });
});

describe("lockRefusal", () => {
  it("lets a captain lock once the OTHER captain is in", () => {
    const tally = tallyOption(T1, { home, away }, votes(T1, ["hc"]), 5);
    // The home captain proposed (✓); the away captain's lock is their yes.
    expect(lockRefusal(tally, "ac", captains)).toBeNull();
    // The proposer still needs the other captain's yes.
    expect(lockRefusal(tally, "hc", captains)).toBe(
      "The other captain hasn't said yes to this time yet",
    );
  });

  it("never needs the lineup, and refuses anyone but a captain", () => {
    const tally = tallyOption(T1, { home, away }, votes(T1, ["hc", "ac"]), 5);
    expect(tally.everyoneIn).toBe(false);
    expect(lockRefusal(tally, "hc", captains)).toBeNull();
    expect(lockRefusal(tally, "h1", captains)).toBe(
      "Only the two captains can lock a time in",
    );
  });

  it("treats a captain's no as not agreeing", () => {
    const tally = tallyOption(T1, { home, away }, votes(T1, ["hc"], false), 5);
    expect(lockRefusal(tally, "ac", captains)).not.toBeNull();
  });
});

describe("leadingOption", () => {
  it("picks the most-ready option, earlier on a tie, only when there's a choice", () => {
    const a = tallyOption(T1, { home, away }, votes(T1, ["hc", "h1"]), 5);
    const b = tallyOption(T2, { home, away }, votes(T2, ["hc", "h1", "a1"]), 5);
    expect(leadingOption([a, b])).toBe(T2);
    const tie = tallyOption(T2, { home, away }, votes(T2, ["hc", "a1"]), 5);
    expect(leadingOption([a, tie])).toBe(T1);
    expect(leadingOption([a])).toBeNull();
    const none = tallyOption(T2, { home, away }, [], 5);
    expect(leadingOption([tallyOption(T1, { home, away }, [], 5), none])).toBeNull();
  });
});

describe("optionStatusLine", () => {
  const names = { home: "Raccoons", away: "Dire Straits" };
  it("says who is still owed an answer", () => {
    const tally = tallyOption(T1, { home, away }, votes(T1, ["hc", "h1"]), 5);
    expect(optionStatusLine(tally, names)).toBe(
      "Waiting on the Dire Straits captain · 8 more players needed for full lineups",
    );
    const agreed = tallyOption(
      T1,
      { home, away },
      votes(T1, [...home.seatIds, "ac", "a1", "a2", "a3"]),
      5,
    );
    expect(optionStatusLine(agreed, names)).toBe(
      "Both captains agree · 1 more player needed for full lineups",
    );
    const all = tallyOption(
      T1,
      { home, away },
      votes(T1, [...home.seatIds, ...away.seatIds]),
      5,
    );
    expect(optionStatusLine(all, names)).toBe("Everyone's in");
  });
});

describe("suggestRescheduleTimes", () => {
  // Sun Oct 11 2026, 6 PM in Los Angeles (PDT, UTC-7).
  const kickoff = Date.UTC(2026, 9, 12, 1, 0);
  const now = Date.UTC(2026, 9, 7, 19, 0); // Wed noon Pacific
  const base = {
    kickoffMs: kickoff,
    fallbackAnchorMs: null,
    nowMs: now,
    deadlineMs: null,
    busyMs: [],
    windowMs: 4 * HOUR,
    timeZone: "America/Los_Angeles",
  };

  it("offers the times closest to the kickoff, ascending", () => {
    const times = suggestRescheduleTimes({ ...base, count: 4 });
    expect(times).toEqual([
      Date.UTC(2026, 9, 11, 1, 0), // Sat 6 PM, the day before
      kickoff - HOUR, // Sun 5 PM
      kickoff + HOUR, // Sun 7 PM
      Date.UTC(2026, 9, 13, 1, 0), // Mon 6 PM, the day after
    ]);
    expect(times.every((t) => t >= now + SUGGESTION_MIN_LEAD_MS)).toBe(true);
  });

  it("offers the soonest days when the kickoff has already passed", () => {
    const times = suggestRescheduleTimes({
      ...base,
      kickoffMs: Date.UTC(2026, 9, 5, 1, 0), // last Sun 6 PM
      count: 3,
    });
    expect(times).toEqual([
      Date.UTC(2026, 9, 8, 1, 0), // Wed 6 PM
      Date.UTC(2026, 9, 9, 1, 0), // Thu 6 PM
      Date.UTC(2026, 9, 10, 1, 0), // Fri 6 PM
    ]);
  });

  it("includes an hour either side of the kickoff but never the kickoff", () => {
    const times = suggestRescheduleTimes({ ...base, count: 20 });
    expect(times).toContain(kickoff - HOUR);
    expect(times).toContain(kickoff + HOUR);
    expect(times).not.toContain(kickoff);
  });

  it("keeps 6 PM across the fall-back clock change", () => {
    // Nov 1 2026: PDT ends. Sunday 6 PM PST is 02:00Z on Nov 2.
    const lateKickoff = Date.UTC(2026, 9, 26, 1, 0); // Sun Oct 25 6 PM PDT
    const times = suggestRescheduleTimes({
      ...base,
      kickoffMs: lateKickoff,
      nowMs: Date.UTC(2026, 9, 30, 19, 0),
      count: 4,
    });
    expect(times).toContain(Date.UTC(2026, 10, 2, 2, 0));
  });

  it("drops times past the deadline or too close to a busy time", () => {
    const times = suggestRescheduleTimes({
      ...base,
      deadlineMs: Date.UTC(2026, 9, 10, 1, 0),
      busyMs: [Date.UTC(2026, 9, 9, 3, 0)], // Thu 8 PM: Thu 6 PM is 2h off
      count: 10,
    });
    expect(times).toEqual([Date.UTC(2026, 9, 8, 1, 0)]);
  });

  it("keeps the earlier time when two are equally close", () => {
    const times = suggestRescheduleTimes({
      ...base,
      count: 1,
      busyMs: [kickoff - HOUR, kickoff + HOUR],
      windowMs: 30 * 60 * 1000,
    });
    // Sat 6 PM and Mon 6 PM are both a day off the kickoff.
    expect(times).toEqual([Date.UTC(2026, 9, 11, 1, 0)]);
  });

  it("anchors on the league night when the match has no kickoff", () => {
    const times = suggestRescheduleTimes({
      ...base,
      kickoffMs: null,
      fallbackAnchorMs: Date.UTC(2026, 8, 7, 3, 0), // a past Sun 8 PM PDT
      count: 2,
    });
    expect(times).toEqual([
      Date.UTC(2026, 9, 8, 3, 0),
      Date.UTC(2026, 9, 9, 3, 0),
    ]);
    expect(
      suggestRescheduleTimes({ ...base, kickoffMs: null, fallbackAnchorMs: null }),
    ).toEqual([]);
  });
});

describe("buildReadyCheckView", () => {
  const people = new Map(
    [...home.seatIds, ...away.seatIds].map((id) => [
      id,
      { id, name: `Name ${id}`, avatar: null },
    ]),
  );
  const input = (over: Partial<Parameters<typeof buildReadyCheckView>[0]> = {}) => ({
    request: {
      id: "r1",
      matchId: "m1",
      proposedById: "hc",
      createdAtMs: 0,
      note: "exams",
      options: [T1, T2],
    },
    proposerName: "Home Cap",
    kickoffMs: T1 - DAY,
    teamSize: 5,
    home: { ...home, name: "Home" },
    away: { ...away, name: "Away" },
    votes: [
      ...votes(T1, ["h1", "a1"]),
      ...votes(T1, ["a2"], false),
      ...votes(T2, ["h1"]),
    ],
    people,
    viewer: { id: "a1", isAdmin: false },
    named: false,
    open: true,
    nowMs: T1 - 2 * DAY,
    ...over,
  });

  it("gives a player counts and their own seat, never anyone else's name", () => {
    const view = buildReadyCheckView(input());
    expect(view.viewer).toMatchObject({
      kind: "player",
      side: "away",
      canAnswer: true,
      isProposer: false,
    });
    const [first] = view.options;
    expect(first.myAnswer).toBe("ready");
    expect(first.away).toMatchObject({ ready: 1, out: 1, pending: 3 });
    const named = first.away.seats.filter((s) => s.name !== null);
    expect(named).toEqual([
      { userId: "a1", name: "Name a1", avatar: null, answer: "ready", me: true },
    ]);
    // Sorted ready, out, waiting: a seat's place can't reveal whose it is.
    expect(first.away.seats.map((s) => s.answer)).toEqual([
      "ready",
      "out",
      null,
      null,
      null,
    ]);
    // The proposer's yes is implied on every option.
    expect(first.captains.home).toBe("ready");
    expect(view.options[1].captains.home).toBe("ready");
  });

  it("names every seat for a captain or admin, in seat order", () => {
    const view = buildReadyCheckView(
      input({ viewer: { id: "ac", isAdmin: false }, named: true }),
    );
    expect(view.viewer.kind).toBe("captain");
    expect(view.options[0].away.seats.map((s) => s.userId)).toEqual(
      away.seatIds,
    );
    expect(view.options[0].away.seats.every((s) => s.name !== null)).toBe(
      true,
    );
    // The opposing captain can lock any open option: the proposer is in.
    expect(view.options.map((o) => o.lockRefusal)).toEqual([null, null]);
    const admin = buildReadyCheckView(
      input({ viewer: { id: "x", isAdmin: true }, named: true }),
    );
    expect(admin.viewer).toMatchObject({ kind: "admin", canAnswer: false });
  });

  it("makes the proposer wait for the other captain before locking", () => {
    const view = buildReadyCheckView(input({ viewer: { id: "hc", isAdmin: false } }));
    expect(view.viewer.isProposer).toBe(true);
    expect(view.options[0].lockRefusal).toBe(
      "The other captain hasn't said yes to this time yet",
    );
  });

  it("closes answering and locking on a passed option or a match that can't move", () => {
    const passed = buildReadyCheckView(input({ nowMs: T1 + HOUR }));
    expect(passed.options[0]).toMatchObject({ passed: true });
    expect(passed.options[0].lockRefusal).not.toBeNull();
    const closed = buildReadyCheckView(input({ open: false }));
    expect(closed.viewer.canAnswer).toBe(false);
    expect(closed.options.every((o) => o.lockRefusal !== null)).toBe(true);
  });

  it("marks the most-ready option", () => {
    const view = buildReadyCheckView(input());
    expect(view.options.map((o) => o.leading)).toEqual([true, false]);
  });

  it("shows a spectator counts only", () => {
    const view = buildReadyCheckView(input({ viewer: null }));
    expect(view.viewer).toMatchObject({ kind: "spectator", canAnswer: false });
    expect(
      view.options.every((o) =>
        [...o.home.seats, ...o.away.seats].every((s) => s.name === null),
      ),
    ).toBe(true);
  });
});

describe("withMyAnswer", () => {
  it("moves the viewer's own seat and their side's counts at once", () => {
    const view = buildReadyCheckView({
      request: {
        id: "r1",
        matchId: "m1",
        proposedById: "hc",
        createdAtMs: 0,
        note: null,
        options: [T1],
      },
      proposerName: "Home Cap",
      kickoffMs: null,
      teamSize: 5,
      home: { ...home, name: "Home" },
      away: { ...away, name: "Away" },
      votes: votes(T1, ["a1"], false),
      people: new Map(),
      viewer: { id: "a1", isAdmin: false },
      named: false,
      open: true,
      nowMs: T1 - DAY,
    });
    const after = withMyAnswer(view, T1, "ready");
    expect(after.options[0].myAnswer).toBe("ready");
    expect(after.options[0].away).toMatchObject({ ready: 1, out: 0 });
    expect(after.options[0].readyTotal).toBe(view.options[0].readyTotal + 1);
    expect(after.options[0].away.seats.find((s) => s.me)?.answer).toBe("ready");
    // Another option or another viewer's view is untouched.
    expect(withMyAnswer(view, T2, "ready")).toEqual(view);
  });

  it("updates the captain chip for a captain", () => {
    const view = buildReadyCheckView({
      request: {
        id: "r1",
        matchId: "m1",
        proposedById: "hc",
        createdAtMs: 0,
        note: null,
        options: [T1],
      },
      proposerName: "Home Cap",
      kickoffMs: null,
      teamSize: 5,
      home: { ...home, name: "Home" },
      away: { ...away, name: "Away" },
      votes: [],
      people: new Map(),
      viewer: { id: "ac", isAdmin: false },
      named: true,
      open: true,
      nowMs: T1 - DAY,
    });
    expect(withMyAnswer(view, T1, "ready").options[0].captains.away).toBe(
      "ready",
    );
  });
});
