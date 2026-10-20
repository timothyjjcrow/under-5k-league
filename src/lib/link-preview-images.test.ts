import { beforeEach, describe, expect, it, vi } from "vitest";

// The team picture's place and seed facts over stand-in rows. The full reads
// run against SQLite in test/integration/link-preview-images.itest.ts.
const database = vi.hoisted(() => ({
  team: { findUnique: vi.fn(), findMany: vi.fn() },
  match: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: database }));
// The match and player pictures' reads; the team picture uses neither.
vi.mock("@/lib/link-preview-metadata", () => ({
  loadMatchPreviewFacts: vi.fn(),
  loadPlayerCardFacts: vi.fn(),
}));

import { loadTeamCard } from "./link-preview-images";

const SEASON = "season";
const IDS = ["a1", "a2", "b1", "b2"];

/** Two groups of two, or the same four teams as one table. */
function teams(groups: boolean) {
  return IDS.map((id, index) => ({
    id,
    seasonId: SEASON,
    withdrawn: false,
    groupKey: groups ? id[0].toUpperCase() : null,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
  }));
}

let seq = 0;
function fixture(home: string, away: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `m${seq}`,
    seasonId: SEASON,
    week: 1,
    phase: "REGULAR",
    status: "COMPLETED",
    bracketSlot: null,
    bestOf: 3,
    homeTeamId: home,
    awayTeamId: away,
    homeScore: 2,
    awayScore: 0,
    winnerTeamId: home,
    forfeit: false,
    scheduledAt: null,
    ...extra,
  };
}

/** One result per group: b1 tops Group B, the third of the league's rows. */
const results = () => [fixture("a1", "a2"), fixture("b1", "b2")];
/** The semifinals: a1 A1 (seed 1) v b2 B2 (4), b1 B1 (2) v a2 A2 (3). */
const semis = () => [
  fixture("a1", "b2", { week: 3, phase: "PLAYOFF", bracketSlot: "R0M0", status: "SCHEDULED", homeScore: 0, winnerTeamId: null }),
  fixture("b1", "a2", { week: 3, phase: "PLAYOFF", bracketSlot: "R0M1", status: "SCHEDULED", homeScore: 0, winnerTeamId: null }),
];

function season(groups: boolean, status: string, matches: ReturnType<typeof fixture>[]) {
  database.team.findUnique.mockResolvedValue({
    id: "b1",
    name: "Team b1",
    logoUrl: null,
    withdrawn: false,
    seasonId: SEASON,
    captainId: "captain",
    captain: { name: "Captain" },
    season: { name: "Season 3", status, championTeamId: null },
    members: [],
  });
  database.team.findMany.mockResolvedValue(teams(groups));
  database.match.findMany.mockResolvedValue(matches);
}

describe("the team picture's place and seed", () => {
  beforeEach(() => {
    database.team.findUnique.mockReset();
    database.team.findMany.mockReset();
    database.match.findMany.mockReset();
  });

  it("reads each team's group with the season's teams", async () => {
    season(true, "REGULAR_SEASON", results());
    await loadTeamCard("b1", Date.now());
    expect(database.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ groupKey: true }) }),
    );
  });

  it("names the place within the group in a group season", async () => {
    season(true, "REGULAR_SEASON", results());
    expect((await loadTeamCard("b1", Date.now()))?.facts).toEqual([
      "1W 0D 0L",
      "1st of 2 in Group B",
    ]);
  });

  it("names the place in the league table for one table", async () => {
    season(false, "REGULAR_SEASON", results());
    // Level with a1 on everything, b1 sorts second by team id.
    expect((await loadTeamCard("b1", Date.now()))?.facts).toEqual([
      "1W 0D 0L",
      "2nd of 4",
    ]);
  });

  it("names the seed as the bracket does", async () => {
    season(true, "PLAYOFFS", [...results(), ...semis()]);
    expect((await loadTeamCard("b1", Date.now()))?.facts).toContain("Seed B1");
    season(false, "PLAYOFFS", [...results(), ...semis()]);
    expect((await loadTeamCard("b1", Date.now()))?.facts).toContain("Seed 2");
  });
});
