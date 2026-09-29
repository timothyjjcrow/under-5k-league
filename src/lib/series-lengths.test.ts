import { describe, expect, it } from "vitest";
import { MATCH_PHASE } from "./constants";
import { SERIES_LENGTH_PHASES, seriesLengthSyncNote } from "./series-lengths";

describe("SERIES_LENGTH_PHASES", () => {
  it("maps each setting to its phase and leaves tiebreakers alone", () => {
    expect(SERIES_LENGTH_PHASES.map((p) => [p.phase, p.field])).toEqual([
      [MATCH_PHASE.REGULAR, "regularBestOf"],
      [MATCH_PHASE.PLAYOFF, "playoffBestOf"],
      [MATCH_PHASE.FINAL, "finalBestOf"],
    ]);
  });
});

describe("seriesLengthSyncNote", () => {
  it("says nothing when no existing fixture was touched or left behind", () => {
    expect(
      seriesLengthSyncNote([
        { phase: MATCH_PHASE.REGULAR, bestOf: 2, updated: 0, underWay: 0 },
        { phase: MATCH_PHASE.FINAL, bestOf: 3, updated: 0, underWay: 0 },
      ]),
    ).toBe("");
  });

  it("names the grand final it moved", () => {
    expect(
      seriesLengthSyncNote([
        { phase: MATCH_PHASE.FINAL, bestOf: 3, updated: 1, underWay: 0 },
      ]),
    ).toBe(" · the grand final is now Bo3");
  });

  it("counts plural fixtures and reports the ones already under way", () => {
    expect(
      seriesLengthSyncNote([
        { phase: MATCH_PHASE.REGULAR, bestOf: 3, updated: 12, underWay: 1 },
        { phase: MATCH_PHASE.PLAYOFF, bestOf: 5, updated: 1, underWay: 2 },
        { phase: MATCH_PHASE.FINAL, bestOf: 5, updated: 0, underWay: 1 },
      ]),
    ).toBe(
      " · 12 regular-season matches are now Bo3" +
        " · 1 playoff match is now Bo5" +
        " · 1 regular-season match is already under way and keeps its length" +
        " · 2 playoff matches are already under way and keep their length" +
        " · the grand final is already under way and keeps its length",
    );
  });
});
