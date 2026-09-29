import { describe, expect, it } from "vitest";
import { myMatchPanel, type PanelBooking, type PanelMatch } from "./my-match-panel";
import { AUTO_SYNC } from "./constants";

const now = Date.parse("2026-09-28T18:00:00Z");
const hour = 3600_000;

let seq = 0;
function match(over: Partial<PanelMatch> & { id: string }): PanelMatch {
  seq += 1;
  return {
    status: "SCHEDULED",
    phase: "REGULAR",
    week: 1,
    homeTeamId: "A",
    awayTeamId: "B",
    scheduledAt: new Date(now + 24 * hour),
    createdAt: new Date(seq),
    winnerTeamId: null,
    ...over,
  };
}

function panel(
  over: Partial<Parameters<typeof myMatchPanel>[0]> & {
    matches: PanelMatch[];
  },
) {
  return myMatchPanel<PanelMatch, PanelBooking>({
    userId: "me",
    seasonStatus: "REGULAR_SEASON",
    rosterTeamIds: ["A"],
    withdrawnTeamIds: new Set(),
    standin: false,
    championTeamId: null,
    bookings: [],
    nowMs: now,
    ...over,
  });
}

describe("myMatchPanel: the check-in", () => {
  it("prompts for the team's earliest timed fixture, by kickoff not week", () => {
    const later = match({ id: "w2", week: 2, scheduledAt: new Date(now + 5 * hour) });
    const moved = match({ id: "w3", week: 3, scheduledAt: new Date(now + 2 * hour) });
    expect(panel({ matches: [later, moved] }).next?.id).toBe("w3");
  });

  it("never prompts for a live, untimed or stale fixture", () => {
    const result = panel({
      matches: [
        match({ id: "live", status: "LIVE" }),
        match({ id: "untimed", scheduledAt: null }),
        match({
          id: "stale",
          scheduledAt: new Date(now - (AUTO_SYNC.WINDOW_HOURS + 1) * hour),
        }),
      ],
    });
    expect(result.next).toBeNull();
    expect(result.live?.match.id).toBe("live");
    expect(result.live?.teamId).toBe("A");
  });

  it("prompts a booked standin for the match they cover, on the booking's side", () => {
    const booked = match({ id: "m", homeTeamId: "C", awayTeamId: "D" });
    const result = panel({
      rosterTeamIds: [],
      standin: true,
      matches: [booked],
      bookings: [{ matchId: "m", teamId: "D", standinUserId: "me", replacingUserId: "x" }],
    });
    expect(result.next?.id).toBe("m");
    const live = panel({
      rosterTeamIds: [],
      standin: true,
      matches: [{ ...booked, status: "LIVE" }],
      bookings: [{ matchId: "m", teamId: "D", standinUserId: "me", replacingUserId: "x" }],
    });
    expect(live.live).toMatchObject({ teamId: "D" });
    expect(live.next).toBeNull();
  });
});

describe("myMatchPanel: covered seats", () => {
  const cover: PanelBooking = {
    matchId: "tonight",
    teamId: "A",
    standinUserId: "sub",
    replacingUserId: "me",
  };

  it("names the covered fixture and prompts for the one after it", () => {
    const tonight = match({ id: "tonight", scheduledAt: new Date(now + hour) });
    const nextWeek = match({ id: "next", week: 2, scheduledAt: new Date(now + 7 * 24 * hour) });
    const result = panel({ matches: [tonight, nextWeek], bookings: [cover] });
    expect(result.covered?.match.id).toBe("tonight");
    expect(result.covered?.booking.standinUserId).toBe("sub");
    expect(result.next?.id).toBe("next");
  });

  it("drops a covered fixture that comes after the check-in", () => {
    const first = match({ id: "first", scheduledAt: new Date(now + hour) });
    const tonight = match({ id: "tonight", week: 2, scheduledAt: new Date(now + 7 * 24 * hour) });
    const result = panel({ matches: [first, tonight], bookings: [cover] });
    expect(result.next?.id).toBe("first");
    expect(result.covered).toBeNull();
  });

  it("does not call a covered live series the viewer's own", () => {
    const tonight = match({ id: "tonight", status: "LIVE" });
    const result = panel({ matches: [tonight], bookings: [cover] });
    expect(result.live).toBeNull();
    expect(result.covered?.match.id).toBe("tonight");
  });

  it("ignores a booking covering someone else on the same team", () => {
    const tonight = match({ id: "tonight" });
    const result = panel({
      matches: [tonight],
      bookings: [{ ...cover, replacingUserId: "teammate" }],
    });
    expect(result.covered).toBeNull();
    expect(result.next?.id).toBe("tonight");
  });
});

describe("myMatchPanel: when there is nothing to check in for", () => {
  it("separates standins, players without a team and withdrawn teams", () => {
    expect(panel({ rosterTeamIds: [], standin: true, matches: [] }).idle).toBe(
      "standin-list",
    );
    expect(panel({ rosterTeamIds: [], matches: [] }).idle).toBe("no-team");
    const gone = panel({
      withdrawnTeamIds: new Set(["A"]),
      matches: [match({ id: "m", status: "COMPLETED", winnerTeamId: "B" })],
    });
    expect(gone.idle).toBe("withdrawn");
    expect(gone.teamId).toBeNull();
  });

  it("says fixtures are coming before the team has any", () => {
    const result = panel({
      matches: [match({ id: "other", homeTeamId: "C", awayTeamId: "D" })],
    });
    expect(result.idle).toBe("no-fixtures");
    expect(result.teamId).toBe("A");
  });

  it("knows a team that has played every regular-season fixture", () => {
    expect(
      panel({
        matches: [match({ id: "m", status: "COMPLETED", winnerTeamId: "A" })],
      }).idle,
    ).toBe("games-played");
    expect(
      panel({ matches: [match({ id: "m", scheduledAt: null })] }).idle,
    ).toBe("no-upcoming");
  });

  describe("in the playoffs", () => {
    const regular = match({ id: "r", status: "COMPLETED", winnerTeamId: "A" });
    const playoffs = (
      matches: PanelMatch[],
      championTeamId: string | null = null,
    ) =>
      panel({
        seasonStatus: "PLAYOFFS",
        championTeamId,
        matches: [regular, ...matches],
      }).idle;

    it("waits for the bracket to be drawn", () => {
      expect(playoffs([])).toBe("bracket-pending");
    });

    it("says the season is over for a team that missed or lost", () => {
      expect(
        playoffs([match({ id: "sf", phase: "PLAYOFF", homeTeamId: "C", awayTeamId: "D" })]),
      ).toBe("season-over");
      expect(
        playoffs([
          match({ id: "sf", phase: "PLAYOFF", status: "COMPLETED", winnerTeamId: "B" }),
        ]),
      ).toBe("season-over");
    });

    it("tells a winner their next round isn't drawn yet", () => {
      expect(
        playoffs([
          match({ id: "sf", phase: "PLAYOFF", status: "COMPLETED", winnerTeamId: "A" }),
        ]),
      ).toBe("through");
      expect(
        playoffs([
          match({ id: "sf", phase: "PLAYOFF", status: "COMPLETED", winnerTeamId: "A" }),
          match({ id: "f", phase: "FINAL", homeTeamId: "A", awayTeamId: "C", scheduledAt: null }),
        ]),
      ).toBe("no-upcoming");
    });

    const final = (winnerTeamId: string) => [
      match({ id: "sf", phase: "PLAYOFF", status: "COMPLETED", winnerTeamId: "A" }),
      match({ id: "f", phase: "FINAL", status: "COMPLETED", winnerTeamId }),
    ];

    it("crowns the final's winner only once the title is confirmed", () => {
      expect(playoffs(final("A"), "A")).toBe("champion");
    });

    it("holds the title while a finished final is unconfirmed", () => {
      // The final's winner alone is not the champion: every other surface
      // withholds the title until the league confirms it.
      expect(playoffs(final("A"))).toBe("final-review");
      // The losing finalist isn't told the playoffs go on without them.
      expect(playoffs(final("B"))).toBe("final-review");
    });

    it("says the season is over for a finalist who lost a confirmed final", () => {
      expect(playoffs(final("B"), "B")).toBe("season-over");
    });
  });
});
