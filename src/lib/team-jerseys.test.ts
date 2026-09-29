import { describe, expect, it } from "vitest";
import { getTeamJersey } from "./team-jerseys";

const roster = (...names: string[]) => names.map((name) => ({ name }));
const team = (...names: string[]) => ({ id: "fixture-team", roster: roster(...names) });

// The live My Team Sucks roster, whose league team was still named
// "w4tkins's Team" when the jerseys shipped.
const MY_TEAM_SUCKS = team(
  "Big Dawg SaMy",
  "USDanny.ttv",
  "Video Game Enjoyer",
  "Neraidaphobia",
  "w4tkins",
);

describe("getTeamJersey", () => {
  it("finds a set by its production team id, whatever the name or roster", () => {
    expect(
      getTeamJersey(
        { id: "cmsjf1jqy0004ot40dhoagbv7", roster: roster("Anyone", "Else") },
        "us",
      )?.teamName,
    ).toBe("My Team Sucks");
    expect(
      getTeamJersey({ id: "cmscv9ikm0002cck63pgu4uba", roster: [] }, "us")
        ?.teamName,
    ).toBe("Bad Boys of Dota");
  });

  it("finds a set by the players it was made for, whatever the team is called", () => {
    const jersey = getTeamJersey(MY_TEAM_SUCKS, "us");
    expect(jersey?.teamName).toBe("My Team Sucks");
    expect(jersey?.products).toHaveLength(5);
    expect(jersey?.frontImage).toBe("/merch/jerseys/my-team-sucks-front.png");
  });

  it("keeps the set through a couple of roster changes or Steam renames", () => {
    expect(
      getTeamJersey(
        team("Big Dawg SaMy", "  usdanny.TTV ", "w4tkins", "New Signing", "Renamed Player"),
        "us",
      )?.teamName,
    ).toBe("My Team Sucks");
  });

  it("ignores case and accents in a persona", () => {
    expect(
      getTeamJersey(team("Power", "Bobr Kurwa", "cte(z)", "Someone", "Else"), "us")
        ?.teamName,
    ).toBe("Bleeding Heart Dota");
  });

  it("needs a majority of the set's players on the roster", () => {
    expect(
      getTeamJersey(team("Big Dawg SaMy", "w4tkins", "Stranger", "Other", "Third"), "us"),
    ).toBeNull();
    expect(getTeamJersey(team(), "us")).toBeNull();
  });

  it("never matches on a team name, even the jersey's own", () => {
    expect(getTeamJersey(team("My Team Sucks", "w4tkins's Team"), "us")).toBeNull();
  });

  it("belongs to the US league only", () => {
    expect(getTeamJersey(MY_TEAM_SUCKS, "eu")).toBeNull();
  });
});
