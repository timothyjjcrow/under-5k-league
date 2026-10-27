import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The banner reads the season's teams itself; the matches come from the
// preview's one read.
const database = vi.hoisted(() => ({ team: { findMany: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: database }));

import { StakesBanner } from "./stakes-banner";

type Props = Parameters<typeof StakesBanner>[0];
type Row = Props["seasonMatches"][number];

let seq = 0;
function fixture(home: string, away: string, week: number, extra: Partial<Row> = {}): Row {
  seq += 1;
  return {
    id: `m${seq}`,
    homeTeamId: home,
    awayTeamId: away,
    status: "COMPLETED",
    phase: "REGULAR",
    bestOf: 2,
    week,
    scheduledAt: null,
    homeScore: 0,
    awayScore: 0,
    winnerTeamId: null,
    ...extra,
  };
}
const won = (home: string, away: string, week: number) =>
  fixture(home, away, week, { homeScore: 2, winnerTeamId: home });
const drew = (home: string, away: string, week: number) =>
  fixture(home, away, week, { homeScore: 1, awayScore: 1 });

/**
 * Six teams, two groups of three, four playoff places. a1 has won Group A;
 * every Group B series was drawn (2 points each); a2 v a3 is tonight.
 */
function season() {
  const tonight = fixture("a2", "a3", 3, { status: "SCHEDULED" });
  return {
    tonight,
    matches: [
      won("a1", "a2", 1),
      won("a1", "a3", 2),
      drew("b1", "b2", 1),
      drew("b1", "b3", 2),
      drew("b2", "b3", 3),
      tonight,
    ],
  };
}

function teams(groups: boolean) {
  return ["a1", "a2", "a3", "b1", "b2", "b3"].map((id) => ({
    id,
    name: `Team ${id}`,
    withdrawn: false,
    groupKey: groups ? id[0].toUpperCase() : null,
  }));
}

async function banner(groups: boolean): Promise<string> {
  database.team.findMany.mockResolvedValue(teams(groups));
  const { tonight, matches } = season();
  const card = await StakesBanner({
    match: {
      id: tonight.id,
      seasonId: "season",
      phase: "REGULAR",
      scheduledAt: null,
      homeTeamId: "a2",
      awayTeamId: "a3",
      homeTeam: { name: "Team a2", logoUrl: null },
      awayTeam: { name: "Team a3", logoUrl: null },
      season: { status: "REGULAR_SEASON", formatConfig: null },
    },
    seasonMatches: matches,
    nowMs: Date.parse("2026-10-19T12:00:00Z"),
  });
  expect(card).not.toBeNull();
  return renderToStaticMarkup(card).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("the match page's stakes card", () => {
  beforeEach(() => database.team.findMany.mockReset());

  it("reads each team's group, so a group season races for its own places", async () => {
    await banner(true);
    expect(database.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ groupKey: true }) }),
    );
  });

  it("judges tonight against the group's cut in a group season", async () => {
    // Group A sends two: a draw leaves a2 and a3 level for its second place.
    const text = await banner(true);
    expect(text).toContain("Win to qualify");
    expect(text).toContain("Draw Tiebreaker for a spot");
  });

  it("judges tonight against the league's cut for one table", async () => {
    // Four of six go through: a draw leaves both below Group B's three.
    const text = await banner(false);
    expect(text).toContain("Win to qualify");
    expect(text).toContain("Draw Out");
    expect(text).not.toContain("Tiebreaker for a spot");
  });
});
