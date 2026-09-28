import { afterEach, describe, expect, it, vi } from "vitest";
import {
  homePreview,
  matchPreview,
  seasonPagePreview,
  siteDescription,
  type HomePreviewSeason,
  type MatchPreviewInput,
} from "./link-preview";

const NOW = Date.parse("2026-09-27T12:00:00Z");
// Thursday 1 October, 7 PM on the US league's (Pacific) clock.
const DRAFT_AT = new Date("2026-10-02T02:00:00Z");
const DRAFT_TEXT = "Thu, Oct 1, 7:00 PM Pacific time";

function season(overrides: Partial<HomePreviewSeason> = {}): HomePreviewSeason {
  return {
    name: "Season 7",
    status: "SIGNUPS",
    draftStatus: null,
    playerCount: 37,
    draftAt: DRAFT_AT,
    matchSchedule: null,
    championName: null,
    ...overrides,
  };
}

describe("siteDescription", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("names the hard MMR ceiling and the game servers, not a soft 4.5K", () => {
    const text = siteDescription();
    expect(text).toBe(
      "GGD2L is an amateur Dota 2 league for players up to 5,000 MMR, played on US East servers. Sign in with Steam, join the season, get drafted and compete.",
    );
    expect(text).not.toContain("4.5K");
  });

  it("uses Europe's name and servers on the Europe site", async () => {
    vi.stubEnv("NEXT_PUBLIC_LEAGUE_REGION", "eu");
    vi.stubEnv("NEXT_PUBLIC_APP_NAME", "");
    vi.resetModules();
    const europe = await import("./link-preview");
    expect(europe.siteDescription()).toMatch(
      /^GGD2L Europe is an amateur Dota 2 league for players up to 5,000 MMR, played on Europe West servers\./,
    );
  });
});

describe("homePreview", () => {
  it("falls back to the league and the site description between seasons", () => {
    expect(homePreview(null, NOW)).toEqual({
      title: "GGD2L",
      description: siteDescription(),
    });
  });

  it("gives the signup count, the draft date and how to join during signups", () => {
    expect(homePreview(season(), NOW)).toEqual({
      title: "Season 7 · Signups open",
      description: `37 players signed up · Draft ${DRAFT_TEXT}. Players up to 5,000 MMR can join. Sign in with Steam to sign up.`,
    });
  });

  it("doesn't count zero players or print a draft date that has passed", () => {
    expect(
      homePreview(season({ playerCount: 0, draftAt: new Date(NOW - 1) }), NOW)
        .description,
    ).toBe(
      "Signups just opened. Players up to 5,000 MMR can join. Sign in with Steam to sign up.",
    );
    expect(homePreview(season({ playerCount: 1, draftAt: null }), NOW).description)
      .toMatch(/^1 player signed up\. /);
  });

  it("follows the auction inside the draft phase", () => {
    const draft = (draftStatus: string | null, draftAt: Date | null = DRAFT_AT) =>
      homePreview(season({ status: "DRAFT", draftStatus, draftAt }), NOW);
    expect(draft("NOT_STARTED")).toEqual({
      title: "Season 7 · Draft setup",
      description: `Draft night: ${DRAFT_TEXT}. Captains bid for players in a live auction.`,
    });
    expect(draft(null, null).description).toBe(
      "Captains bid for players in a live auction on draft night.",
    );
    expect(draft("IN_PROGRESS")).toEqual({
      title: "Season 7 · Draft live",
      description: "The draft is live: captains are bidding for players now.",
    });
    expect(draft("PAUSED")).toEqual({
      title: "Season 7 · Draft paused",
      description: "The draft is paused for now.",
    });
    expect(draft("COMPLETE").description).toBe(
      "The teams are set. The regular season starts soon.",
    );
  });

  it("names the admin-set match night during the regular season", () => {
    expect(homePreview(season({ status: "REGULAR_SEASON" }), NOW)).toEqual({
      title: "Season 7 · Regular season",
      description:
        "Standings, fixtures and results. Match night: Sundays at 6:00 PM Pacific time.",
    });
    expect(
      homePreview(
        season({ status: "REGULAR_SEASON", matchSchedule: " Wednesdays, 8pm ET. " }),
        NOW,
      ).description,
    ).toBe("Standings, fixtures and results. Match night: Wednesdays, 8pm ET.");
  });

  it("keeps the champion in the preview once the season is complete", () => {
    expect(
      homePreview(season({ status: "COMPLETE", championName: "Dire Straits" }), NOW),
    ).toEqual({
      title: "Season 7 · Complete",
      description:
        "Dire Straits won Season 7. Final standings, the bracket and every result.",
    });
    expect(homePreview(season({ status: "COMPLETE" }), NOW).description).toBe(
      "Final standings and every result.",
    );
    expect(homePreview(season({ status: "PLAYOFFS" }), NOW).title).toBe(
      "Season 7 · Playoffs",
    );
  });
});

describe("seasonPagePreview", () => {
  const active = { name: "Season 7", status: "REGULAR_SEASON", draftAt: null };

  it("names the page and the season", () => {
    expect(seasonPagePreview("schedule", active, NOW)).toEqual({
      title: "Schedule",
      description:
        "Season 7 fixtures, kickoff times, results and standings in GGD2L.",
    });
    expect(seasonPagePreview("teams", active, NOW)).toEqual({
      title: "Teams",
      description: "Season 7 teams, rosters and results in GGD2L.",
    });
    expect(seasonPagePreview("players", active, NOW)).toEqual({
      title: "Players",
      description: "Every Season 7 signup, standin and roster in GGD2L.",
    });
  });

  it("still says what the page holds between seasons", () => {
    expect(seasonPagePreview("schedule", null, NOW).description).toBe(
      "Fixtures, results and standings in GGD2L.",
    );
    expect(seasonPagePreview("draft", null, NOW)).toEqual({
      title: "Draft",
      description: "The draft: captains bid for players in a live auction.",
    });
  });

  it("gives the draft date on the draft page until draft night", () => {
    expect(
      seasonPagePreview(
        "draft",
        { name: "Season 7", status: "SIGNUPS", draftAt: DRAFT_AT },
        NOW,
      ).description,
    ).toBe(
      `The Season 7 draft: captains bid for players in a live auction. Draft night: ${DRAFT_TEXT}.`,
    );
    expect(
      seasonPagePreview("draft", { ...active, draftAt: DRAFT_AT }, NOW).description,
    ).not.toContain("Draft night");
  });
});

describe("matchPreview", () => {
  function match(overrides: Partial<MatchPreviewInput> = {}): MatchPreviewInput {
    return {
      round: "Semifinal",
      seasonName: "Season 7",
      homeTeamId: "home",
      awayTeamId: "away",
      homeName: "Dire Straits",
      awayName: "Roshan's Revenge",
      status: "SCHEDULED",
      homeScore: 0,
      awayScore: 0,
      winnerTeamId: null,
      forfeit: false,
      // Saturday 3 October, 6 PM Pacific.
      scheduledAt: new Date("2026-10-04T01:00:00Z"),
      bestOf: 3,
      ...overrides,
    };
  }

  it("gives the round, the teams, the kickoff and the series length before it starts", () => {
    expect(matchPreview(match())).toEqual({
      title: "Semifinal · Dire Straits vs Roshan's Revenge",
      description: "Season 7 · Sat, Oct 3, 6:00 PM Pacific time · Best of 3",
    });
    expect(matchPreview(match({ scheduledAt: null })).description).toBe(
      "Season 7 · Kickoff time to be set · Best of 3",
    );
  });

  it("gives the live score once games are in", () => {
    expect(
      matchPreview(match({ status: "LIVE", homeScore: 1 })).description,
    ).toBe("Season 7 · Live · 1–0 · Best of 3");
    // A game imported before the status catches up is still live.
    expect(matchPreview(match({ awayScore: 1 })).description).toBe(
      "Season 7 · Live · 0–1 · Best of 3",
    );
  });

  it("names the winner with the higher score first", () => {
    expect(
      matchPreview(
        match({
          status: "COMPLETED",
          homeScore: 1,
          awayScore: 2,
          winnerTeamId: "away",
        }),
      ).description,
    ).toBe("Season 7 · Roshan's Revenge won 2–1");
    expect(
      matchPreview(match({ status: "COMPLETED", homeScore: 2, awayScore: 0 }))
        .description,
    ).toBe("Season 7 · Dire Straits won 2–0");
  });

  it("reports draws and ruled results as such", () => {
    expect(
      matchPreview(
        match({ round: "Week 3", status: "COMPLETED", homeScore: 1, awayScore: 1, bestOf: 2 }),
      ),
    ).toEqual({
      title: "Week 3 · Dire Straits vs Roshan's Revenge",
      description: "Season 7 · Drawn 1–1",
    });
    expect(
      matchPreview(
        match({ status: "COMPLETED", homeScore: 2, winnerTeamId: "home", forfeit: true }),
      ).description,
    ).toBe("Season 7 · Dire Straits won 2–0 (ruled result)");
  });
});
