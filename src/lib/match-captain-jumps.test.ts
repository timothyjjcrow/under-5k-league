import { describe, expect, it } from "vitest";
import { MATCH_ANCHOR } from "./match-anchors";
import {
  MATCH_NIGHT_LEAD_MS,
  captainCardsOpen,
  captainJumps,
} from "./match-captain-jumps";

const KICKOFF = Date.UTC(2026, 10, 15, 23, 0);
const base = {
  resultsOpen: true,
  seriesStarted: false,
  kickoffMs: KICKOFF,
  nowMs: KICKOFF - 3 * 86_400_000,
  standinsOpen: true,
  rescheduleOpen: true,
};
const labels = (opts: Partial<typeof base>) =>
  captainJumps({ ...base, ...opts }).map((j) => `${j.label}:${j.variant}`);

describe("captainJumps", () => {
  it("days out, leads with cover and the time, and makes nothing primary", () => {
    expect(labels({})).toEqual([
      "Find a standin:secondary",
      "Change the time:secondary",
      "Set up & report:secondary",
    ]);
  });

  it("on match night leads with lobby setup and reporting as the primary", () => {
    expect(labels({ nowMs: KICKOFF - MATCH_NIGHT_LEAD_MS })).toEqual([
      "Set up & report:primary",
      "Find a standin:secondary",
      "Change the time:secondary",
    ]);
    // One millisecond earlier is still "days out".
    expect(labels({ nowMs: KICKOFF - MATCH_NIGHT_LEAD_MS - 1 })[0]).toBe(
      "Find a standin:secondary",
    );
    // A passed kickoff is match night too.
    expect(labels({ nowMs: KICKOFF + 3_600_000 })[0]).toBe(
      "Set up & report:primary",
    );
  });

  it("names the next game once the series has started", () => {
    expect(
      labels({ seriesStarted: true, rescheduleOpen: false }),
    ).toEqual(["Record next game:primary", "Find a standin:secondary"]);
  });

  it("shows a jump only while its card would take the action", () => {
    expect(labels({ standinsOpen: false, rescheduleOpen: false })).toEqual([
      "Set up & report:secondary",
    ]);
    expect(labels({ standinsOpen: false })).toEqual([
      "Change the time:secondary",
      "Set up & report:secondary",
    ]);
  });

  it("lands on each card's own anchor", () => {
    expect(captainJumps(base).map((j) => j.anchor)).toEqual([
      MATCH_ANCHOR.standins,
      MATCH_ANCHOR.reschedule,
      MATCH_ANCHOR.report,
    ]);
  });

  it("points at Captain tools while results are closed, never primary", () => {
    expect(
      captainJumps({ ...base, resultsOpen: false, kickoffMs: null }),
    ).toEqual([
      { anchor: MATCH_ANCHOR.standins, label: "Find a standin", variant: "secondary" },
      { anchor: MATCH_ANCHOR.reschedule, label: "Change the time", variant: "secondary" },
      { anchor: MATCH_ANCHOR.tools, label: "Captain tools", variant: "secondary" },
    ]);
  });
});

describe("captainCardsOpen", () => {
  const season = { isActive: true, status: "REGULAR_SEASON" };

  it("opens both cards for a scheduled fixture of the running season", () => {
    expect(captainCardsOpen({ status: "SCHEDULED", season }, "COMPLETE")).toEqual({
      standinsOpen: true,
      rescheduleOpen: true,
    });
  });

  it("keeps cover open mid-series, when the time can no longer move", () => {
    expect(captainCardsOpen({ status: "LIVE", season }, "COMPLETE")).toEqual({
      standinsOpen: true,
      rescheduleOpen: false,
    });
  });

  it("closes both on an archived season and before the auction is done", () => {
    expect(
      captainCardsOpen(
        { status: "SCHEDULED", season: { ...season, isActive: false } },
        "COMPLETE",
      ),
    ).toEqual({ standinsOpen: false, rescheduleOpen: false });
    expect(
      captainCardsOpen(
        { status: "SCHEDULED", season: { isActive: true, status: "DRAFT" } },
        "LIVE",
      ),
    ).toEqual({ standinsOpen: false, rescheduleOpen: false });
  });
});
