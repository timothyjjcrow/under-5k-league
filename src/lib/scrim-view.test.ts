import { describe, expect, it } from "vitest";
import { scrimHostLine } from "./scrim-view";

describe("scrimHostLine", () => {
  it("says the posting captain hosts and who gets the lobby details", () => {
    expect(
      scrimHostLine({
        hostTeamName: "Radiant Raccoons",
        hostCaptainName: "Raccoon Cap",
        opponentCaptainName: "Straits Cap",
        bestOf: 3,
        region: "US East",
      }),
    ).toBe(
      "Raccoon Cap (Radiant Raccoons) hosts: make the Dota lobby on US East and send Straits Cap the lobby name and password on Discord. Bo3 = one lobby per game, first to 2 wins.",
    );
  });

  it("uses the region it is given and the series rule for the format", () => {
    const line = scrimHostLine({
      hostTeamName: "A",
      hostCaptainName: "a",
      opponentCaptainName: "b",
      bestOf: 2,
      region: "Europe West",
    });
    expect(line).toContain("on Europe West");
    expect(line).toContain("Bo2 = two separate lobbies.");
  });
});
