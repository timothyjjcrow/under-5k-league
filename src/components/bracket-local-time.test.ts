import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BracketMatchView, BracketRound } from "@/lib/bracket-view";
import { MATCH_STATUS } from "@/lib/constants";

// A static render only ever sees useLocalTimeText's SERVER snapshot (the
// server-formatted string, UTC in production). Stand in for the client
// snapshot so the test can see which string the link's accessible name uses.
vi.mock("@/components/local-time", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/local-time")>();
  return {
    ...actual,
    useLocalTimeText: (ts: number, variant: string) =>
      `viewer-local(${ts}, ${variant})`,
  };
});

const { Bracket } = await import("./bracket");

const kickoff = Date.parse("2026-10-13T00:00:00.000Z");
const scheduledFinal: BracketMatchView = {
  id: "final",
  home: { teamId: "home", name: "Home Team", seed: 1 },
  away: { teamId: "away", name: "Away Team", seed: 2 },
  homeScore: 0,
  awayScore: 0,
  status: MATCH_STATUS.SCHEDULED,
  completed: false,
  winnerTeamId: null,
  // What the server formats on a UTC host for 8 PM Eastern on Oct 12.
  when: "Mon, Oct 13, 12:00 AM",
  whenTs: kickoff,
  bestOf: 3,
};

function linkLabel(match: BracketMatchView): string {
  const rounds: BracketRound[] = [{ name: "Final", slots: [match] }];
  const html = renderToStaticMarkup(
    createElement(Bracket, { rounds, championTeamId: null }),
  );
  const label = html.match(/aria-label="(Grand final: [^"]*)"/)?.[1];
  expect(label, "the match link carries an accessible name").toBeTruthy();
  return label!;
}

describe("Bracket match link's spoken kickoff time", () => {
  it("reads the kickoff in the viewer's zone, not the server's", () => {
    const label = linkLabel(scheduledFinal);
    expect(label).toContain(`scheduled for viewer-local(${kickoff}, full)`);
    expect(label).not.toContain("Oct 13, 12:00 AM");
  });

  it("keeps the server string when there is no timestamp to localise", () => {
    const label = linkLabel({ ...scheduledFinal, whenTs: null });
    expect(label).toContain("scheduled for Mon, Oct 13, 12:00 AM");
  });
});
