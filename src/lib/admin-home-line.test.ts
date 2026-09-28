import { describe, expect, it } from "vitest";
import { adminHomeLine, type AdminHomeInput } from "./admin-home-line";
import { DRAFT_STATUS, MATCH_PHASE, MATCH_STATUS } from "./constants";

type Row = AdminHomeInput["matches"][number];

function match(overrides: Partial<Row> = {}): Row {
  return {
    homeTeamId: "a",
    awayTeamId: "b",
    status: MATCH_STATUS.SCHEDULED,
    homeScore: 0,
    awayScore: 0,
    winnerTeamId: null,
    phase: MATCH_PHASE.REGULAR,
    bracketSlot: null,
    week: 1,
    scheduledAt: new Date("2026-09-20T18:00:00Z"),
    ...overrides,
  };
}

const won = (home: string, away: string): Partial<Row> => ({
  homeTeamId: home,
  awayTeamId: away,
  status: MATCH_STATUS.COMPLETED,
  homeScore: 2,
  awayScore: 0,
  winnerTeamId: home,
});

const teams = ["a", "b", "c", "d"].map((id) => ({ id }));
/** The day after the fixtures' kickoff, so an unplayed one is due. */
const NOW = Date.parse("2026-09-21T00:00:00Z");

function line(overrides: Partial<AdminHomeInput>) {
  return adminHomeLine({
    seasonStatus: "REGULAR_SEASON",
    draftStatus: DRAFT_STATUS.COMPLETE,
    playerCount: 20,
    minPlayers: 20,
    teams,
    matches: [],
    hasChampion: false,
    attentionCount: 0,
    nowMs: NOW,
    ...overrides,
  });
}

describe("adminHomeLine", () => {
  it("says what signups still need", () => {
    expect(
      line({
        seasonStatus: "SIGNUPS",
        draftStatus: null,
        playerCount: 17,
        teams: [],
      }),
    ).toEqual({ step: "Waiting on signups — 3 more to go.", attention: null });
  });

  it("counts outstanding results and the matches needing attention", () => {
    expect(
      line({
        matches: [match(won("a", "b")), match(), match({ homeTeamId: "c" })],
        attentionCount: 1,
      }),
    ).toEqual({
      step: "Season running: 2 results outstanding.",
      attention: "1 match needs attention",
    });
    expect(line({ matches: [match()], attentionCount: 3 }).attention).toBe(
      "3 matches need attention",
    );
  });

  it("names the next kickoff while nothing is due yet", () => {
    // The panel's wording: a fixture next week is still to play, not missing.
    expect(
      line({ matches: [match({ week: 2 })], nowMs: Date.parse("2026-09-14T00:00:00Z") })
        .step,
    ).toMatch(/^Season running\. Week 2 kicks off /);
  });

  it("asks for kickoff times before anything else mid-season", () => {
    expect(line({ matches: [match({ scheduledAt: null })] }).step).toBe(
      "Next step: give every fixture a kickoff time.",
    );
  });

  it("points at the playoffs once the regular season is done", () => {
    // A full round robin with four distinct records.
    const roundRobin = [
      won("a", "b"),
      won("a", "c"),
      won("a", "d"),
      won("b", "c"),
      won("b", "d"),
      won("c", "d"),
    ].map((result) => match(result));
    expect(line({ matches: roundRobin }).step).toBe(
      "Next step: Start playoffs.",
    );
  });

  it("asks for a tiebreaker when a tie still decides the seeding", () => {
    // b and d are both 0-1: a dead heat for the last seeds.
    expect(
      line({
        matches: [match(won("a", "b")), match(won("c", "d")), match(won("a", "c"))],
      }).step,
    ).toBe("Next step: schedule a tiebreaker week.");
  });

  it("follows the bracket and the finished season", () => {
    const final = match({
      phase: MATCH_PHASE.FINAL,
      bracketSlot: "R1M0",
    });
    expect(
      line({ seasonStatus: "PLAYOFFS", matches: [final] }).step,
    ).toBe("Playoffs underway — 1 bracket match(es) left.");
    expect(
      line({
        seasonStatus: "COMPLETE",
        matches: [{ ...final, ...won("a", "b") }],
        hasChampion: true,
      }).step,
    ).toBe("Season complete. Open the next season when you're ready.");
  });
});
