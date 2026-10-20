import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MatchPageMatch } from "./load";

// The card's own read is the two teams' box scores; these seasons have none,
// so the record and games rows are the card.
const database = vi.hoisted(() => ({
  game: { findMany: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/lib/prisma", () => ({ prisma: database }));

import { TaleOfTheTape } from "./tale-of-the-tape";

type Props = Parameters<typeof TaleOfTheTape>[0];
type Fixture = Props["seasonMatches"][number];

const team = (id: string, groupKey: string | null): Props["teams"][number] => ({
  id,
  name: `Team ${id}`,
  logoUrl: null,
  withdrawn: false,
  groupKey,
});
/** Two groups of two, or the same four teams as one table. */
const grouped = [team("a1", "A"), team("a2", "A"), team("b1", "B"), team("b2", "B")];
const oneTable = grouped.map((t) => ({ ...t, groupKey: null }));

let seq = 0;
function fixture(home: string, away: string, extra: Partial<Fixture> = {}): Fixture {
  seq += 1;
  return {
    id: `m${seq}`,
    week: 1,
    phase: "REGULAR",
    status: "SCHEDULED",
    bracketSlot: null,
    bestOf: 3,
    homeTeamId: home,
    awayTeamId: away,
    homeScore: 0,
    awayScore: 0,
    winnerTeamId: null,
    ...extra,
  };
}
const won = (home: string, away: string) =>
  fixture(home, away, { status: "COMPLETED", homeScore: 2, winnerTeamId: home });

/** The card's text for `match`, tags stripped. */
async function tape(
  teams: Props["teams"],
  seasonMatches: Fixture[],
  match: Fixture,
): Promise<string> {
  const card = await TaleOfTheTape({
    match: {
      ...match,
      seasonId: "season",
      homeTeam: { name: `Team ${match.homeTeamId}`, logoUrl: null },
      awayTeam: { name: `Team ${match.awayTeamId}`, logoUrl: null },
    } as unknown as MatchPageMatch,
    roundLabel: match.phase === "REGULAR" ? `Week ${match.week}` : "Semifinal",
    seasonMatches,
    teams,
    mmrs: { home: [], away: [] },
  });
  expect(card).not.toBeNull();
  return renderToStaticMarkup(card).replace(/<[^>]+>/g, " ");
}

describe("the tale of the tape's place under each record", () => {
  // One result per group: b1 tops Group B but is the third of the league's
  // four rows (group A's table comes first).
  const results = () => [won("a1", "a2"), won("b1", "b2")];

  it("is the place within the team's group in a group season", async () => {
    const played = results();
    const rematch = fixture("b1", "b2", { week: 2 });
    const text = await tape(grouped, [...played, rematch], rematch);
    expect(text).toContain("1st of 2 in Group B");
    expect(text).toContain("2nd of 2 in Group B");
    expect(text).not.toContain("of 4");
  });

  it("is the place in the league table for one table", async () => {
    const played = results();
    const rematch = fixture("b1", "b2", { week: 2 });
    const text = await tape(oneTable, [...played, rematch], rematch);
    // Level with a1 on everything, b1 sorts second by team id.
    expect(text).toContain("2nd of 4");
    expect(text).toContain("4th of 4");
    expect(text).not.toContain("Group");
  });

  it("names a knockout's seeds as the bracket does", async () => {
    // Seeds alternate the groups: a1 A1 (1), b1 B1 (2), a2 A2 (3), b2 B2 (4).
    const semi = fixture("a1", "b2", { week: 4, phase: "PLAYOFF", bracketSlot: "R0M0" });
    const other = fixture("b1", "a2", { week: 4, phase: "PLAYOFF", bracketSlot: "R0M1" });
    const season = [...results(), semi, other];
    const groups = await tape(grouped, season, semi);
    expect(groups).toContain("Seed A1");
    expect(groups).toContain("Seed B2");
    const table = await tape(oneTable, season, semi);
    expect(table).toContain("Seed 1");
    expect(table).toContain("Seed 4");
  });
});
