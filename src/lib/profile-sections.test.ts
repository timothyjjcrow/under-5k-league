import { describe, expect, it } from "vitest";
import { profileSections, type ProfileData } from "./profile-sections";

const none: ProfileData = {
  leagueGames: false,
  economy: false,
  gradedGames: false,
  heroes: false,
  records: false,
  recordWatch: false,
  achievements: false,
  seasons: false,
  inhouse: false,
};

const navIds = (data: Partial<ProfileData>) =>
  profileSections({ ...none, ...data }).nav.map((item) => item.id);

describe("profileSections", () => {
  it("gives a player with nothing on record just the overview", () => {
    const sections = profileSections(none);
    expect(sections.nav).toEqual([
      { id: "player-overview", label: "Overview" },
    ]);
    expect(sections).toMatchObject({
      matches: false,
      performance: false,
      profile: false,
      career: false,
      inhouseInOverview: false,
      inhouseInCareer: false,
    });
  });

  it("lists a tab for every band that renders, in page order", () => {
    expect(
      profileSections({
        leagueGames: true,
        economy: true,
        gradedGames: true,
        heroes: true,
        records: true,
        recordWatch: true,
        achievements: true,
        seasons: true,
        inhouse: true,
      }).nav,
    ).toEqual([
      { id: "player-overview", label: "Overview" },
      { id: "player-matches", label: "Matches" },
      { id: "player-performance", label: "Performance" },
      { id: "player-heroes", label: "Heroes" },
      { id: "player-records", label: "Records" },
      { id: "player-career", label: "Career" },
    ]);
  });

  it("opens the performance band for either of its cards", () => {
    const economyOnly = profileSections({
      ...none,
      leagueGames: true,
      economy: true,
    });
    expect(economyOnly).toMatchObject({
      performance: true,
      performanceCard: true,
      reportCard: false,
    });
    const gradedOnly = profileSections({
      ...none,
      leagueGames: true,
      gradedGames: true,
    });
    expect(gradedOnly).toMatchObject({
      performance: true,
      performanceCard: false,
      reportCard: true,
    });
    expect(navIds({ leagueGames: true, gradedGames: true })).toContain(
      "player-performance",
    );
  });

  it("opens the player-profile band for heroes or records, each with its own tab", () => {
    expect(profileSections({ ...none, heroes: true }).profile).toBe(true);
    expect(profileSections({ ...none, records: true }).profile).toBe(true);
    expect(navIds({ heroes: true })).toEqual([
      "player-overview",
      "player-heroes",
    ]);
    expect(navIds({ records: true })).toEqual([
      "player-overview",
      "player-records",
    ]);
  });

  it("opens the records card for a record within reach, held or not", () => {
    // Someone chasing a record they don't hold still gets the card and tab.
    expect(profileSections({ ...none, recordWatch: true })).toMatchObject({
      profile: true,
      records: true,
      heroes: false,
    });
    expect(navIds({ recordWatch: true })).toEqual([
      "player-overview",
      "player-records",
    ]);
    expect(navIds({ records: true, recordWatch: true })).toEqual([
      "player-overview",
      "player-records",
    ]);
  });

  it("puts the inhouse card in the overview until they have league games", () => {
    const inhouseOnly = profileSections({ ...none, inhouse: true });
    expect(inhouseOnly.inhouseInOverview).toBe(true);
    expect(inhouseOnly.inhouseInCareer).toBe(false);
    // Its only card moved up, so there is no career band to jump to.
    expect(inhouseOnly.career).toBe(false);
    expect(inhouseOnly.nav.map((item) => item.id)).toEqual([
      "player-overview",
    ]);

    const both = profileSections({ ...none, leagueGames: true, inhouse: true });
    expect(both.inhouseInOverview).toBe(false);
    expect(both.inhouseInCareer).toBe(true);
    expect(both.career).toBe(true);
    expect(both.nav.map((item) => item.id)).toEqual([
      "player-overview",
      "player-matches",
      "player-career",
    ]);
  });

  it("opens the career band for achievements or seasons alone", () => {
    expect(profileSections({ ...none, achievements: true }).career).toBe(true);
    expect(profileSections({ ...none, seasons: true }).career).toBe(true);
  });
});
