import { describe, it, expect } from "vitest";
import {
  groupOpenByWeek,
  pickemStandings,
  pickSplit,
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

describe("groupOpenByWeek", () => {
  it("groups by week ascending, preserving in-week order", () => {
    const rows = [
      { week: 3, id: "c" },
      { week: 1, id: "a" },
      { week: 3, id: "d" },
      { week: 1, id: "b" },
    ];
    const grouped = groupOpenByWeek(rows);
    expect(grouped.map((g) => g.week)).toEqual([1, 3]);
    expect(grouped[0].matches.map((m) => m.id)).toEqual(["a", "b"]);
    expect(grouped[1].matches.map((m) => m.id)).toEqual(["c", "d"]);
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
