import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlayoffStatusLine } from "./playoff-status-line";
import type { TeamPlayoffStatus } from "@/lib/playoff-status";

const teamName = new Map([["b", "Dire Wolves"]]);
const kickoff = new Date("2026-09-27T23:00:00Z");

function render(status: TeamPlayoffStatus) {
  return renderToStaticMarkup(
    createElement(PlayoffStatusLine, { status, teamName }),
  );
}

const playing = (
  when: "live" | "upcoming" | "awaiting" | "tbd",
): TeamPlayoffStatus => ({
  kind: "playing",
  round: "Semifinal",
  roundIndex: 1,
  matchId: "m",
  opponentId: "b",
  teamScore: 1,
  opponentScore: 0,
  scheduledAt: when === "tbd" ? null : kickoff,
  when,
});

describe("PlayoffStatusLine", () => {
  it("adds the next series' kickoff as a viewer-local time", () => {
    const html = render(playing("upcoming"));
    expect(html).toContain("Semifinal vs Dire Wolves · <time");
    expect(html).toContain(`dateTime="${kickoff.toISOString()}"`);
  });

  it("marks a live series and leaves the time off", () => {
    const html = render(playing("live"));
    expect(html).toContain("Semifinal vs Dire Wolves · live, 1–0");
    expect(html).toContain("text-danger");
    expect(html).not.toContain("<time");
  });

  it("says a knocked-out team is out, in muted text", () => {
    const html = render({
      kind: "out",
      round: "Quarterfinal",
      roundIndex: 0,
      opponentId: "b",
      teamScore: 1,
      opponentScore: 2,
      forfeit: false,
    });
    expect(html).toContain("Out in the quarterfinal (lost 1–2 to Dire Wolves)");
    expect(html).toContain("text-muted");
  });

  it("calls the champion the champion", () => {
    const html = render({ kind: "champion" });
    expect(html).toMatch(/>Champion<\/p>$/);
    expect(html).toContain("text-accent");
  });
});
