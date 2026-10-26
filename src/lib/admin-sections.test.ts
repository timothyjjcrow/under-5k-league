import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/support/source-files";
import {
  adminMayAgreeToRequest,
  adminSeasonCards,
  coverProblemMatchIds,
  matchCoverIssues,
  openBookingCount,
  uncoveredByRequest,
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

  // A request (the MMR rule) is not cover, so its seat stays uncovered and
  // the match stays a cover problem; but the Covers list hides that seat, so
  // the banner names who has to answer and the request row's controls.
  describe("uncoveredByRequest", () => {
    const m = match("m1", "a", "b");
    const teamName = new Map([
      ["a", "Alpha"],
      ["b", "Bravo"],
    ]);
    const out = [
      { matchId: "m1", userId: "a1" },
      { matchId: "m1", userId: "b1" },
    ];
    const asked = {
      matchId: "m1",
      teamId: "a",
      replacingUserId: "a1",
      requestedById: "capA",
      standin: { name: "Sub Sam" },
    };
    const always = () => true;

    it("points a seat with a waiting request at the other captain's answer", () => {
      const { uncovered } = matchCoverIssues(m, teams, [], out);
      expect(uncovered).toEqual(out);
      expect(
        uncoveredByRequest({
          match: m,
          uncovered,
          requests: [asked],
          teamName,
          canAgree: always,
        }),
      ).toEqual({
        needCover: [out[1]],
        waiting: [
          {
            rsvp: out[0],
            note: "waiting on the Bravo captain's OK for Sub Sam (agree, decline or withdraw below)",
          },
        ],
      });
      // Still a cover problem: the card opens on it.
      expect([
        ...coverProblemMatchIds({
          matches: [m],
          teams,
          bookings: [],
          outRsvps: [out[0]],
          clashes: [],
        }),
      ]).toEqual(["m1"]);
    });

    // The block's own answer for each row, so the banner names exactly the
    // controls the row renders.
    const captains = new Map([
      ["a", "capA"],
      ["b", "capB"],
    ]);
    const asViewer =
      (viewerId: string | undefined, agreeOpen = true) =>
      (r: typeof asked) =>
        adminMayAgreeToRequest({
          agreeOpen,
          viewerId,
          request: r,
          askingCaptainId: captains.get(r.teamId),
        });

    it("names only the controls that show once booking has closed", () => {
      expect(
        uncoveredByRequest({
          match: m,
          uncovered: [out[1]],
          requests: [{ ...asked, teamId: "b", replacingUserId: "b1" }],
          teamName,
          canAgree: asViewer("someAdmin", false),
        }).waiting.map((w) => w.note),
      ).toEqual([
        "waiting on the Alpha captain's OK for Sub Sam (decline or withdraw below)",
      ]);
    });

    it("never names agree to an admin on the asking side, request by request", () => {
      const fromBravo = {
        ...asked,
        teamId: "b",
        replacingUserId: "b1",
        requestedById: "capB",
      };
      const notes = (viewerId: string | undefined) =>
        uncoveredByRequest({
          match: m,
          uncovered: out,
          requests: [asked, fromBravo],
          teamName,
          canAgree: asViewer(viewerId),
        }).waiting.map((w) => w.note);
      const agree = (other: string) =>
        `waiting on the ${other} captain's OK for Sub Sam (agree, decline or withdraw below)`;
      const noAgree = (other: string) =>
        `waiting on the ${other} captain's OK for Sub Sam (decline or withdraw below)`;
      // Alpha's captain, an admin: not their own request, but Bravo's.
      expect(notes("capA")).toEqual([noAgree("Bravo"), agree("Alpha")]);
      expect(notes("capB")).toEqual([agree("Bravo"), noAgree("Alpha")]);
      // An admin on neither team, and a caller that names no viewer.
      expect(notes("someAdmin")).toEqual([agree("Bravo"), agree("Alpha")]);
      expect(notes(undefined)).toEqual([agree("Bravo"), agree("Alpha")]);
    });

    it("ignores an empty-seat request and one for another match", () => {
      const split = uncoveredByRequest({
        match: m,
        uncovered: [out[0]],
        requests: [
          { ...asked, replacingUserId: null },
          { ...asked, matchId: "m2" },
        ],
        teamName,
        canAgree: always,
      });
      expect(split).toEqual({ needCover: [out[0]], waiting: [] });
    });

    // The block on /admin and the match page is a server component: pin
    // that its banner asks this split and that the controls it names render.
    it("the admin standin block uses it and renders withdraw beside agree and decline", () => {
      const block = readFileSync(
        path.join(REPO_ROOT, "src/components/admin-match-tools.tsx"),
        "utf8",
      );
      expect(block).toContain("uncoveredByRequest({");
      expect(block).toContain("canAgree: mayAgree");
      for (const action of [
        "approveStandinRequestAsAdmin",
        "declineStandinRequestAsAdmin",
        "withdrawStandinRequestAsAdmin",
      ]) {
        expect(block).toContain(`action={${action}}`);
      }
      for (const label of ["agree", "decline", "withdraw"]) {
        expect(block).toMatch(new RegExp(`>\\s*${label}\\s*</SubmitButton>`));
      }
    });
  });
});

// approveStandinRequest refuses an admin who captains the asking team or
// filed the request ("You captain <team>, the team asking — …"), so the
// admin standin block hides "agree" for them; decline and withdraw stay.
describe("adminMayAgreeToRequest", () => {
  const request = { requestedById: "filer" };
  const may = (
    viewerId: string | undefined,
    askingCaptainId: string | undefined = "askingCap",
    agreeOpen = true,
  ) => adminMayAgreeToRequest({ agreeOpen, viewerId, request, askingCaptainId });

  it("offers agree to an admin on neither side, and to the other captain", () => {
    expect(may("someAdmin")).toBe(true);
    expect(may("otherCap")).toBe(true);
  });

  it("hides it from the admin who filed the request", () => {
    expect(may("filer")).toBe(false);
    // Even once the captaincy has moved on and they no longer captain it.
    expect(may("filer", "newCap")).toBe(false);
  });

  it("hides it from the admin who captains the asking team now", () => {
    // A captaincy handed over since the ask: the service judges today's.
    expect(may("askingCap")).toBe(false);
  });

  it("hides it from everyone once booking has closed", () => {
    for (const viewer of ["someAdmin", "otherCap", "filer", undefined]) {
      expect(may(viewer, "askingCap", false)).toBe(false);
    }
  });

  it("leaves what it can't judge to the booking gate", () => {
    // No viewer named: the block as it rendered before the prop existed.
    expect(may(undefined)).toBe(true);
    // An asking captain the page didn't load: only the filer is known.
    expect(may("someAdmin", undefined)).toBe(true);
    expect(may("filer", undefined)).toBe(false);
  });

  // The block is a server component: pin that its row and its banner both
  // ask this one predicate, that only "agree" hides on it, and that both
  // pages hand it the viewer and each team's captain.
  it("is what the admin standin block and both its pages use", () => {
    const tools = readFileSync(
      path.join(REPO_ROOT, "src/components/admin-match-tools.tsx"),
      "utf8",
    );
    const block = tools.slice(
      tools.indexOf("export function StandinMatchBlock("),
      tools.indexOf("export async function AdminMatchTools("),
    );
    expect(block).toMatch(
      /const mayAgree = \(r: StandinRequestView\) =>\s*adminMayAgreeToRequest\(\{\s*agreeOpen: assignOpen,\s*viewerId,\s*request: r,\s*askingCaptainId: teams\.find\(\(t\) => t\.id === r\.teamId\)\?\.captainId,\s*\}\);/,
    );
    expect(block).toContain("canAgree: mayAgree");
    // "agree" alone sits behind it; decline and withdraw follow its `: null`.
    expect(block).toMatch(
      /\{mayAgree\(r\) \? \(\s*<ActionForm\s+action=\{approveStandinRequestAsAdmin\}[\s\S]*?<\/ActionForm>\s*\) : null\}\s*<ActionForm\s+action=\{declineStandinRequestAsAdmin\}/,
    );
    expect(block.match(/mayAgree\(r\)/g)).toHaveLength(1);
    expect(block).not.toMatch(/\{assignOpen \? \(\s*<ActionForm\s+action=\{approveStandinRequestAsAdmin\}/);
    // The match page's Admin tools: the viewer through, captains loaded.
    const adminTools = tools.slice(
      tools.indexOf("export async function AdminMatchTools("),
    );
    expect(adminTools).toMatch(/<StandinMatchBlock[\s\S]*?viewerId=\{viewerId\}/);
    expect(adminTools).toMatch(
      /prisma\.team\.findMany\(\{[\s\S]*?select: \{\s*id: true,\s*name: true,\s*captainId: true,/,
    );
    const matchPage = readFileSync(
      path.join(REPO_ROOT, "src/app/matches/[id]/page.tsx"),
      "utf8",
    );
    expect(matchPage).toMatch(/<AdminMatchTools[^>]*?viewerId=\{viewer\.id\}/);
    // /admin: every Standins card gets the signed-in admin, and its teams
    // are whole Team rows (captainId included).
    const admin = readFileSync(
      path.join(REPO_ROOT, "src/app/admin/page.tsx"),
      "utf8",
    );
    const cards = admin.match(/<StandinControls\b[^>]*>/g) ?? [];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(card).toContain("viewerId={user.id}");
    const controls = admin.slice(admin.indexOf("function StandinControls("));
    expect(controls).toMatch(/<StandinMatchBlock[\s\S]*?viewerId=\{viewerId\}/);
    expect(controls).toContain("teams={data.teams}");
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
