import { describe, expect, it } from "vitest";
import { adminSeasonCards, openBookingCount } from "./admin-sections";

const base = {
  draftStatus: null,
  matches: [],
  openBookings: 0,
  archivedPostseasonGames: 0,
};
const regular = { phase: "REGULAR", status: "SCHEDULED" };

describe("adminSeasonCards", () => {
  it("shows only the setup view during signups", () => {
    expect(adminSeasonCards({ ...base, seasonStatus: "SIGNUPS" })).toEqual({
      schedule: false,
      playoffs: false,
      standins: false,
    });
  });

  it("opens fixtures and standins only once the auction is complete", () => {
    expect(
      adminSeasonCards({ ...base, seasonStatus: "DRAFT", draftStatus: "NOT_STARTED" }),
    ).toMatchObject({ schedule: false, standins: false });
    expect(
      adminSeasonCards({ ...base, seasonStatus: "DRAFT", draftStatus: "IN_PROGRESS" }),
    ).toMatchObject({ schedule: false, standins: false });
    expect(
      adminSeasonCards({ ...base, seasonStatus: "DRAFT", draftStatus: "COMPLETE" }),
    ).toEqual({ schedule: true, playoffs: false, standins: true });
  });

  it("shows every card while the league is playing", () => {
    for (const seasonStatus of ["REGULAR_SEASON", "PLAYOFFS"]) {
      expect(
        adminSeasonCards({ ...base, seasonStatus, draftStatus: "COMPLETE" }),
      ).toEqual({ schedule: true, playoffs: true, standins: true });
    }
  });

  it("keeps a finished season's record but drops standins with nothing booked", () => {
    const cards = adminSeasonCards({
      ...base,
      seasonStatus: "COMPLETE",
      draftStatus: "COMPLETE",
      matches: [{ phase: "FINAL", status: "COMPLETED" }],
    });
    expect(cards).toEqual({
      schedule: true,
      playoffs: true,
      standins: false,
    });
  });

  it("never hides data that exists, whatever the phase", () => {
    // Fixtures, a bracket, archived playoff ids or a live booking left over
    // from a phase fix keep their card, so they stay readable and removable.
    const signups = { ...base, seasonStatus: "SIGNUPS" };
    expect(adminSeasonCards({ ...signups, matches: [regular] }).schedule).toBe(true);
    expect(
      adminSeasonCards({ ...signups, matches: [{ phase: "PLAYOFF", status: "SCHEDULED" }] })
        .playoffs,
    ).toBe(true);
    expect(
      adminSeasonCards({ ...signups, archivedPostseasonGames: 2 }).playoffs,
    ).toBe(true);
    expect(adminSeasonCards({ ...signups, openBookings: 1 }).standins).toBe(true);
    expect(
      adminSeasonCards({ ...base, seasonStatus: "COMPLETE", openBookings: 1 }).standins,
    ).toBe(true);
  });
});

describe("openBookingCount", () => {
  it("counts bookings on matches that aren't played yet", () => {
    const matches = [
      { id: "a", status: "SCHEDULED" },
      { id: "b", status: "LIVE" },
      { id: "c", status: "COMPLETED" },
    ];
    expect(
      openBookingCount(
        [{ matchId: "a" }, { matchId: "b" }, { matchId: "c" }, { matchId: "gone" }],
        matches,
      ),
    ).toBe(2);
  });
});
