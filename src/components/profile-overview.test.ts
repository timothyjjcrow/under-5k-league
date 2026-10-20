import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The inhouse card's module reads the database; these profiles never show it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { summarizePlayerGames } from "@/lib/player-stats";
import { ProfileOverview } from "./profile-overview";

type Team = NonNullable<Parameters<typeof ProfileOverview>[0]["team"]>;

const none = summarizePlayerGames([]);

/** The overview's text for a drafted player whose team has played. */
function overview(team: Team): string {
  return renderToStaticMarkup(
    createElement(ProfileOverview, {
      hasLeagueGames: true,
      hasSeasonGames: true,
      seasonName: "Season 3",
      seasonSummary: none,
      careerSummary: none,
      streakLabel: undefined,
      team,
      featured: null,
      inhouseUserId: null,
    }),
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

const row = { wins: 2, draws: 0, losses: 1, points: 6 };

describe("the profile's team rank tile", () => {
  it("names the group in a group season, so #2 is the group's place", () => {
    const text = overview({ rank: 2, groupKey: "A", row, playoffTile: null });
    expect(text).toContain("Group A rank #2 2W 0D 1L · 6 pts");
    expect(text).not.toContain("Team rank");
  });

  it("keeps one table's tile as it was", () => {
    const text = overview({ rank: 2, groupKey: null, row, playoffTile: null });
    expect(text).toContain("Team rank #2 2W 0D 1L · 6 pts");
    expect(text).not.toContain("Group");
  });
});
