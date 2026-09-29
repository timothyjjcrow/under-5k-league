import { describe, expect, it } from "vitest";
import { seesPlayerLobbyPanel } from "./lobby-access";

const match = {
  homeTeam: { captainId: "home-cap" },
  awayTeam: { captainId: "away-cap" },
  standins: [{ standinUserId: "standin" }],
};
const rosters = ["home-cap", "home-p2", "away-cap", "away-p2"];
const user = (id: string, role = "PLAYER") => ({ id, role });

describe("seesPlayerLobbyPanel", () => {
  it("shows the panel to everyone resolveDotaLobby lets view it", () => {
    expect(seesPlayerLobbyPanel(user("home-p2"), match, rosters)).toBe(true);
    expect(seesPlayerLobbyPanel(user("away-p2"), match, rosters)).toBe(true);
    expect(seesPlayerLobbyPanel(user("standin"), match, rosters)).toBe(true);
    expect(seesPlayerLobbyPanel(user("admin", "ADMIN"), match, rosters)).toBe(
      true,
    );
  });

  it("hides it from spectators, who would only get the server's refusal", () => {
    expect(seesPlayerLobbyPanel(user("stranger"), match, rosters)).toBe(false);
    expect(seesPlayerLobbyPanel(user("home-p2"), match, [])).toBe(false);
  });

  it("leaves this match's captains to Captain tools, admin or not", () => {
    expect(seesPlayerLobbyPanel(user("home-cap"), match, rosters)).toBe(false);
    expect(
      seesPlayerLobbyPanel(user("away-cap", "ADMIN"), match, rosters),
    ).toBe(false);
  });
});
