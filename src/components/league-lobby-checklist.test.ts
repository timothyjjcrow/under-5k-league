import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "league-lobby-checklist.tsx"), "utf8");

describe("LeagueLobbyChecklist source contract", () => {
  it("assigns hosting and verification responsibilities", () => {
    expect(SRC).toContain("creates the private lobby");
    expect(SRC).toContain("away captain is the backup host");
    expect(SRC).toContain("away captain verifies the league name");
  });

  it("makes the league id copyable and repeats the ticket rule", () => {
    expect(SRC).toContain("navigator.clipboard.writeText(leagueId)");
    expect(SRC).toContain("Copy league id");
    expect(SRC).toMatch(/select this\s+league ticket in both/);
    expect(SRC).toContain("Do that again for every new lobby");
  });

  it("explains player-account and direct-id recovery", () => {
    expect(SRC).toContain("automatic recovery checks");
    expect(SRC).toContain("linked player accounts");
    expect(SRC).toMatch(/add the Dota\s+match id/);
  });
});
