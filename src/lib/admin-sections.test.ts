import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/support/source-files";
import {
  adminSeasonCards,
  coverProblemMatchIds,
  matchCoverIssues,
  openBookingCount,
} from "./admin-sections";

const base = {
  draftStatus: null,
  matches: [],
  openBookings: 0,
  archivedPostseasonGames: 0,
};
const regular = { phase: "REGULAR", status: "SCHEDULED" };

describe("adminSeasonCards", () => {
  it("shows only the setup view during signups", () => {
    expect(adminSeasonCards({ ...base, seasonStatus: "SIGNUPS" })).toEqual({
      schedule: false,
      playoffs: false,
      standins: false,
    });
  });

  it("opens fixtures and standins only once the auction is complete", () => {
    expect(
      adminSeasonCards({ ...base, seasonStatus: "DRAFT", draftStatus: "NOT_STARTED" }),
    ).toMatchObject({ schedule: false, standins: false });
    expect(
      adminSeasonCards({ ...base, seasonStatus: "DRAFT", draftStatus: "IN_PROGRESS" }),
    ).toMatchObject({ schedule: false, standins: false });
    expect(
      adminSeasonCards({ ...base, seasonStatus: "DRAFT", draftStatus: "COMPLETE" }),
    ).toEqual({ schedule: true, playoffs: false, standins: true });
  });

  it("shows every card while the league is playing", () => {
    for (const seasonStatus of ["REGULAR_SEASON", "PLAYOFFS"]) {
      expect(
        adminSeasonCards({ ...base, seasonStatus, draftStatus: "COMPLETE" }),
      ).toEqual({ schedule: true, playoffs: true, standins: true });
    }
  });

  it("keeps a finished season's record but drops standins with nothing booked", () => {
    const cards = adminSeasonCards({
      ...base,
      seasonStatus: "COMPLETE",
      draftStatus: "COMPLETE",
      matches: [{ phase: "FINAL", status: "COMPLETED" }],
    });
    expect(cards).toEqual({
      schedule: true,
      playoffs: true,
      standins: false,
    });
  });

  it("never hides data that exists, whatever the phase", () => {
    // Fixtures, a bracket, archived playoff ids or a live booking left over
    // from a phase fix keep their card, so they stay readable and removable.
    const signups = { ...base, seasonStatus: "SIGNUPS" };
    expect(adminSeasonCards({ ...signups, matches: [regular] }).schedule).toBe(true);
    expect(
      adminSeasonCards({ ...signups, matches: [{ phase: "PLAYOFF", status: "SCHEDULED" }] })
        .playoffs,
    ).toBe(true);
    expect(
      adminSeasonCards({ ...signups, archivedPostseasonGames: 2 }).playoffs,
    ).toBe(true);
    expect(adminSeasonCards({ ...signups, openBookings: 1 }).standins).toBe(true);
    expect(
      adminSeasonCards({ ...base, seasonStatus: "COMPLETE", openBookings: 1 }).standins,
    ).toBe(true);
  });
});

describe("openBookingCount", () => {
  it("counts bookings on matches that aren't played yet", () => {
    const matches = [
      { id: "a", status: "SCHEDULED" },
      { id: "b", status: "LIVE" },
      { id: "c", status: "COMPLETED" },
    ];
    expect(
      openBookingCount(
        [{ matchId: "a" }, { matchId: "b" }, { matchId: "c" }, { matchId: "gone" }],
        matches,
      ),
    ).toBe(2);
  });
});

describe("matchCoverIssues and coverProblemMatchIds", () => {
  const teams = [
    { id: "a", members: [{ userId: "a1" }, { userId: "a2" }] },
    { id: "b", members: [{ userId: "b1" }, { userId: "b2" }] },
    { id: "c", members: [{ userId: "c1" }] },
  ];
  const match = (id: string, home: string, away: string, status = "SCHEDULED") => ({
    id,
    homeTeamId: home,
    awayTeamId: away,
    status,
  });

  it("finds a roster player out with no cover, and drops them once covered", () => {
    const m = match("m1", "a", "b");
    const out = [{ matchId: "m1", userId: "a1" }];
    expect(matchCoverIssues(m, teams, [], out).uncovered).toEqual(out);
    const covered = [{ matchId: "m1", standinUserId: "s1", replacingUserId: "a1" }];
    expect(matchCoverIssues(m, teams, covered, out).uncovered).toEqual([]);
  });

  it("ignores an out from someone no longer on either roster", () => {
    const issues = matchCoverIssues(
      match("m1", "a", "b"),
      teams,
      [],
      [{ matchId: "m1", userId: "c1" }],
    );
    expect(issues).toEqual({ uncovered: [], standinsOut: [] });
  });

  it("reports a booked standin who dropped out, and only on that match", () => {
    const bookings = [{ matchId: "m1", standinUserId: "s1", replacingUserId: null }];
    const out = [
      { matchId: "m1", userId: "s1" },
      { matchId: "m2", userId: "s1" },
    ];
    expect(matchCoverIssues(match("m1", "a", "b"), teams, bookings, out).standinsOut).toEqual([
      out[0],
    ]);
    expect(matchCoverIssues(match("m2", "a", "c"), teams, bookings, out).standinsOut).toEqual([]);
  });

  it("opens the card on uncovered outs, dropped standins and same-night clashes only", () => {
    const matches = [
      match("quiet", "a", "b"),
      match("out", "a", "c"),
      match("dropped", "b", "c"),
      match("clash1", "a", "b"),
      match("clash2", "b", "c"),
      match("played", "a", "b", "COMPLETED"),
    ];
    const ids = coverProblemMatchIds({
      matches,
      teams,
      bookings: [
        { matchId: "dropped", standinUserId: "s1", replacingUserId: "b1" },
        { matchId: "clash1", standinUserId: "s2", replacingUserId: "a2" },
        { matchId: "clash2", standinUserId: "s2", replacingUserId: "c1" },
      ],
      outRsvps: [
        { matchId: "out", userId: "a1" },
        { matchId: "dropped", userId: "s1" },
        { matchId: "played", userId: "a1" },
      ],
      clashes: [{ first: matches[3], second: matches[4] }],
    });
    expect([...ids].sort()).toEqual(["clash1", "clash2", "dropped", "out"]);
  });
});

// A link from another page to /admin#adm-schedule must only render where
// /admin renders that card, or it lands at the top of the page with no
// matching section (the /schedule empty state showed it during signups).
describe("links to the Schedule & results card", () => {
  it("/schedule's empty state asks adminSeasonCards before linking", () => {
    const page = readFileSync(
      path.join(REPO_ROOT, "src/app/schedule/page.tsx"),
      "utf8",
    );
    const at = page.indexOf("Open schedule controls");
    expect(at).toBeGreaterThan(0);
    const before = page.slice(Math.max(0, at - 900), at);
    expect(before).toMatch(
      /viewer\?\.role === "ADMIN" &&\s*adminSeasonCards\(\{[\s\S]*?\}\)\.schedule \?/,
    );
  });
});
