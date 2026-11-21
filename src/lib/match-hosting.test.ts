import { describe, it, expect } from "vitest";
import {
  howToHostParts,
  leagueResultCopy,
  lobbyHostShown,
  matchLobbyHosts,
  MISSING_LEAGUE_TICKET_WARNING,
  NO_TICKET_REPORT_SUBTITLE,
  NO_TICKET_RESULT_NOTE,
  seriesLobbyRule,
  waitingForResultNote,
} from "./match-hosting";
import { createLeagueConfig } from "./league-config";
import { AUTO_SYNC, LEAGUE_GAME_MODE } from "./constants";

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
        hostCaptainName: "Alice",
        bestOf: 2,
        region: eu.gameServerRegion,
        mode: LEAGUE_GAME_MODE.name,
      }),
    ).toEqual([
      "Alice (Blue Wolves's captain) hosts",
      "Europe West",
      "Captains Mode",
      "Bo2 = two separate lobbies",
    ]);
    const us = createLeagueConfig({});
    expect(
      howToHostParts({
        homeTeamName: "Red",
        hostCaptainName: "Bob",
        bestOf: 3,
        region: us.gameServerRegion,
        mode: LEAGUE_GAME_MODE.name,
      })[1],
    ).toBe("US East");
  });
});

describe("matchLobbyHosts", () => {
  const match = {
    homeTeam: { name: "Blue Wolves", captain: { id: "u-home", name: "Alice" } },
    awayTeam: { name: "Red", captain: { id: "u-away", name: "Bob" } },
  };

  it("makes the home captain the host and the away captain the backup", () => {
    expect(matchLobbyHosts(match, null)).toEqual({
      host: { id: "u-home", name: "Alice", teamName: "Blue Wolves", isViewer: false },
      backup: { id: "u-away", name: "Bob", teamName: "Red", isViewer: false },
    });
  });

  it("marks the viewer's own side, and only theirs", () => {
    const asHost = matchLobbyHosts(match, "u-home");
    expect(asHost.host.isViewer).toBe(true);
    expect(asHost.backup.isViewer).toBe(false);
    const asBackup = matchLobbyHosts(match, "u-away");
    expect(asBackup.host.isViewer).toBe(false);
    expect(asBackup.backup.isViewer).toBe(true);
    const asPlayer = matchLobbyHosts(match, "u-other");
    expect(asPlayer.host.isViewer || asPlayer.backup.isViewer).toBe(false);
  });
});

describe("lobbyHostShown", () => {
  it("shows while the active season's series can still be played", () => {
    for (const status of ["SCHEDULED", "LIVE"]) {
      expect(lobbyHostShown({ status, season: { isActive: true } })).toBe(true);
    }
  });

  it("hides on a final series or an archived season", () => {
    expect(
      lobbyHostShown({ status: "COMPLETED", season: { isActive: true } }),
    ).toBe(false);
    expect(
      lobbyHostShown({ status: "SCHEDULED", season: { isActive: false } }),
    ).toBe(false);
  });
});

describe("ticket copy", () => {
  it("tells the admin why it is urgent and what breaks without it", () => {
    expect(MISSING_LEAGUE_TICKET_WARNING).toMatch(/15 days/);
    expect(MISSING_LEAGUE_TICKET_WARNING).toMatch(/may not reach OpenDota/);
  });

  it("points captains at pasting the match ID, never at public match history", () => {
    expect(NO_TICKET_RESULT_NOTE).toMatch(/Report your result/);
    expect(NO_TICKET_REPORT_SUBTITLE).toMatch(/Paste the Dota match ID/);
    for (const copy of [NO_TICKET_RESULT_NOTE, NO_TICKET_REPORT_SUBTITLE]) {
      expect(copy).not.toMatch(/public/i);
    }
  });

  it("agrees with the note: an admin may be needed without a ticket", () => {
    // The card used to say "no admin needed" right under a note that ends
    // "send an admin the score".
    expect(NO_TICKET_REPORT_SUBTITLE).toMatch(/send an admin the score/);
    expect(NO_TICKET_REPORT_SUBTITLE).not.toMatch(/no admin needed/i);
    // Each step is said once: the note points at the card, the card says how.
    expect(NO_TICKET_RESULT_NOTE).not.toMatch(/admin|match ID/i);
  });
});

describe("leagueResultCopy", () => {
  const every = Math.round(AUTO_SYNC.LEAGUE_INTERVAL_SECONDS / 60);

  it("counts from the scheduled kickoff, with result sync's own timings", () => {
    const { lead, recovery } = leagueResultCopy({ live: false });
    expect(lead).toContain(
      `from ${AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF} minutes after kickoff`,
    );
    expect(lead).toContain(`about every ${every} minutes`);
    // Never "25 minutes after each game": the wait runs from kickoff.
    expect(lead).not.toMatch(/after each game/);
    expect(recovery).toContain(
      `${Math.round(AUTO_SYNC.LEAGUE_FALLBACK_MINUTES_AFTER_KICKOFF / 60)} hours after kickoff`,
    );
  });

  it("drops the kickoff wait once a series is under way", () => {
    // A live series is scanned right away, both ways.
    const { lead, recovery } = leagueResultCopy({ live: true });
    expect(lead).toContain(`about every ${every} minutes`);
    expect(lead).not.toContain("after kickoff");
    expect(recovery).not.toContain("after kickoff");
  });

  it("says the recovery advice once, naming the controls it points at", () => {
    for (const live of [false, true]) {
      const { lead, recovery } = leagueResultCopy({ live });
      expect(recovery).toMatch(/wrong ticket/);
      expect(lead).not.toMatch(/wrong ticket|Auto-fetch/);
      // The buttons' real names (MatchImportControls).
      expect(recovery).toContain("Auto-fetch games");
      expect(recovery).toContain("Dota match ID");
    }
  });
});

describe("waitingForResultNote", () => {
  it("says results arrive on their own only with a league ticket", () => {
    for (const viewerIsCaptain of [true, false]) {
      expect(
        waitingForResultNote({ hasLeagueTicket: true, viewerIsCaptain }),
      ).toMatch(/usually appear here on their own/);
      const ticketless = waitingForResultNote({
        hasLeagueTicket: false,
        viewerIsCaptain,
      });
      // The captain's own section says the result "may not appear on its
      // own" without a ticket; the strip must never claim the opposite.
      expect(ticketless).not.toMatch(/on (its|their) own/);
      expect(ticketless).toMatch(/no league ticket/);
    }
  });

  it("points a captain at their tools and tells everyone else who can", () => {
    for (const hasLeagueTicket of [true, false]) {
      expect(
        waitingForResultNote({ hasLeagueTicket, viewerIsCaptain: true }),
      ).toMatch(/Captain tools below\.$/);
      expect(
        waitingForResultNote({ hasLeagueTicket, viewerIsCaptain: false }),
      ).toMatch(/a captain \S.* from this page\.$/);
    }
  });
});
