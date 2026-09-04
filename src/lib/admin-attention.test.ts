import { describe, expect, it } from "vitest";
import { gameQualityReasons, matchAttention } from "./admin-attention";

const now = Date.UTC(2026, 8, 4, 20);
const match = {
  id: "match",
  status: "SCHEDULED",
  scheduledAt: new Date(now + 60_000),
  availability: [],
  standins: [],
  reschedules: [],
};

describe("read-only match attention", () => {
  it("never treats a future fixture as overdue", () =>
    expect(matchAttention([match], now)).toEqual([]));
  it("does not flag a newly started series", () =>
    expect(
      matchAttention([{ ...match, scheduledAt: new Date(now - 60_000) }], now),
    ).toEqual([]));
  it("identifies a long-running unresolved result", () =>
    expect(
      matchAttention(
        [{ ...match, scheduledAt: new Date(now - 3 * 3600_000) }],
        now,
      )[0].reasons,
    ).toContain("Started over 2 hours ago; result still open"));
  it("ignores completed fixtures even with old logistics rows", () =>
    expect(
      matchAttention(
        [
          {
            ...match,
            status: "COMPLETED",
            scheduledAt: null,
            reschedules: [{ status: "PENDING" }],
          },
        ],
        now,
      ),
    ).toEqual([]));
  it("combines missing kickoff, pending response, and uncovered absence", () =>
    expect(
      matchAttention(
        [
          {
            ...match,
            scheduledAt: null,
            reschedules: [{ status: "PENDING" }],
            availability: [{ userId: "p1", status: "OUT" }],
          },
        ],
        now,
      )[0].reasons,
    ).toHaveLength(3));
  it("does not count covered absences or accepted requests", () =>
    expect(
      matchAttention(
        [
          {
            ...match,
            reschedules: [{ status: "ACCEPTED" }],
            availability: [{ userId: "p1", status: "OUT" }],
            standins: [{ replacingUserId: "p1" }],
          },
        ],
        now,
      ),
    ).toEqual([]));
});

describe("game quality diagnostics", () => {
  it("reports corrupt and incomplete data without throwing", () => {
    expect(gameQualityReasons("not json")[0]).toContain("valid player array");
    expect(gameQualityReasons("[]")[0]).toContain("5v5");
  });
  it("separates catalogue problems from invalid scores", () => {
    const players = Array.from({ length: 10 }, (_, index) => ({
      heroId: index === 0 ? 9999 : index + 1,
      isRadiant: index < 5,
      userId: `p${index}`,
      accountId: index + 1,
      kills: 0,
      deaths: 0,
      assists: 0,
    }));
    const reasons = gameQualityReasons(JSON.stringify(players));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(
      "Update the hero catalogue; do not remove otherwise valid games",
    );
  });
});
