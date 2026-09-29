import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "league-lobby-checklist.tsx"), "utf8");

describe("LeagueLobbyChecklist source contract", () => {
  it("assigns hosting and verification responsibilities", () => {
    expect(SRC).toContain("creates the private lobby");
    expect(SRC).toMatch(/away captain is the backup\s+host/);
    expect(SRC).toContain("away captain verifies the league name");
  });

  it("makes the league id copyable and repeats the ticket rule", () => {
    expect(SRC).toContain("navigator.clipboard.writeText(leagueId)");
    expect(SRC).toContain("Copy league id");
    expect(SRC).toContain("Do that again for every new lobby");
  });

  it("opens with the shared How to host line and says each fact once", () => {
    expect(SRC).toContain("How to host:");
    expect(SRC).toContain('hostParts.join(" · ")');
    // The host line names the home captain and the lobby count (Bo2 = two
    // separate lobbies); the steps must not say either a second time.
    expect(SRC).not.toMatch(/homeTeamName|This is a Bo2/);
  });

  it("explains player-account and direct-id recovery", () => {
    expect(SRC).toContain("automatic recovery checks");
    expect(SRC).toContain("linked player accounts");
    expect(SRC).toMatch(/add the Dota\s+match id/);
  });
});
