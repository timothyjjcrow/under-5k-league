import { describe, expect, it } from "vitest";
import { MERCH_SHOP_URLS } from "./league-config";
import { getTeamJersey } from "./team-jerseys";

const roster = (...names: string[]) => names.map((name) => ({ name }));
const team = (...names: string[]) => ({ id: "fixture-team", roster: roster(...names) });

// The twelve production Team ids of the US league's Season 2, by group.
const GROUP_A = [
  "cmvolxzl8007464qyut96k9r5",
  "cmvip8vw000c4rw22bf1edzcs",
  "cmviip4h4000prw22r26xsbkp",
  "cmvhh7al0004nd489gnq9lfg4",
  "cmvhfmpul003sd489vqbz70lu",
  "cmvpy0ejo0052bl0c5wjvee45",
];
const GROUP_B = [
  "cmvmx8f0400secz1ty2w20rml",
  "cmvl5tvno00f8hshges8c8r00",
  "cmviy31gw00kyrw22qbpziq18",
  "cmvhften30041d4892asku0px",
  "cmvhaas45002cd489e2z2j1q1",
  "cmvh95h4q001jd489obr574lh",
];

// Heart Made of Steel as its shop spells the five players.
const HEART_MADE_OF_STEEL = team(
  "Chande.4Norman",
  "SUEZO",
  "Alexkrillex",
  "USDanny.ttv",
  "GrapeSlice",
);

describe("getTeamJersey", () => {
  it("finds a set by its production team id, whatever the name or roster", () => {
    expect(
      getTeamJersey(
        { id: "cmviy31gw00kyrw22qbpziq18", roster: roster("Anyone", "Else") },
        "us",
      )?.teamName,
    ).toBe("PPD");
    expect(
      getTeamJersey({ id: "cmvl5tvno00f8hshges8c8r00", roster: [] }, "us")
        ?.teamName,
    ).toBe("Bad Boys of Dota");
  });

  it("gives every Season 2 team five jerseys in its own group's shop", () => {
    const urls = new Set<string>();
    for (const [group, ids] of [["A", GROUP_A], ["B", GROUP_B]] as const) {
      for (const id of ids) {
        const jersey = getTeamJersey({ id, roster: [] }, "us");
        expect(jersey?.group, id).toBe(group);
        expect(jersey?.shopUrl).toBe(MERCH_SHOP_URLS[group]);
        expect(jersey?.products.map((product) => product.position)).toEqual([
          1, 2, 3, 4, 5,
        ]);
        for (const product of jersey!.products) {
          expect(product.url.startsWith(`${MERCH_SHOP_URLS[group]}products/`)).toBe(true);
          expect(product.url).toMatch(/-ggd2l-season-2-jersey$/);
          urls.add(product.url);
        }
      }
    }
    // Sixty products, none linked twice.
    expect(urls.size).toBe(60);
  });

  it("builds a product's address from its team, player and position", () => {
    const jersey = getTeamJersey({ id: "cmvhften30041d4892asku0px", roster: [] }, "us");
    expect(jersey?.products[2]).toEqual({
      player: "is_o",
      position: 3,
      url: "https://ggd2l-group-b-shop.fourthwall.com/products/duality-gaming-is-o-position-3-ggd2l-season-2-jersey",
    });
  });

  it("keeps the one address the shop never renamed", () => {
    const jersey = getTeamJersey({ id: "cmvpy0ejo0052bl0c5wjvee45", roster: [] }, "us");
    expect(jersey?.products[4]).toEqual({
      player: "charliehorse",
      position: 5,
      url: "https://ggd2l-shop.fourthwall.com/products/charliehorses-team-ggd2l-season-2-jersey",
    });
  });

  it("finds a set by the players it was made for, whatever the team is called", () => {
    const jersey = getTeamJersey(HEART_MADE_OF_STEEL, "us");
    expect(jersey?.teamName).toBe("Heart Made of Steel");
    expect(jersey?.products).toHaveLength(5);
  });

  it("keeps the set through a couple of roster changes or Steam renames", () => {
    expect(
      getTeamJersey(
        team("Chande.4Norman", "  usdanny.TTV ", "suezo", "New Signing", "Renamed Player"),
        "us",
      )?.teamName,
    ).toBe("Heart Made of Steel");
  });

  it("ignores case and accents in a persona", () => {
    expect(
      getTeamJersey(team("winkx", "Bobr Kurwa", "jbay7", "Someone", "Else"), "us")
        ?.teamName,
    ).toBe("LD2L Rejects");
  });

  it("needs a majority of the set's players on the roster", () => {
    expect(
      getTeamJersey(team("Chande.4Norman", "SUEZO", "Stranger", "Other", "Third"), "us"),
    ).toBeNull();
    expect(getTeamJersey(team(), "us")).toBeNull();
  });

  it("never matches on a team name, even the jersey's own", () => {
    expect(getTeamJersey(team("Heart Made of Steel", "PPD"), "us")).toBeNull();
  });

  it("belongs to the US league only", () => {
    expect(getTeamJersey(HEART_MADE_OF_STEEL, "eu")).toBeNull();
  });
});
