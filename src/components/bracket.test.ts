import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Bracket } from "./bracket";
import type { BracketMatchView, BracketRound } from "@/lib/bracket-view";
import { MATCH_STATUS } from "@/lib/constants";

const liveFinal: BracketMatchView = {
  id: "live-final",
  home: { teamId: "home", name: "Home Team", seed: 1 },
  away: { teamId: "away", name: "Away Team", seed: 2 },
  homeScore: 1,
  awayScore: 0,
  status: MATCH_STATUS.LIVE,
  completed: false,
  winnerTeamId: null,
  when: "Aug 9, 7:00 PM",
  whenTs: Date.parse("2026-08-09T19:00:00.000Z"),
  bestOf: 3,
};

const rounds: BracketRound[] = [{ name: "Final", slots: [liveFinal] }];
const completedFinal: BracketMatchView = {
  ...liveFinal,
  id: "completed-final",
  status: MATCH_STATUS.COMPLETED,
  completed: true,
  homeScore: 2,
  awayScore: 1,
  winnerTeamId: "home",
};

describe("Bracket presentation", () => {
  it("exposes a labelled, described, keyboard-focusable scroll region", () => {
    const html = renderToStaticMarkup(
      createElement(Bracket, { rounds, championTeamId: null }),
    );

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Playoff bracket"');
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("Swipe or scroll sideways to explore every round");
    expect(html).toContain("Keyboard: focus the bracket");
    expect(html).toContain("Grand final");
  });

  it("shows a live series label and both partial scores", () => {
    const html = renderToStaticMarkup(
      createElement(Bracket, { rounds, championTeamId: null }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Live series — 1–0"');
    expect(html).toContain("LIVE");
    expect(html).toMatch(/Home Team<\/span><span[^>]*>1<\/span>/);
    expect(html).toMatch(/Away Team<\/span><span[^>]*>0<\/span>/);
  });

  it("gives team toggles and match links complete accessible names", () => {
    const html = renderToStaticMarkup(
      createElement(Bracket, { rounds, championTeamId: null }),
    );

    expect(html).toContain(
      'aria-label="Trace Home Team, seed 1, score 1 through the playoff bracket"',
    );
    expect(html).toContain(
      'aria-label="Grand final: Home Team versus Away Team, live at 1 to 0, best of 3. View match details"',
    );
    expect(html).toContain("focus-visible:ring-2");
  });

  it("crowns only the recorded winner of the completed grand final", () => {
    const valid = renderToStaticMarkup(
      createElement(Bracket, {
        rounds: [{ name: "Final", slots: [completedFinal] }],
        championTeamId: "home",
      }),
    );
    const mismatched = renderToStaticMarkup(
      createElement(Bracket, {
        rounds: [{ name: "Final", slots: [completedFinal] }],
        championTeamId: "away",
      }),
    );

    expect(valid).toContain('aria-label="Champion crowned"');
    expect(valid).toContain("score 2, champion");
    expect(mismatched).toContain('aria-label="The trophy awaits"');
    expect(mismatched).not.toContain(", champion");
  });
});

// The project intentionally runs component tests in Node without jsdom. A
// source guard pins the event wiring that static rendering cannot exercise:
// keyboard focus must preview the same path as pointer hover, while a selected
// path remains persistent after either preview ends.
describe("Bracket trace interaction wiring", () => {
  const source = readFileSync(join(__dirname, "bracket.tsx"), "utf8");

  it("keeps selection, hover, and keyboard focus as separate trace inputs", () => {
    expect(source).toContain("hoveredTeam ?? focusedTeam ?? selectedTeam");
    expect(source).toContain("onClick={() => trace.onSelect(");
    expect(source).toContain("onMouseEnter={() => trace.onHover(side.teamId)}");
    expect(source).toContain("onMouseLeave={() => trace.onHover(null)}");
    expect(source).toContain("onFocus={() => trace.onFocus(side.teamId)}");
    expect(source).toContain("onBlur={() => trace.onFocus(null)}");
    expect(source).toContain("aria-pressed={selected}");
    expect(source).toContain("if (teamId != null) setHoveredTeam(null)");
  });

  it("makes the documented arrow-key scrolling real", () => {
    expect(source).toContain('event.key !== "ArrowLeft"');
    expect(source).toContain('event.key !== "ArrowRight"');
    expect(source).toContain("scrollRef.current?.scrollBy({");
    expect(source).toContain('"(prefers-reduced-motion: reduce)"');
    expect(source).toContain('behavior: reduceMotion ? "auto" : "smooth"');
  });
});
