import { describe, expect, it } from "vitest";
import {
  adminAttention,
  attentionTitle,
  gameQualityReasons,
  matchAttention,
  outStandins,
  shortTeams,
  standinClashes,
  unlinkedRosterCount,
  type AdminAttentionInput,
} from "./admin-attention";

const now = Date.UTC(2026, 8, 4, 20);
const match = {
  id: "match",
  status: "SCHEDULED",
  homeTeamId: "home",
  awayTeamId: "away",
  scheduledAt: new Date(now + 60_000),
  availability: [],
  standins: [],
  reschedules: [],
};
const teams = [
  { id: "home", members: [{ userId: "p1" }, { userId: "p2" }] },
  { id: "away", members: [{ userId: "p3" }] },
  { id: "elsewhere", members: [{ userId: "p9" }] },
];

describe("read-only match attention", () => {
  it("never treats a future fixture as overdue", () =>
    expect(matchAttention([match], teams, now)).toEqual([]));
  it("does not flag a newly started series", () =>
    expect(
      matchAttention(
        [{ ...match, scheduledAt: new Date(now - 60_000) }],
        teams,
        now,
      ),
    ).toEqual([]));
  it("identifies a long-running unresolved result", () =>
    expect(
      matchAttention(
        [{ ...match, scheduledAt: new Date(now - 3 * 3600_000) }],
        teams,
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
        teams,
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
        teams,
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
            standins: [{ replacingUserId: "p1", standinUserId: "s1" }],
          },
        ],
        teams,
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

describe("standinClashes", () => {
  const at = (hours: number) => new Date(now + hours * 3600_000);
  const fixtures = [
    { id: "a", status: "SCHEDULED", week: 3, scheduledAt: at(1) },
    { id: "b", status: "SCHEDULED", week: 3, scheduledAt: at(2) },
    { id: "c", status: "SCHEDULED", week: 4, scheduledAt: at(24 * 7) },
    { id: "done", status: "COMPLETED", week: 3, scheduledAt: at(1) },
  ];

  it("finds one standin booked twice on the same night", () => {
    const clashes = standinClashes(
      [
        { matchId: "a", standinUserId: "s1" },
        { matchId: "b", standinUserId: "s1" },
        { matchId: "c", standinUserId: "s1" },
        { matchId: "a", standinUserId: "s2" },
      ],
      fixtures,
    );
    expect(
      clashes.map((c) => [c.standinUserId, c.first.id, c.second.id]),
    ).toEqual([["s1", "a", "b"]]);
  });

  it("ignores played matches and a second seat in the same match", () => {
    expect(
      standinClashes(
        [
          { matchId: "a", standinUserId: "s1" },
          { matchId: "done", standinUserId: "s1" },
          { matchId: "a", standinUserId: "s1" },
        ],
        fixtures,
      ),
    ).toEqual([]);
  });
});

describe("outStandins", () => {
  it("names booked standins who said they can't play an open match", () => {
    expect(
      outStandins(
        [
          { matchId: "m1", standinUserId: "s1" },
          { matchId: "m2", standinUserId: "s2" },
        ],
        [
          { matchId: "m1", userId: "s1" },
          { matchId: "m1", userId: "rostered" },
          { matchId: "m2", userId: "s2" },
          { matchId: "m3", userId: "s1" },
        ],
        new Set(["m1", "m3"]),
      ),
    ).toEqual([{ matchId: "m1", userId: "s1" }]);
  });
});

describe("shortTeams", () => {
  it("lists live teams below the side size, never a withdrawn one", () => {
    const teams = [
      { name: "Full", withdrawn: false, members: [1, 2, 3, 4, 5] },
      { name: "Short", withdrawn: false, members: [1, 2, 3] },
      { name: "Gone", withdrawn: true, members: [1] },
    ];
    expect(
      shortTeams(teams, 5).map(({ team, missing }) => [team.name, missing]),
    ).toEqual([["Short", 2]]);
  });
});

describe("unlinkedRosterCount", () => {
  const member = (userId: string, discordId: string | null = null) => ({
    userId,
    user: { discordId },
  });
  const booking = (
    matchId: string,
    standinUserId: string,
    discordId: string | null = null,
  ) => ({ matchId, standinUserId, standin: { discordId } });

  it("counts unlinked players on live teams and standins owed on an open match, once each", () => {
    expect(
      unlinkedRosterCount(
        [
          {
            withdrawn: false,
            members: [member("p1"), member("p2", "d2"), member("p3")],
          },
          // A withdrawn team plays no more fixtures, so nobody pings it.
          { withdrawn: true, members: [member("gone")] },
        ],
        [
          booking("open", "s1"),
          booking("open", "s2", "d-s2"),
          // Cover on a played match needs no ping.
          booking("played", "s3"),
          // A released player now booked as cover counts once.
          booking("open", "p1"),
        ],
        new Set(["open"]),
      ),
    ).toBe(3);
  });
});

describe("adminAttention", () => {
  const base: AdminAttentionInput = {
    seasonStatus: "REGULAR_SEASON",
    draftComplete: true,
    automation: [],
    importsNeedingReview: 0,
    shortTeams: [],
    standinClashes: [],
    outStandins: [],
    championIssue: null,
    unlinkedSignups: 0,
    unlinkedRostered: 0,
  };

  it("is empty when nothing is wrong", () => {
    expect(adminAttention(base)).toEqual([]);
    expect(attentionTitle("Season 9", 0)).toBe("Season 9: all clear");
  });

  it("feeds every alarm into one list, each linking to its control", () => {
    const items = adminAttention({
      ...base,
      automation: ["Automation's last run failed."],
      importsNeedingReview: 2,
      shortTeams: [{ name: "Couriers", missing: 1 }],
      standinClashes: [{ standin: "Sam", first: "A vs B", second: "C vs D" }],
      outStandins: [{ standin: "Lee", fixture: "E vs F" }],
      unlinkedRostered: 4,
    });
    expect(items.map((item) => [item.text, item.href])).toEqual([
      ["Automation's last run failed.", "#adm-automation"],
      ["2 imported games need review before they count.", "#adm-sync"],
      [
        "Couriers is a player short. Sign a free agent, or book a standin for the empty seat.",
        "#adm-roster",
      ],
      [
        "Sam is booked to stand in for A vs B and C vs D on the same night.",
        "#adm-standins",
      ],
      [
        "Lee is booked to stand in for E vs F but has said they can't play.",
        "#adm-standins",
      ],
      [
        "4 rostered players and standins haven't linked Discord, so pings can't reach them.",
        "#adm-reach",
      ],
    ]);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    expect(attentionTitle("Season 9", items.length)).toBe(
      "Season 9: 6 things need attention",
    );
    expect(attentionTitle("Season 9", 1)).toBe(
      "Season 9: 1 thing needs attention",
    );
  });

  it("counts signups before the auction and rosters after it", () => {
    const signups = adminAttention({
      ...base,
      seasonStatus: "SIGNUPS",
      draftComplete: false,
      shortTeams: [{ name: "Empty", missing: 4 }],
      unlinkedSignups: 1,
      unlinkedRostered: 9,
    });
    expect(signups.map((item) => item.text)).toEqual([
      "1 signed-up player hasn't linked Discord, so pings can't reach them.",
    ]);
    const drafted = adminAttention({
      ...base,
      seasonStatus: "DRAFT",
      unlinkedSignups: 1,
      unlinkedRostered: 1,
    });
    expect(drafted.map((item) => item.text)).toEqual([
      "1 rostered player or standin hasn't linked Discord, so pings can't reach them.",
    ]);
  });

  it("keys short-team lines uniquely even when two teams share a name", () => {
    const items = adminAttention({
      ...base,
      shortTeams: [
        { name: "Couriers", missing: 1 },
        { name: "Couriers", missing: 2 },
      ],
    });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.key)).size).toBe(2);
  });

  it("drops roster and Discord chasing once the season is complete, keeping champion problems", () => {
    const items = adminAttention({
      ...base,
      seasonStatus: "COMPLETE",
      shortTeams: [{ name: "Short", missing: 1 }],
      unlinkedRostered: 3,
      championIssue: "missing",
    });
    expect(items.map((item) => item.href)).toEqual(["#adm-playoffs"]);
    expect(items[0].text).toContain("Fix the bracket");
    expect(
      adminAttention({ ...base, championIssue: "inconsistent" })[0].text,
    ).toMatch(/^The recorded champion doesn't match the grand final/);
  });
});

describe("matchAttention and booked standins", () => {
  it("leaves a booked standin's own OUT to the standin line", () =>
    expect(
      matchAttention(
        [
          {
            ...match,
            availability: [{ userId: "s1", status: "OUT" }],
            standins: [{ replacingUserId: "p1", standinUserId: "s1" }],
          },
        ],
        teams,
        now,
      ),
    ).toEqual([]));
});

describe("matchAttention counts cover like the Standins card", () => {
  const out = (...userIds: string[]) =>
    userIds.map((userId) => ({ userId, status: "OUT" }));

  it("counts only this fixture's roster players, like matchCoverIssues", () => {
    // p1 is on the home roster; "released" left the league's rosters, and
    // p9 plays for a team that isn't in this fixture. Neither can be
    // covered, so neither can need cover.
    const [item] = matchAttention(
      [{ ...match, availability: out("p1", "released", "p9") }],
      teams,
      now,
    );
    expect(item).toEqual({
      id: "match",
      reasons: ["1 declared absence without assigned cover"],
      uncovered: 1,
    });
  });

  it("raises nothing for a released player's old OUT", () =>
    expect(
      matchAttention([{ ...match, availability: out("released") }], teams, now),
    ).toEqual([]));

  it("an IN answer never counts", () =>
    expect(
      matchAttention(
        [{ ...match, availability: [{ userId: "p1", status: "IN" }] }],
        teams,
        now,
      ),
    ).toEqual([]));
});
