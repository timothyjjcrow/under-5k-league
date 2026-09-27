import { describe, it, expect } from "vitest";
import {
  howToHostParts,
  MISSING_LEAGUE_TICKET_WARNING,
  NO_TICKET_RESULT_NOTE,
  seriesLobbyRule,
} from "./match-hosting";
import { createLeagueConfig } from "./league-config";
import { LEAGUE_GAME_MODE } from "./constants";

describe("seriesLobbyRule", () => {
  it("phrases each series length the way it is played", () => {
    expect(seriesLobbyRule(1)).toBe("Bo1 = one lobby");
    // Bo2 plays both games — each one its own lobby.
    expect(seriesLobbyRule(2)).toBe("Bo2 = two separate lobbies");
    // Odd series stop at the clinching win.
    expect(seriesLobbyRule(3)).toBe("Bo3 = one lobby per game, first to 2 wins");
    expect(seriesLobbyRule(5)).toBe("Bo5 = one lobby per game, first to 3 wins");
    // Even series play every game.
    expect(seriesLobbyRule(4)).toBe("Bo4 = 4 separate lobbies");
  });

  it("never renders a nonsense length", () => {
    expect(seriesLobbyRule(0)).toBe("Bo1 = one lobby");
    expect(seriesLobbyRule(2.5)).toBe("Bo2 = two separate lobbies");
  });
});

describe("howToHostParts", () => {
  it("names the host, the region and mode from config, and the series rule", () => {
    const eu = createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: "eu" });
    expect(
      howToHostParts({
        homeTeamName: "Blue Wolves",
        bestOf: 2,
        region: eu.gameServerRegion,
        mode: LEAGUE_GAME_MODE.name,
      }),
    ).toEqual([
      "Blue Wolves's captain hosts",
      "Europe West",
      "Captains Mode",
      "Bo2 = two separate lobbies",
    ]);
    const us = createLeagueConfig({});
    expect(
      howToHostParts({
        homeTeamName: "Red",
        bestOf: 3,
        region: us.gameServerRegion,
        mode: LEAGUE_GAME_MODE.name,
      })[1],
    ).toBe("US East");
  });
});

describe("ticket copy", () => {
  it("tells the admin why it is urgent and what breaks without it", () => {
    expect(MISSING_LEAGUE_TICKET_WARNING).toMatch(/15 days/);
    expect(MISSING_LEAGUE_TICKET_WARNING).toMatch(/may not reach OpenDota/);
  });

  it("points captains at pasting the match ID, never at public match history", () => {
    expect(NO_TICKET_RESULT_NOTE).toMatch(/paste the Dota match ID/);
    expect(NO_TICKET_RESULT_NOTE).toMatch(/Report your result/);
    expect(NO_TICKET_RESULT_NOTE).not.toMatch(/public/i);
  });
});
