import { describe, expect, it } from "vitest";
import ts from "typescript";
import { sourceFile } from "../../test/support/source-files";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import { announcementDedupeKey } from "./announcement-marker";
import { checkinNudgeAnnouncementGroup } from "./availability";
import { draftLiveAnnouncementGroup } from "./discord";
import {
  bookingLeadTimes,
  buildLeagueHealth,
  checkinSummary,
  dayLabel,
  healthWindow,
  neverDrafted,
  percent,
  postKind,
  postsByKind,
  weekLabel,
  weeklyCounts,
  type LeagueHealthRows,
} from "./league-health";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (iso: string) => new Date(iso);

describe("percent", () => {
  it("rounds to a whole percent and has no answer for an empty whole", () => {
    expect(percent(1, 3)).toBe("33%");
    expect(percent(2, 3)).toBe("67%");
    expect(percent(5, 5)).toBe("100%");
    expect(percent(0, 4)).toBe("0%");
    expect(percent(0, 0)).toBeNull();
  });
});

describe("healthWindow", () => {
  const season = { createdAt: at("2026-06-01T00:00:00Z") };
  const now = at("2026-09-01T00:00:00Z");

  it("runs the newest season's window to now", () => {
    expect(healthWindow(season, null, now)).toEqual({
      start: season.createdAt,
      end: now,
      next: null,
    });
  });

  it("closes an older season's window when the next season was created", () => {
    const next = { name: "Season 10", createdAt: at("2026-08-01T00:00:00Z") };
    expect(healthWindow(season, next, now)).toEqual({
      start: season.createdAt,
      end: next.createdAt,
      next: { name: "Season 10" },
    });
  });

  it("never ends before it starts", () => {
    const window = healthWindow(season, null, at("2026-05-01T00:00:00Z"));
    expect(window.end).toEqual(season.createdAt);
  });
});

describe("weeklyCounts", () => {
  it("counts Monday-to-Sunday weeks on the league's clock across the spring change", () => {
    // Pacific: clocks go forward at 2am on Sunday 8 March 2026.
    const window = {
      start: at("2026-03-02T08:00:00Z"), // Mon 2 Mar, 00:00 PST
      end: at("2026-03-23T07:00:00Z"), // Mon 23 Mar, 00:00 PDT
    };
    const dates = [
      at("2026-03-02T07:59:00Z"), // Sun 1 Mar 23:59 PST: before the window
      at("2026-03-08T09:30:00Z"), // Sun 8 Mar 01:30 PST
      at("2026-03-08T10:30:00Z"), // Sun 8 Mar 03:30 PDT
      at("2026-03-16T06:30:00Z"), // Sun 15 Mar 23:30 PDT (Monday in UTC)
      at("2026-03-16T07:30:00Z"), // Mon 16 Mar 00:30 PDT
      at("2026-03-23T07:00:00Z"), // the window's end, which it excludes
    ];
    expect(weeklyCounts(dates, window, "America/Los_Angeles")).toEqual([
      { weekOf: "2026-03-02", count: 2 },
      { weekOf: "2026-03-09", count: 1 },
      { weekOf: "2026-03-16", count: 1 },
    ]);
    // The same Sunday-night signup on the server's UTC clock lands in the
    // next week: the zone is what keeps it in its own.
    expect(
      weeklyCounts([at("2026-03-16T06:30:00Z")], window, "UTC").find(
        (week) => week.count > 0,
      ),
    ).toEqual({ weekOf: "2026-03-16", count: 1 });
  });

  it("keeps the repeated autumn hour in its own week in Europe", () => {
    // Berlin: clocks go back from 03:00 CEST to 02:00 CET on Sun 25 Oct 2026.
    const window = {
      start: at("2026-10-18T22:00:00Z"), // Mon 19 Oct, 00:00 CEST
      end: at("2026-11-01T23:00:00Z"), // Mon 2 Nov, 00:00 CET
    };
    const dates = [
      at("2026-10-25T00:30:00Z"), // Sun 02:30 CEST
      at("2026-10-25T01:30:00Z"), // Sun 02:30 CET, the hour again
      at("2026-10-25T22:30:00Z"), // Sun 23:30 CET
      at("2026-10-25T23:30:00Z"), // Mon 26 Oct 00:30 CET
    ];
    expect(weeklyCounts(dates, window, "Europe/Berlin")).toEqual([
      { weekOf: "2026-10-19", count: 3 },
      { weekOf: "2026-10-26", count: 1 },
    ]);
  });

  it("lists every week of the window, empty ones included, and nothing for an empty window", () => {
    const window = {
      start: at("2026-09-07T07:00:00Z"),
      end: at("2026-09-28T07:00:00Z"),
    };
    expect(weeklyCounts([], window, "America/Los_Angeles")).toEqual([
      { weekOf: "2026-09-07", count: 0 },
      { weekOf: "2026-09-14", count: 0 },
      { weekOf: "2026-09-21", count: 0 },
    ]);
    expect(
      weeklyCounts([window.start], { start: window.start, end: window.start }, "UTC"),
    ).toEqual([]);
  });
});

describe("week and day labels", () => {
  it("names a week by its Monday and a day on the league's clock", () => {
    expect(weekLabel("2026-09-07", "en-US")).toBe("Sep 7");
    // 05:30 UTC on 7 September is still the 6th in Los Angeles.
    expect(dayLabel(at("2026-09-07T05:30:00Z"), "America/Los_Angeles", "en-US")).toBe(
      "Sep 6, 2026",
    );
    expect(dayLabel(at("2026-09-07T05:30:00Z"), "Europe/Berlin", "en-US")).toBe(
      "Sep 7, 2026",
    );
  });
});

describe("bookingLeadTimes", () => {
  const kickoff = at("2026-09-20T01:00:00Z");
  const matches = [
    { id: "m1", scheduledAt: kickoff, scheduleRevision: 0, forfeit: false },
    { id: "m2", scheduledAt: null, scheduleRevision: 0, forfeit: false },
  ];
  const before = (ms: number) => ({
    matchId: "m1",
    createdAt: new Date(kickoff.getTime() - ms),
  });

  it("buckets each booking by how long before the current kickoff it was made", () => {
    const lead = bookingLeadTimes(
      [
        before(4 * DAY),
        before(3 * DAY), // exactly three days counts as three days
        before(2 * DAY),
        before(DAY),
        before(12 * HOUR),
        before(6 * HOUR),
        before(3 * HOUR),
        before(HOUR),
        before(30 * 60 * 1000),
        before(0),
        before(-5 * 60 * 1000), // booked after kickoff
        { matchId: "m2", createdAt: kickoff },
      ],
      matches,
    );
    expect(lead.map(({ label, count }) => [label, count])).toEqual([
      ["3 days or more before kickoff", 2],
      ["1–3 days before", 2],
      ["6–24 hours before", 2],
      ["1–6 hours before", 2],
      ["Under an hour before", 2],
      ["After kickoff", 1],
      ["Match has no kickoff, so unknown", 1],
    ]);
  });

  it("lists every bucket at zero, and no unknown line when every match has a kickoff", () => {
    const lead = bookingLeadTimes([], matches);
    expect(lead).toHaveLength(6);
    expect(lead.every((row) => row.count === 0)).toBe(true);
    expect(bookingLeadTimes([before(DAY)], matches)).toHaveLength(6);
  });
});

describe("checkinSummary", () => {
  const now = at("2026-09-20T05:00:00Z");
  const matches = [
    // Kicked off; moved once, so only revision 2's answers count.
    { id: "a", scheduledAt: at("2026-09-20T01:00:00Z"), scheduleRevision: 2, forfeit: false },
    // Kicked off but forfeited: no lobby, nothing to check in for.
    { id: "b", scheduledAt: at("2026-09-19T01:00:00Z"), scheduleRevision: 0, forfeit: true },
    // Still to come, and one with no kickoff at all.
    { id: "c", scheduledAt: at("2026-09-27T01:00:00Z"), scheduleRevision: 0, forfeit: false },
    { id: "d", scheduledAt: null, scheduleRevision: 0, forfeit: false },
    // Kicked off exactly now, with two standins booked.
    { id: "e", scheduledAt: now, scheduleRevision: 0, forfeit: false },
  ];
  const checkins = [
    { matchId: "a", scheduleRevision: 2, status: "IN", count: 6 },
    { matchId: "a", scheduleRevision: 2, status: "OUT", count: 2 },
    { matchId: "a", scheduleRevision: 1, status: "IN", count: 3 },
    { matchId: "a", scheduleRevision: 2, status: "MAYBE", count: 4 },
    { matchId: "b", scheduleRevision: 0, status: "IN", count: 5 },
    { matchId: "c", scheduleRevision: 0, status: "IN", count: 9 },
    { matchId: "e", scheduleRevision: 0, status: "IN", count: 13 },
  ];
  const bookings = [{ matchId: "e" }, { matchId: "e" }, { matchId: "c" }];

  it("counts answers at the current kickoff of every series that has kicked off", () => {
    expect(
      checkinSummary({ matches, checkins, bookings, teamSize: 5, now }),
    ).toEqual({
      matches: 2,
      // a: two sides of 5; e: two sides of 5 plus its two standins.
      seats: 10 + 12,
      // a: 6 in + 2 out; e: 13 answers, capped at its 12 seats.
      answered: 8 + 12,
      in: 6 + 13,
      out: 2,
    });
  });

  it("is empty before any series kicks off", () => {
    expect(
      checkinSummary({
        matches,
        checkins,
        bookings,
        teamSize: 5,
        now: at("2026-09-01T00:00:00Z"),
      }),
    ).toEqual({ matches: 0, seats: 0, answered: 0, in: 0, out: 0 });
  });
});

describe("neverDrafted", () => {
  const active = { status: SEASON_STATUS.REGULAR_SEASON, isActive: true };
  const tenure = (
    userId: string,
    extra: Partial<{
      teamId: string | null;
      endReason: string | null;
      acquisitionKind: string;
    }> = {},
  ) => ({
    userId,
    teamId: "t1",
    endReason: null,
    acquisitionKind: "AUCTION",
    ...extra,
  });

  it("waits for the auction, and says so for a season that never had one", () => {
    for (const status of [SEASON_STATUS.SIGNUPS, SEASON_STATUS.DRAFT]) {
      for (const draftStatus of [null, DRAFT_STATUS.NOT_STARTED, DRAFT_STATUS.IN_PROGRESS]) {
        const input = {
          draftStatus,
          activePlayerIds: ["a"],
          tenures: [],
          rosterUserIds: [],
        };
        expect(neverDrafted({ ...input, season: { status, isActive: true } })).toEqual({
          state: "before-draft",
        });
        expect(neverDrafted({ ...input, season: { status, isActive: false } })).toEqual({
          state: "no-draft",
        });
      }
    }
  });

  it("is unknown past the draft with no finished auction on record", () => {
    for (const status of [
      SEASON_STATUS.REGULAR_SEASON,
      SEASON_STATUS.PLAYOFFS,
      SEASON_STATUS.COMPLETE,
    ]) {
      expect(
        neverDrafted({
          season: { status, isActive: false },
          draftStatus: null,
          activePlayerIds: ["a"],
          tenures: [],
          rosterUserIds: [],
        }),
      ).toEqual({ state: "unknown", reason: "no-auction" });
    }
  });

  it("counts active player signups who were never on a team", () => {
    expect(
      neverDrafted({
        season: active,
        draftStatus: DRAFT_STATUS.COMPLETE,
        activePlayerIds: ["captain", "bought", "released", "signed", "undone", "unsold"],
        tenures: [
          tenure("captain", { acquisitionKind: "CAPTAIN_DESIGNATION" }),
          tenure("bought"),
          // Released later: still a season on a team.
          tenure("released", { endReason: "RELEASE" }),
          tenure("signed", { acquisitionKind: "FREE_AGENT" }),
          // The sale was undone: never really on the team.
          tenure("undone", { endReason: "DRAFT_UNDO" }),
          // A dissolved team's tenure keeps no team.
          tenure("unsold", { teamId: null }),
        ],
        rosterUserIds: ["captain", "bought", "signed"],
      }),
    ).toEqual({ state: "counted", count: 2 });
  });

  it("voids the same tenure endings as the profile's Seasons card", () => {
    // profile-seasons.ts owns the list; read it rather than repeat it, so a
    // new void ending there fails here until health counts it the same way.
    const source = sourceFile("src/lib/profile-seasons.ts").text;
    const list = /const VOID_TENURE_ENDS = new Set\(\[([\s\S]*?)\]\)/.exec(source);
    expect(list, "profile-seasons.ts no longer declares VOID_TENURE_ENDS").not.toBeNull();
    const reasons = [...list![1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThanOrEqual(4);
    for (const endReason of reasons) {
      expect(
        neverDrafted({
          season: active,
          draftStatus: DRAFT_STATUS.COMPLETE,
          activePlayerIds: ["p"],
          tenures: [tenure("p", { endReason })],
          rosterUserIds: [],
        }),
        endReason,
      ).toEqual({ state: "counted", count: 1 });
    }
  });

  it("is unknown when the roster history doesn't cover the season", () => {
    const base = {
      season: active,
      draftStatus: DRAFT_STATUS.COMPLETE,
      activePlayerIds: ["a", "b"],
    };
    // Memberships captured from surviving rows, after the fact.
    expect(
      neverDrafted({
        ...base,
        tenures: [tenure("a", { acquisitionKind: "LEGACY_CAPTURE" })],
        rosterUserIds: ["a"],
      }),
    ).toEqual({ state: "unknown", reason: "partial-history" });
    // Someone on a roster with no history at all.
    expect(
      neverDrafted({ ...base, tenures: [tenure("a")], rosterUserIds: ["a", "b"] }),
    ).toEqual({ state: "unknown", reason: "partial-history" });
  });
});

describe("post kinds", () => {
  const claim = {
    key: "marker",
    value: "claim",
    eventId: "11111111-1111-4111-8111-111111111111",
  };

  it("names every kind announcementDedupeKey can write", () => {
    // Read the kinds from the function's own signature, then build a real
    // key for each: a new kind there fails here until health names it.
    const source = sourceFile("src/lib/announcement-marker.ts").text;
    const signature = /export function announcementDedupeKey\(\s*kind:([\s\S]*?),\s*claim/.exec(
      source,
    );
    expect(signature, "announcementDedupeKey's signature moved").not.toBeNull();
    const kinds = [...signature![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThanOrEqual(7);
    for (const kind of kinds) {
      expect(
        postKind(announcementDedupeKey(kind as Parameters<typeof announcementDedupeKey>[0], claim)),
      ).toBe(kind);
    }
  });

  it("names the two expiry groups, and calls one-off and unknown posts other", () => {
    expect(postKind(`${checkinNudgeAnnouncementGroup("match-1")}abc`)).toBe("checkin-nudge");
    expect(postKind(`${draftLiveAnnouncementGroup("season-1")}abc`)).toBe("draft-live");
    expect(postKind(null)).toBe("other");
    expect(postKind("")).toBe("other");
    expect(postKind("mystery:123")).toBe("other");
  });

  it("counts sent posts by kind in a fixed order, leaving out kinds with none", () => {
    expect(
      postsByKind([
        null,
        "series:a:1",
        "reminder:b:2",
        "series:c:3",
        "checkin-nudge:m:x",
        "mystery:1",
      ]).map(({ key, count }) => [key, count]),
    ).toEqual([
      ["series", 2],
      ["reminder", 1],
      ["checkin-nudge", 1],
      ["other", 2],
    ]);
    expect(postsByKind([])).toEqual([]);
  });
});

function rows(overrides: Partial<LeagueHealthRows> = {}): LeagueHealthRows {
  return {
    season: {
      id: "s1",
      status: SEASON_STATUS.SIGNUPS,
      isActive: true,
      teamSize: 5,
      minTeams: 4,
      createdAt: at("2026-09-07T07:00:00Z"),
    },
    nextSeason: null,
    now: at("2026-09-21T07:00:00Z"),
    registrations: [],
    teams: [],
    draftStatus: null,
    activePlayerIds: [],
    returningPlayers: 0,
    tenures: [],
    rosterUserIds: [],
    rosteredWithDiscord: 0,
    accountsCreatedAt: [],
    matches: [],
    checkins: [],
    bookings: [],
    postKeys: [],
    ...overrides,
  };
}

describe("buildLeagueHealth", () => {
  const zone = "America/Los_Angeles";

  it("reads a fresh season with no signups, no draft and no matches", () => {
    const health = buildLeagueHealth(rows(), zone);
    expect(health.signups).toEqual({
      players: { active: 0, withdrawn: 0, removed: 0 },
      standins: { active: 0, withdrawn: 0, removed: 0 },
      teams: 0,
      withdrawnTeams: 0,
      seats: 0,
      targetTeams: 4,
      targetSeats: 20,
      neverDrafted: { state: "before-draft" },
      returning: 0,
    });
    expect(health.checkins).toEqual({ matches: 0, seats: 0, answered: 0, in: 0, out: 0 });
    expect(health.bookings.total).toBe(0);
    expect(health.discord).toEqual({ rostered: 0, linked: 0, posts: [], postsTotal: 0 });
    expect(health.accounts).toEqual({
      total: 0,
      weeks: [
        { weekOf: "2026-09-07", count: 0 },
        { weekOf: "2026-09-14", count: 0 },
      ],
      earlier: null,
    });
  });

  it("counts a season from its rows", () => {
    const health = buildLeagueHealth(
      rows({
        season: {
          id: "s1",
          status: SEASON_STATUS.REGULAR_SEASON,
          isActive: false,
          teamSize: 2,
          minTeams: 2,
          createdAt: at("2026-09-07T07:00:00Z"),
        },
        nextSeason: { name: "Season 10", createdAt: at("2026-09-14T07:00:00Z") },
        registrations: [
          { type: "PLAYER", status: "ACTIVE", count: 5 },
          { type: "PLAYER", status: "WITHDRAWN", count: 2 },
          { type: "PLAYER", status: "REMOVED", count: 1 },
          { type: "STANDIN", status: "ACTIVE", count: 3 },
          { type: "STANDIN", status: "WITHDRAWN", count: 1 },
        ],
        teams: [
          { withdrawn: false, count: 2 },
          { withdrawn: true, count: 1 },
        ],
        draftStatus: DRAFT_STATUS.COMPLETE,
        activePlayerIds: ["a", "b", "c", "d", "e"],
        returningPlayers: 3,
        tenures: ["a", "b", "c", "d"].map((userId) => ({
          userId,
          teamId: "t",
          endReason: null,
          acquisitionKind: "AUCTION",
        })),
        rosterUserIds: ["a", "b", "c", "d"],
        rosteredWithDiscord: 3,
        accountsCreatedAt: [
          at("2026-09-08T00:00:00Z"),
          at("2026-09-13T00:00:00Z"),
          // After the next season was created: that season's account.
          at("2026-09-15T00:00:00Z"),
        ],
        postKeys: ["series:x:1", null],
      }),
      zone,
    );
    expect(health.window.next).toEqual({ name: "Season 10" });
    expect(health.signups).toMatchObject({
      players: { active: 5, withdrawn: 2, removed: 1 },
      standins: { active: 3, withdrawn: 1, removed: 0 },
      teams: 3,
      withdrawnTeams: 1,
      seats: 6,
      targetSeats: 4,
      neverDrafted: { state: "counted", count: 1 },
      returning: 3,
    });
    expect(health.discord).toMatchObject({ rostered: 4, linked: 3, postsTotal: 2 });
    expect(health.accounts).toEqual({
      total: 2,
      weeks: [{ weekOf: "2026-09-07", count: 2 }],
      earlier: null,
    });
  });

  it("shows the latest 26 weeks and folds the rest into one line", () => {
    const start = at("2026-01-05T08:00:00Z"); // Mon 5 Jan, 00:00 PST
    const health = buildLeagueHealth(
      rows({
        season: { ...rows().season, createdAt: start },
        now: new Date(start.getTime() + 30 * 7 * DAY - HOUR),
        accountsCreatedAt: [
          new Date(start.getTime() + DAY), // week 1, folded
          new Date(start.getTime() + 8 * DAY), // week 2, folded
          new Date(start.getTime() + 29 * 7 * DAY + DAY), // week 30
        ],
      }),
      zone,
    );
    expect(health.accounts.weeks).toHaveLength(26);
    expect(health.accounts.earlier).toEqual({ weeks: 4, count: 2 });
    expect(health.accounts.total).toBe(3);
    expect(health.accounts.weeks.at(-1)).toMatchObject({ count: 1 });
  });
});

/** Every module the file imports. */
function importsOf(text: string, file: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return source.statements
    .filter(ts.isImportDeclaration)
    .map((node) => (node.moduleSpecifier as ts.StringLiteral).text);
}

describe("the /admin/health page", () => {
  const page = sourceFile("src/app/admin/health/page.tsx").text;
  const service = sourceFile("src/lib/league-health-service.ts").text;

  it("lets only admins in, and reads one season id or none", () => {
    const signIn = page.indexOf('redirect("/login?next=/admin/health")');
    const admin = page.indexOf('if (user.role !== "ADMIN") notFound();');
    const param = page.indexOf("singleSearchParam((await searchParams).season)");
    const repeated = page.indexOf("if (seasonParam === null) notFound();");
    const resolve = page.indexOf("resolveSeasonScope(seasonParam)");
    const load = page.indexOf("loadLeagueHealth(season)");
    for (const step of [signIn, admin, param, repeated, resolve, load]) {
      expect(step).toBeGreaterThan(0);
    }
    // Who may see it is settled before anything about the league is read.
    expect(signIn).toBeLessThan(admin);
    expect(admin).toBeLessThan(param);
    expect(param).toBeLessThan(repeated);
    expect(repeated).toBeLessThan(resolve);
    expect(resolve).toBeLessThan(load);
  });

  it("renders on the server from the health service alone", () => {
    expect(page).not.toMatch(/^["']use client["']/m);
    // No direct database, cache, Discord or OpenDota access: every figure
    // comes through loadLeagueHealth.
    expect(importsOf(page, "page.tsx").sort()).toEqual(
      [
        "@/components/season-scope",
        "@/components/ui",
        "@/lib/auth",
        "@/lib/league-config",
        "@/lib/league-health",
        "@/lib/league-health-service",
        "@/lib/search-params",
        "@/lib/season-scope",
        "@/lib/zoned-time",
        "next/link",
        "next/navigation",
        "react",
      ].sort(),
    );
    // One h1 per render: the PageTitle of the no-seasons screen and the one
    // of the season's figures, and no other.
    expect(page.match(/<h1|<PageTitle/g)).toHaveLength(2);
  });

  it("is linked from the admin page, beside the imported-game check", () => {
    const admin = sourceFile("src/app/admin/page.tsx").text;
    const quality = admin.indexOf("Check imported-game quality <LinkArrow />");
    const health = admin.indexOf("href={`/admin/health?season=${season.id}`}");
    expect(quality).toBeGreaterThan(0);
    expect(health).toBeGreaterThan(quality);
    // In the same paragraph: no closing </p> between the two.
    expect(admin.slice(quality, health)).not.toContain("</p>");
    expect(admin.slice(health, health + 200)).toContain("League health <LinkArrow />");
  });

  it("reads counts, ids and timestamps, never a name or a message", () => {
    expect(importsOf(service, "league-health-service.ts").sort()).toEqual(
      [
        "./constants",
        "./league-announcement-outbox",
        "./league-config",
        "./league-health",
        "./prisma",
      ].sort(),
    );
    expect(service).not.toMatch(/include:/);
    expect(service).not.toMatch(/content: true|discordName|discordId: true|steamId/);
    // The one name it reads is each season's, for the picker.
    expect(service.match(/name: true/g)).toHaveLength(1);
    expect(service).toMatch(
      /prisma\.season\.findMany\(\{[\s\S]*?select: \{ id: true, name: true, isActive: true, createdAt: true \}/,
    );
  });
});
