import { describe, expect, it } from "vitest";
import { getTeamJersey } from "./team-jerseys";

const roster = (...names: string[]) => names.map((name) => ({ name }));

// The live My Team Sucks roster, whose league team was still named
// "w4tkins's Team" when the jerseys shipped.
const MY_TEAM_SUCKS = roster(
  "Big Dawg SaMy",
  "USDanny.ttv",
  "Video Game Enjoyer",
  "Neraidaphobia",
  "w4tkins",
);

describe("getTeamJersey", () => {
  it("finds a set by the players it was made for, whatever the team is called", () => {
    const jersey = getTeamJersey(MY_TEAM_SUCKS, "us");
    expect(jersey?.teamName).toBe("My Team Sucks");
    expect(jersey?.products).toHaveLength(5);
    expect(jersey?.frontImage).toBe("/merch/jerseys/my-team-sucks-front.png");
  });

  it("keeps the set through a couple of roster changes or Steam renames", () => {
    expect(
      getTeamJersey(
        roster("Big Dawg SaMy", "  usdanny.TTV ", "w4tkins", "New Signing", "Renamed Player"),
        "us",
      )?.teamName,
    ).toBe("My Team Sucks");
  });

  it("ignores case and accents in a persona", () => {
    expect(
      getTeamJersey(roster("Power", "Bobr Kurwa", "cte(z)", "Someone", "Else"), "us")
        ?.teamName,
    ).toBe("Bleeding Heart Dota");
  });

  it("needs a majority of the set's players on the roster", () => {
    expect(
      getTeamJersey(roster("Big Dawg SaMy", "w4tkins", "Stranger", "Other", "Third"), "us"),
    ).toBeNull();
    expect(getTeamJersey([], "us")).toBeNull();
  });

  it("never matches on a team name, even the jersey's own", () => {
    expect(getTeamJersey(roster("My Team Sucks", "w4tkins's Team"), "us")).toBeNull();
  });

  it("belongs to the US league only", () => {
    expect(getTeamJersey(MY_TEAM_SUCKS, "eu")).toBeNull();
  });
});
