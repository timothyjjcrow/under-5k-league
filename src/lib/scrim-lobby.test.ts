import { describe, expect, it } from "vitest";
import { AUTO_SYNC, SCRIM_STATUS } from "./constants";
import {
  scrimHostNote,
  scrimLobbyCode,
  scrimLobbyName,
  scrimMatchSettings,
  scrimNextStep,
  scrimRecordingLine,
  scrimTicketNote,
} from "./scrim-lobby";
import { scrimLobbyPassword } from "./scrim-lobby-password";
import {
  SCRIM_DETECT_WINDOW_AFTER_MS,
  SCRIM_FEED_CLOSES_AFTER_MS,
  SCRIM_FEED_OPENS_AFTER_MS,
  scrimFeedWindow,
} from "./scrim-window";

describe("scrim lobby name", () => {
  it("is the league's name, Scrim and a stable four-digit code", () => {
    const name = scrimLobbyName("GGD2L", "cmw9lsvtg00oa53k01gkne10e");
    expect(name).toMatch(/^GGD2L Scrim [1-9]\d{3}$/);
    expect(scrimLobbyName("GGD2L", "cmw9lsvtg00oa53k01gkne10e")).toBe(name);
  });

  it("gives different scrims different codes", () => {
    const codes = new Set(
      Array.from({ length: 50 }, (_, i) => scrimLobbyCode(`scrim-${i}`)),
    );
    // Four digits can collide, but not for most of fifty neighbours.
    expect(codes.size).toBeGreaterThan(45);
    for (const code of codes) expect(code).toMatch(/^[1-9]\d{3}$/);
  });
});

describe("scrim lobby password", () => {
  it("is six easy-to-type characters, the same for every reader", () => {
    const password = scrimLobbyPassword("cmw9lsvtg00oa53k01gkne10e");
    expect(password).toMatch(/^[a-hjkmnp-z2-9]{6}$/);
    expect(scrimLobbyPassword("cmw9lsvtg00oa53k01gkne10e")).toBe(password);
    expect(scrimLobbyPassword("another-scrim")).not.toBe(password);
  });

  it("depends on the site's secret, not only on the public id", () => {
    const before = process.env.AUTH_SECRET;
    try {
      process.env.AUTH_SECRET = "a".repeat(40);
      const one = scrimLobbyPassword("same-id");
      process.env.AUTH_SECRET = "b".repeat(40);
      expect(scrimLobbyPassword("same-id")).not.toBe(one);
    } finally {
      if (before === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = before;
    }
  });
});

describe("scrim lobby steps", () => {
  it("names the ticket to pick and the in-house one not to", () => {
    const note = scrimTicketNote({
      leagueId: "20413",
      inhouseTicketName: "Under 5K In-House League",
    });
    expect(note).toContain("ticket 20413");
    expect(note).toContain("not Under 5K In-House League");
    expect(note).toContain("never recorded");
  });

  it("names no in-house ticket while the league has none", () => {
    expect(scrimTicketNote({ leagueId: "20413", inhouseTicketName: null })).toBe(
      "Pick this season's league (ticket 20413). Without this season's ticket the game is never recorded here: Valve keeps a private lobby without a ticket off OpenDota.",
    );
  });

  it("says plainly that a ticketless season can't record", () => {
    const note = scrimTicketNote({
      leagueId: null,
      inhouseTicketName: "Under 5K In-House League",
    });
    expect(note).toContain("no Dota league ticket yet");
    expect(note).not.toMatch(/public/i);
  });

  it("names the host and the backup host", () => {
    expect(
      scrimHostNote({
        hostCaptainName: "Raccoon Cap",
        hostTeamName: "Radiant Raccoons",
        backupCaptainName: "Straits Cap",
      }),
    ).toEqual({
      host: "Raccoon Cap (Radiant Raccoons) hosts",
      backup:
        "Only the league's ticket admins can pick the ticket. If it isn't in your League list, Straits Cap hosts instead, or ask an admin to add you.",
    });
  });

  it("puts server, mode and lobby count on one line", () => {
    expect(
      scrimMatchSettings({ region: "US East", mode: "Captains Mode", bestOf: 2 }),
    ).toBe("Server US East · Captains Mode · Bo2 = two separate lobbies");
  });
});

describe("scrimRecordingLine", () => {
  const base = {
    hasTicket: true,
    status: SCRIM_STATUS.SCHEDULED,
    gamesRecorded: 0,
    kickoffPassed: false,
  };

  it("promises games by themselves only with a ticket", () => {
    expect(scrimRecordingLine(base)).toContain("by themselves");
    expect(scrimRecordingLine({ ...base, hasTicket: false })).toContain(
      "don't record by themselves",
    );
  });

  it("waits for the first game after kickoff and counts a live series", () => {
    expect(scrimRecordingLine({ ...base, kickoffPassed: true })).toMatch(
      /^Waiting for the first game/,
    );
    expect(
      scrimRecordingLine({
        ...base,
        status: SCRIM_STATUS.LIVE,
        gamesRecorded: 1,
        kickoffPassed: true,
      }),
    ).toMatch(/^1 game recorded/);
  });
});

describe("scrimNextStep", () => {
  const base = {
    role: "host-captain" as const,
    status: SCRIM_STATUS.SCHEDULED,
    notPlayed: false,
    hasTicket: true,
    hostCaptainName: "Raccoon Cap",
    gamesRecorded: 0,
  };

  it("tells the host to make the lobby with the ticket", () => {
    expect(scrimNextStep(base)).toBe(
      "You host. Make the lobby with the settings below: the league ticket is what records the games.",
    );
  });

  it("tells the other captain who hosts and to check the ticket", () => {
    expect(scrimNextStep({ ...base, role: "away-captain" })).toBe(
      "Raccoon Cap hosts. Join the lobby below and check that its League is this season's ticket before the game starts.",
    );
  });

  it("tells a teammate to join, and a visitor nothing", () => {
    expect(scrimNextStep({ ...base, role: "member" })).toBe(
      "Your team plays this scrim. Join the lobby below when it starts.",
    );
    expect(scrimNextStep({ ...base, role: "other" })).toBeNull();
  });

  it("points a live series at the next lobby", () => {
    expect(
      scrimNextStep({
        ...base,
        status: SCRIM_STATUS.LIVE,
        gamesRecorded: 1,
        role: "away-captain",
      }),
    ).toBe(
      "Game 2 next. Raccoon Cap hosts a new lobby: join it and check that its League is this season's ticket before the game starts.",
    );
    expect(
      scrimNextStep({ ...base, status: SCRIM_STATUS.LIVE, gamesRecorded: 1 }),
    ).toBe(
      "Game 2 next. Make a new lobby with the settings below: the league ticket is what records the games.",
    );
    expect(
      scrimNextStep({
        ...base,
        status: SCRIM_STATUS.LIVE,
        gamesRecorded: 2,
        role: "member",
      }),
    ).toBe("Game 3 next. Join the new lobby below when it starts.");
  });

  it("warns that a ticketless season's games won't record", () => {
    expect(scrimNextStep({ ...base, hasTicket: false })).toBe(
      "You host. Make the lobby with the settings below. This season has no league ticket yet, so the games won't record.",
    );
  });

  it("covers an open time and says nothing once it's over", () => {
    expect(scrimNextStep({ ...base, status: SCRIM_STATUS.OPEN })).toMatch(
      /^Waiting for another team/,
    );
    expect(
      scrimNextStep({ ...base, status: SCRIM_STATUS.OPEN, role: "away-captain" }),
    ).toBeNull();
    expect(scrimNextStep({ ...base, status: SCRIM_STATUS.COMPLETED })).toBeNull();
    expect(scrimNextStep({ ...base, notPlayed: true })).toBeNull();
  });
});

describe("scrimFeedWindow", () => {
  it("opens when a league fixture's auto sync would", () => {
    expect(SCRIM_FEED_OPENS_AFTER_MS).toBe(
      AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF * 60_000,
    );
  });

  it("closes long before the 36-hour result window", () => {
    expect(SCRIM_FEED_CLOSES_AFTER_MS).toBeLessThan(SCRIM_DETECT_WINDOW_AFTER_MS);
    const start = Date.UTC(2026, 10, 12, 1, 0);
    expect(scrimFeedWindow(start)).toEqual({
      opensAtMs: start + 25 * 60_000,
      closesAtMs: start + 8 * 3_600_000,
    });
  });
});
