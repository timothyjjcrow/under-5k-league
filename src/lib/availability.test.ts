import { describe, it, expect } from "vitest";
import {
  matchNightRoster,
  parseAvailabilityStatus,
  teamAvailability,
} from "./availability";

describe("teamAvailability", () => {
  const roster = ["a", "b", "c", "d", "e"];

  it("counts confirmed, out, and unanswered", () => {
    const s = teamAvailability(roster, [
      { userId: "a", status: "IN" },
      { userId: "b", status: "IN" },
      { userId: "c", status: "OUT" },
    ]);
    expect(s.confirmed).toBe(2);
    expect(s.out).toBe(1);
    expect(s.unanswered).toBe(2);
    expect(s.outUserIds).toEqual(["c"]);
  });

  it("treats everyone as unanswered with no rows", () => {
    const s = teamAvailability(roster, []);
    expect(s).toMatchObject({ confirmed: 0, out: 0, unanswered: 5 });
  });

  it("ignores RSVPs from users not on the roster (e.g. the other team)", () => {
    const s = teamAvailability(roster, [
      { userId: "zz", status: "OUT" },
      { userId: "a", status: "IN" },
    ]);
    expect(s.confirmed).toBe(1);
    expect(s.out).toBe(0);
  });

  it("ignores unknown status strings", () => {
    const s = teamAvailability(roster, [{ userId: "a", status: "MAYBE" }]);
    expect(s).toMatchObject({ confirmed: 0, out: 0, unanswered: 5 });
  });
});

describe("parseAvailabilityStatus", () => {
  it("accepts IN and OUT only", () => {
    expect(parseAvailabilityStatus("IN")).toBe("IN");
    expect(parseAvailabilityStatus("OUT")).toBe("OUT");
    expect(parseAvailabilityStatus("MAYBE")).toBeNull();
    expect(parseAvailabilityStatus("")).toBeNull();
  });
});

describe("matchNightRoster", () => {
  it("swaps covered players for their standins", () => {
    expect(
      matchNightRoster(
        ["a", "b", "c"],
        [{ standinUserId: "s1", replacingUserId: "b" }],
      ),
    ).toEqual(["a", "c", "s1"]);
  });

  it("appends a standin with no named replacement without dropping anyone", () => {
    expect(
      matchNightRoster(["a", "b"], [{ standinUserId: "s1", replacingUserId: null }]),
    ).toEqual(["a", "b", "s1"]);
  });

  it("returns the base roster untouched with no assignments", () => {
    const base = ["a", "b"];
    expect(matchNightRoster(base, [])).toBe(base);
  });

  it("keeps the standin's RSVP countable by teamAvailability", () => {
    const roster = matchNightRoster(
      ["a", "b", "x"],
      [{ standinUserId: "s", replacingUserId: "x" }],
    );
    const summary = teamAvailability(roster, [
      { userId: "a", status: "IN" },
      { userId: "b", status: "IN" },
      { userId: "s", status: "IN" },
      { userId: "x", status: "OUT" }, // replaced player's OUT no longer counts
    ]);
    expect(summary).toMatchObject({ confirmed: 3, out: 0, unanswered: 0 });
  });
});
