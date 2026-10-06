import { afterEach, describe, expect, it, vi } from "vitest";
import { createLeagueConfig } from "./league-config";

describe("regional league configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the existing US identity, invite, server and advertised slot by default", () => {
    expect(createLeagueConfig({})).toMatchObject({
      region: "us",
      name: "GGD2L",
      timeZone: "America/Los_Angeles",
      discordInviteUrl: "https://discord.gg/H7PJ4VxUGh",
      gameServerRegion: "US East",
      gameServerRegionId: 2,
      inhouseLeagueName: "Under 5K In-House League",
      inhouseLeagueConfigured: true,
      matchSchedule: {
        label: "Sundays at 6:00 PM Pacific time", timezone: "Pacific", announced: true,
      },
    });
  });

  it("gives Europe its own identity and never inherits the US invite or match night", () => {
    expect(createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: "eu" })).toMatchObject({
      region: "eu",
      name: "GGD2L Europe",
      timeZone: "Europe/Berlin",
      discordInviteUrl: "",
      gameServerRegion: "Europe West",
      gameServerRegionId: 3,
      inhouseLeagueName: "European inhouse league ticket (to be configured)",
      inhouseLeagueConfigured: false,
      matchSchedule: {
        day: "", time: "", announced: false, label: "Match night to be announced",
        // The zone in plain words, never the raw "Europe/Berlin" id.
        timezone: "Berlin",
      },
    });
  });

  // A new match-night poll's grid. Europe's players asked for evening times:
  // the window is centred on 8 PM Berlin, while the US keeps noon to 6 PM
  // Pacific. Both are seven hourly starts a day, 49 in a default poll.
  it("offers each league its own default poll window", () => {
    expect(createLeagueConfig({}).pollDefaultHours).toEqual({ from: 12, to: 18 });
    const europe = createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: "eu" });
    expect(europe.pollDefaultHours).toEqual({ from: 17, to: 23 });
    const { from, to } = europe.pollDefaultHours;
    expect((from + to) / 2).toBe(20);
  });

  it("uses deployment overrides together for an announced European slot", () => {
    const config = createLeagueConfig({
      NEXT_PUBLIC_LEAGUE_REGION: " EU ",
      NEXT_PUBLIC_APP_NAME: " GGD2L Europe ",
      NEXT_PUBLIC_DISCORD_INVITE_URL: " https://discord.gg/europe-test ",
      NEXT_PUBLIC_LEAGUE_TIMEZONE: " Europe/London ",
      NEXT_PUBLIC_MATCH_DAY: "Fridays",
      NEXT_PUBLIC_MATCH_TIME: "7:00 PM",
    });
    expect(config.discordInviteUrl).toBe("https://discord.gg/europe-test");
    expect(config.timeZone).toBe("Europe/London");
    expect(config.matchSchedule.label).toBe("Fridays at 7:00 PM London time");
    expect(config.matchSchedule.timezone).toBe("London");
    expect(config.matchSchedule.announced).toBe(true);
  });

  it("says in the footer who runs each league and who fixes a profile", () => {
    expect(createLeagueConfig({}).footerNote).toBe(
      "GGD2L is run by volunteers. Your Steam name, avatar, medal and league results are public here. To fix or remove your profile, message a league admin on Discord.",
    );
    // Europe has no Discord invite until it is configured, so it can't
    // send people there.
    expect(
      createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: "eu" }).footerNote,
    ).toBe(
      "GGD2L Europe is run by volunteers. Your Steam name, avatar, medal and league results are public here. To fix or remove your profile, contact a league admin.",
    );
    expect(
      createLeagueConfig({
        NEXT_PUBLIC_LEAGUE_REGION: "eu",
        NEXT_PUBLIC_DISCORD_INVITE_URL: "https://discord.gg/europe-test",
      }).footerNote,
    ).toMatch(/^GGD2L Europe is run by volunteers\..*message a league admin on Discord\.$/);
  });

  it("names an overridden US zone the way players say it", () => {
    expect(createLeagueConfig({
      NEXT_PUBLIC_LEAGUE_TIMEZONE: "America/New_York",
    }).matchSchedule).toMatchObject({
      label: "Sundays at 6:00 PM Eastern time",
      timezone: "Eastern",
    });
  });

  it("keeps a partially configured European slot unannounced", () => {
    expect(createLeagueConfig({
      NEXT_PUBLIC_LEAGUE_REGION: "eu", NEXT_PUBLIC_MATCH_DAY: "Fridays",
    }).matchSchedule.announced).toBe(false);
  });

  it("uses the separate European inhouse ticket only after it is configured", () => {
    expect(createLeagueConfig({
      NEXT_PUBLIC_LEAGUE_REGION: "eu",
      NEXT_PUBLIC_INHOUSE_LEAGUE_NAME: " GGD2L European Inhouse ",
    })).toMatchObject({
      inhouseLeagueName: "GGD2L European Inhouse",
      inhouseLeagueConfigured: true,
    });
  });

  it("rejects misspelled regions and unsupported timezones", () => {
    expect(() => createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: "eur" })).toThrow("us or eu");
    expect(() => createLeagueConfig({ NEXT_PUBLIC_LEAGUE_TIMEZONE: "Europ/Berlin" })).toThrow("IANA timezone");
  });

  it("exports European branding into shared metadata and constants when built for Europe", async () => {
    vi.stubEnv("NEXT_PUBLIC_LEAGUE_REGION", "eu");
    vi.stubEnv("NEXT_PUBLIC_APP_NAME", "");
    vi.stubEnv("NEXT_PUBLIC_DISCORD_INVITE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_LEAGUE_TIMEZONE", "");
    vi.stubEnv("NEXT_PUBLIC_MATCH_DAY", "");
    vi.stubEnv("NEXT_PUBLIC_MATCH_TIME", "");
    vi.stubEnv("NEXT_PUBLIC_INHOUSE_LEAGUE_NAME", "");
    vi.resetModules();
    const [{ shareMetadata }, constants, poll] = await Promise.all([
      import("./share-metadata"), import("./constants"), import("./match-night-poll"),
    ]);
    // The admin form and the create action read these, not the config.
    expect([poll.POLL_DEFAULT_FROM_HOUR, poll.POLL_DEFAULT_TO_HOUR]).toEqual([17, 23]);
    expect(shareMetadata("Players", "League players").openGraph).toMatchObject({ siteName: "GGD2L Europe" });
    expect(constants.INHOUSE.LOBBY_NAME).toBe("GGD2L Europe Inhouse");
    expect(constants.INHOUSE.LOBBY_TICKET).toBe("European inhouse league ticket (to be configured)");
    expect(constants.INHOUSE.LOBBY_TICKET_CONFIGURED).toBe(false);
    expect(constants.DISCORD_INVITE_URL).toBe("");
    expect(constants.MATCH_SCHEDULE.label).toBe("Match night to be announced");
    expect(constants.GAME_SERVER_REGION).toBe("Europe West");
  });
});
