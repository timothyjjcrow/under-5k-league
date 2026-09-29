import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "league-lobby-checklist.tsx"), "utf8");

describe("LeagueLobbyChecklist source contract", () => {
  it("assigns hosting and verification responsibilities", () => {
    expect(SRC).toContain("creates the private lobby");
    expect(SRC).toMatch(/away captain is the\s+backup\s+host/);
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

  it("folds the steps under a disclosure, after the host line and the id", () => {
    const host = SRC.indexOf("How to host:");
    const copy = SRC.indexOf("Copy league id");
    const details = SRC.indexOf("<details>");
    expect(host).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(host);
    expect(details).toBeGreaterThan(copy);
    expect(SRC).toContain("Lobby setup, step by step");
    expect(SRC.indexOf("creates the private lobby")).toBeGreaterThan(details);
  });

  it("leaves the wrong-ticket advice to the result card, said once", () => {
    // leagueResultCopy's recovery line is the one place it lives now.
    expect(SRC).not.toMatch(/recovery|wrong ticket|incorrect ticket/i);
  });
});
