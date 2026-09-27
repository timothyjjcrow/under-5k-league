import { describe, it, expect } from "vitest";
import {
  calledItCount,
  groupOpenByWeek,
  pickemControlFor,
  pickemStandings,
  pickHistory,
  pickResult,
  pickSplit,
  partitionPickemMatches,
  predictionOpen,
  predictionOpenWhere,
} from "./pickem";

const m = (
  id: string,
  status: string,
  winnerTeamId: string | null = null,
  scheduledAt: Date | null = null,
) => ({ id, status, winnerTeamId, scheduledAt });

const p = (matchId: string, userId: string, pickedTeamId: string) => ({
  matchId,
  userId,
  pickedTeamId,
});

describe("predictionOpen", () => {
  const now = new Date("2026-07-12T18:00:00Z");

  it("is open for unplayed, unscheduled matches", () => {
    expect(predictionOpen(m("m1", "SCHEDULED"), now)).toBe(true);
  });

  it("locks at the scheduled start", () => {
    const before = m("m1", "SCHEDULED", null, new Date("2026-07-12T19:00:00Z"));
    const after = m("m1", "SCHEDULED", null, new Date("2026-07-12T17:00:00Z"));
    expect(predictionOpen(before, now)).toBe(true);
    expect(predictionOpen(after, now)).toBe(false);
  });

  it("locks completed matches regardless of schedule", () => {
    expect(predictionOpen(m("m1", "COMPLETED"), now)).toBe(false);
  });
});

describe("pickemStandings", () => {
  const matches = [
    m("m1", "COMPLETED", "A"),
    m("m2", "COMPLETED", "B"),
    m("m3", "COMPLETED", null), // draw — voids predictions
    m("m4", "SCHEDULED"), // unplayed — not graded
  ];

  it("grades correct/incorrect and computes accuracy", () => {
    const rows = pickemStandings(
      [
        p("m1", "u1", "A"), // right
        p("m2", "u1", "B"), // right
        p("m1", "u2", "B"), // wrong
        p("m2", "u2", "B"), // right
        p("m3", "u2", "A"), // drawn — void
        p("m4", "u2", "A"), // unplayed — void
      ],
      matches,
    );
    expect(rows[0]).toMatchObject({ userId: "u1", correct: 2, graded: 2, accuracy: 1 });
    expect(rows[1]).toMatchObject({ userId: "u2", correct: 1, graded: 2, accuracy: 0.5 });
  });

  it("breaks correct-count ties by accuracy", () => {
    const rows = pickemStandings(
      [
        p("m1", "sniper", "A"), // 1/1
        p("m1", "spray", "A"), // 1/2
        p("m2", "spray", "A"),
      ],
      matches,
    );
    expect(rows.map((r) => r.userId)).toEqual(["sniper", "spray"]);
    expect(rows.map((r) => r.place)).toEqual([1, 2]);
  });

  it("ranks more correct picks above a better rate", () => {
    const many = [1, 2, 3, 4, 5].map((i) => m(`w${i}`, "COMPLETED", "A"));
    const rows = pickemStandings(
      [
        p("w1", "volume", "A"),
        p("w2", "volume", "A"),
        p("w3", "volume", "A"),
        p("w4", "volume", "B"),
        p("w5", "volume", "B"), // 3/5
        p("w1", "sniper", "A"),
        p("w2", "sniper", "A"), // 2/2
      ],
      many,
    );
    expect(rows.map((r) => [r.userId, r.place])).toEqual([
      ["volume", 1],
      ["sniper", 2],
    ]);
  });

  it("lets equal records share a place and never splits them by id", () => {
    const many = [1, 2, 3, 4].map((i) => m(`w${i}`, "COMPLETED", "A"));
    const rows = pickemStandings(
      [
        // "zed" and "amy" are both 2/3; "bob" is 2/4; "cat" 0/1; "dan" 0/4.
        ...["w1", "w2"].map((id) => p(id, "zed", "A")),
        p("w3", "zed", "B"),
        ...["w1", "w2"].map((id) => p(id, "amy", "A")),
        p("w4", "amy", "B"),
        ...["w1", "w2"].map((id) => p(id, "bob", "A")),
        p("w3", "bob", "B"),
        p("w4", "bob", "B"),
        p("w1", "cat", "B"),
        ...["w1", "w2", "w3", "w4"].map((id) => p(id, "dan", "B")),
      ],
      many,
    );
    expect(rows.map((r) => [r.userId, r.place])).toEqual([
      ["amy", 1],
      ["zed", 1],
      ["bob", 3],
      // No correct picks: fewer misses still ranks higher.
      ["cat", 4],
      ["dan", 5],
    ]);
  });
});

describe("pickSplit", () => {
  it("counts each side's backers", () => {
    const split = pickSplit(
      [p("m1", "u1", "home"), p("m1", "u2", "away"), p("m1", "u3", "home"), p("m2", "u1", "home")],
      "m1",
      "home",
    );
    expect(split).toEqual({ home: 2, away: 1 });
  });
});

describe("pickResult", () => {
  it("grades right, wrong and void, and waits on an undecided match", () => {
    expect(pickResult(m("m1", "COMPLETED", "A"), "A")).toBe("right");
    expect(pickResult(m("m1", "COMPLETED", "A"), "B")).toBe("wrong");
    expect(pickResult(m("m1", "COMPLETED", null), "A")).toBe("void");
    expect(pickResult(m("m1", "LIVE"), "A")).toBeNull();
    expect(pickResult(m("m1", "SCHEDULED"), "A")).toBeNull();
  });

  it("agrees with the oracle board's grading", () => {
    const matches = [
      m("m1", "COMPLETED", "A"),
      m("m2", "COMPLETED", null),
      m("m3", "LIVE"),
      m("m4", "COMPLETED", "B"),
    ];
    const picks = [p("m1", "u", "A"), p("m2", "u", "A"), p("m3", "u", "A"), p("m4", "u", "A")];
    const [row] = pickemStandings(picks, matches);
    const results = picks.map((pick) =>
      pickResult(matches.find((match) => match.id === pick.matchId)!, pick.pickedTeamId),
    );
    expect(results.filter((r) => r === "right")).toHaveLength(row.correct);
    expect(results.filter((r) => r === "right" || r === "wrong")).toHaveLength(row.graded);
  });
});

describe("calledItCount", () => {
  const picks = [
    p("m1", "u1", "A"),
    p("m1", "u2", "A"),
    p("m1", "u3", "B"),
    p("m2", "u1", "B"),
  ];

  it("counts who named the winner out of everyone who picked", () => {
    expect(calledItCount(picks, m("m1", "COMPLETED", "A"))).toEqual({ called: 2, total: 3 });
    expect(calledItCount(picks, m("m1", "COMPLETED", "B"))).toEqual({ called: 1, total: 3 });
  });

  it("has nothing to say without a winner or without picks", () => {
    expect(calledItCount(picks, m("m1", "COMPLETED", null))).toBeNull();
    expect(calledItCount(picks, m("m1", "LIVE"))).toBeNull();
    expect(calledItCount(picks, m("m9", "COMPLETED", "A"))).toBeNull();
  });
});

describe("pickHistory", () => {
  const at = (iso: string) => new Date(iso);
  const row = (
    id: string,
    week: number,
    status: string,
    winnerTeamId: string | null,
    scheduledAt: Date | null,
  ) => ({ ...m(id, status, winnerTeamId, scheduledAt), week });

  it("lists only picked matches, newest first, each with how it came out", () => {
    const matches = [
      row("w1", 1, "COMPLETED", "A", at("2026-08-01T20:00:00Z")),
      row("w2a", 2, "COMPLETED", null, at("2026-08-08T20:00:00Z")),
      row("w2b", 2, "COMPLETED", "B", at("2026-08-08T22:00:00Z")),
      row("w3", 3, "LIVE", null, at("2026-08-15T20:00:00Z")),
      row("unpicked", 3, "COMPLETED", "A", at("2026-08-15T20:00:00Z")),
    ];
    const picks = new Map([
      ["w1", "A"],
      ["w2a", "A"],
      ["w2b", "A"],
      ["w3", "B"],
    ]);
    expect(
      pickHistory(matches, picks).map((h) => [h.match.id, h.result]),
    ).toEqual([
      ["w3", null],
      ["w2b", "wrong"],
      ["w2a", "void"],
      ["w1", "right"],
    ]);
  });

  it("puts a TBD kickoff after the timed ones in its week", () => {
    const matches = [
      row("tbd", 4, "COMPLETED", "A", null),
      row("timed", 4, "COMPLETED", "A", at("2026-08-22T20:00:00Z")),
    ];
    const picks = new Map([
      ["tbd", "A"],
      ["timed", "A"],
    ]);
    expect(pickHistory(matches, picks).map((h) => h.match.id)).toEqual([
      "timed",
      "tbd",
    ]);
  });
});

describe("predictionOpen — live series", () => {
  it("locks a LIVE match even when a reschedule moved its time into the future", () => {
    // Game 1 imported (status LIVE), captains accept "finish Thursday":
    // scheduledAt is future again, but the 1-0 scoreline is public.
    const m = {
      id: "m1",
      status: "LIVE",
      winnerTeamId: null,
      scheduledAt: new Date(Date.now() + 86_400_000),
    };
    expect(predictionOpen(m)).toBe(false);
  });
});

describe("partitionPickemMatches", () => {
  it("keeps every match in exactly one open, locked, graded, or void bucket", () => {
    const now = new Date("2026-08-03T20:00:00Z");
    const rows = [
      m("open", "SCHEDULED", null, new Date("2026-08-03T21:00:00Z")),
      m("locked", "LIVE", null, new Date("2026-08-03T19:00:00Z")),
      m("graded", "COMPLETED", "A"),
      m("void", "COMPLETED", null),
    ];
    const buckets = partitionPickemMatches(rows, now);
    expect(buckets.open.map((row) => row.id)).toEqual(["open"]);
    expect(buckets.locked.map((row) => row.id)).toEqual(["locked"]);
    expect(buckets.graded.map((row) => row.id)).toEqual(["graded"]);
    expect(buckets.voided.map((row) => row.id)).toEqual(["void"]);
    expect(
      Object.values(buckets).flatMap((bucket) => bucket.map((row) => row.id)),
    ).toHaveLength(rows.length);
  });
});

describe("groupOpenByWeek", () => {
  it("puts the week with the next real deadline first and sorts within it", () => {
    const rows = [
      { week: 3, id: "c", scheduledAt: new Date("2026-08-05T20:00:00Z") },
      { week: 1, id: "a", scheduledAt: new Date("2026-08-07T20:00:00Z") },
      { week: 3, id: "d", scheduledAt: new Date("2026-08-04T20:00:00Z") },
      { week: 1, id: "b", scheduledAt: null },
    ];
    const grouped = groupOpenByWeek(rows);
    expect(grouped.map((g) => g.week)).toEqual([3, 1]);
    expect(grouped[0].matches.map((row) => row.id)).toEqual(["d", "c"]);
    expect(grouped[1].matches.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("handles an empty list", () => {
    expect(groupOpenByWeek([])).toEqual([]);
  });
});

describe("predictionOpen and predictionOpenWhere agree on every state", () => {
  // The action enforces the lock with the WHERE; the UI and the create-leg
  // re-check use the boolean. If they drift, one of them lies. This sweep
  // evaluates the WHERE fragment in JS against the same match grid (the
  // registration.test.ts medalProvesIneligible↔registrationGate precedent).
  function satisfiesWhere(
    m: { status: string; scheduledAt: Date | null },
    now: Date,
  ): boolean {
    const w = predictionOpenWhere(now);
    if ((w.status.notIn as string[]).includes(m.status)) return false;
    return w.OR.some((clause) =>
      "scheduledAt" in clause && clause.scheduledAt === null
        ? m.scheduledAt === null
        : m.scheduledAt !== null &&
          m.scheduledAt.getTime() >
            (clause.scheduledAt as { gt: Date }).gt.getTime(),
    );
  }

  it("sweeps status × scheduledAt", () => {
    const now = new Date("2026-07-30T20:00:00Z");
    const statuses = ["SCHEDULED", "LIVE", "COMPLETED"];
    const times: (Date | null)[] = [
      null,
      new Date(now.getTime() - 3600_000), // past
      new Date(now.getTime()), // exactly now (locked — predictionOpen uses <=)
      new Date(now.getTime() + 3600_000), // future
    ];
    for (const status of statuses) {
      for (const scheduledAt of times) {
        const m = {
          id: "m",
          status,
          winnerTeamId: null,
          scheduledAt,
        };
        expect(
          satisfiesWhere(m, now),
          `status=${status} scheduledAt=${scheduledAt?.toISOString() ?? "null"}`,
        ).toBe(predictionOpen(m, now));
      }
    }
  });
});

describe("pickemControlFor", () => {
  const now = new Date("2026-08-03T20:00:00Z");
  const fixture = (
    status: string,
    scheduledAt: Date | null,
    winnerTeamId: string | null = null,
  ) => ({
    id: "m1",
    status,
    winnerTeamId,
    scheduledAt,
    homeTeamId: "home",
    awayTeamId: "away",
  });
  const later = new Date("2026-08-03T21:00:00Z");
  const earlier = new Date("2026-08-03T19:00:00Z");
  const viewer = (pickedTeamId: string | null = null, canPlay = true) => ({
    signedIn: true,
    canPlay,
    pickedTeamId,
  });

  it("shows signed-out viewers nothing, even on an open match", () => {
    expect(
      pickemControlFor(
        fixture("SCHEDULED", later),
        { signedIn: false, canPlay: true, pickedTeamId: null },
        now,
      ),
    ).toBeNull();
  });

  it("offers the control on an open match, pressed on the viewer's pick", () => {
    expect(pickemControlFor(fixture("SCHEDULED", later), viewer(), now)).toEqual({
      kind: "open",
      pickedTeamId: null,
    });
    expect(
      pickemControlFor(fixture("SCHEDULED", later), viewer("away"), now),
    ).toEqual({ kind: "open", pickedTeamId: "away" });
    // TBD kickoff stays open until the series goes LIVE (predictionOpen).
    expect(pickemControlFor(fixture("SCHEDULED", null), viewer(), now)).toEqual({
      kind: "open",
      pickedTeamId: null,
    });
  });

  it("locks at kickoff: the pick becomes plain text, no pick means nothing", () => {
    expect(
      pickemControlFor(fixture("SCHEDULED", earlier), viewer("home"), now),
    ).toEqual({ kind: "locked", pickedTeamId: "home" });
    expect(
      pickemControlFor(fixture("SCHEDULED", earlier), viewer(), now),
    ).toBeNull();
    // Exactly at kickoff is already locked, like predictionOpen.
    expect(pickemControlFor(fixture("SCHEDULED", now), viewer(), now)).toBeNull();
  });

  it("treats LIVE, graded and void matches as locked whatever the kickoff says", () => {
    for (const match of [
      fixture("LIVE", later),
      fixture("COMPLETED", earlier, "home"),
      fixture("COMPLETED", earlier, null),
    ]) {
      expect(pickemControlFor(match, viewer("away"), now)).toEqual({
        kind: "locked",
        pickedTeamId: "away",
      });
      expect(pickemControlFor(match, viewer(), now)).toBeNull();
    }
  });

  it("never offers the control when the season gate is closed", () => {
    // predictionOpen is true here; canPlay is what keeps an archived season
    // (or a closed phase) from rendering buttons savePrediction would refuse.
    expect(
      pickemControlFor(fixture("SCHEDULED", later), viewer(null, false), now),
    ).toBeNull();
    expect(
      pickemControlFor(fixture("SCHEDULED", later), viewer("home", false), now),
    ).toEqual({ kind: "locked", pickedTeamId: "home" });
  });

  it("ignores a pick that names neither side", () => {
    expect(
      pickemControlFor(fixture("SCHEDULED", later), viewer("other"), now),
    ).toEqual({ kind: "open", pickedTeamId: null });
    expect(
      pickemControlFor(fixture("LIVE", later), viewer("other"), now),
    ).toBeNull();
  });
});
