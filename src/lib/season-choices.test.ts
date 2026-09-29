import { describe, expect, it } from "vitest";
import {
  finishedSeasonLink,
  seasonHref,
  seasonSwitcherChoices,
  showSeasonSwitcher,
  type SeasonChoiceRow,
} from "./season-choices";

// Newest first, as loadSeasonChoices and the Record book pass them.
const rows: SeasonChoiceRow[] = [
  { id: "s3", name: "Season 3", isActive: true, hasData: false },
  { id: "s2", name: "Season 2", isActive: false, hasData: true },
  { id: "s1", name: "Season 1", isActive: false, hasData: false },
  { id: "s0", name: "Season 0", isActive: false, hasData: true },
];

describe("seasonSwitcherChoices", () => {
  it("offers seasons with data plus the current one, newest first", () => {
    expect(
      seasonSwitcherChoices(rows, { selectedId: "s3" }).map((s) => s.id),
    ).toEqual(["s3", "s2", "s0"]);
  });

  it("keeps the season being viewed even when it has nothing to show", () => {
    expect(
      seasonSwitcherChoices(rows, { selectedId: "s1" }).map((s) => s.id),
    ).toEqual(["s3", "s2", "s1", "s0"]);
  });

  it("leaves out an empty current season when the page opts out", () => {
    // The Record book's bare address is every season, not the current one.
    expect(
      seasonSwitcherChoices(rows, {
        selectedId: null,
        includeActive: false,
      }).map((s) => s.id),
    ).toEqual(["s2", "s0"]);
  });

  it("returns plain season choices without the data flag", () => {
    expect(seasonSwitcherChoices(rows, { selectedId: "s2" })[1]).toEqual({
      id: "s2",
      name: "Season 2",
      isActive: false,
    });
  });
});

describe("showSeasonSwitcher", () => {
  const one = [{ id: "s1", name: "Season 1", isActive: true }];
  const two = [...one, { id: "s0", name: "Season 0", isActive: false }];

  it("hides the picker for a league's only season", () => {
    expect(showSeasonSwitcher(one, { selectedId: "s1" })).toBe(false);
    expect(showSeasonSwitcher([], { selectedId: null })).toBe(false);
  });

  it("shows it once there are two seasons to choose between", () => {
    expect(showSeasonSwitcher(two, { selectedId: "s1" })).toBe(true);
  });

  it("on an all-seasons page, shows it only with two seasons or a picked one", () => {
    expect(
      showSeasonSwitcher(one, { allSeasons: true, selectedId: null }),
    ).toBe(false);
    // A picked season keeps "All seasons" as the way back.
    expect(
      showSeasonSwitcher(one, { allSeasons: true, selectedId: "s1" }),
    ).toBe(true);
    expect(
      showSeasonSwitcher(two, { allSeasons: true, selectedId: null }),
    ).toBe(true);
  });
});

describe("seasonHref", () => {
  it("links the current season to the bare page", () => {
    expect(seasonHref("/leaders", { id: "s3", isActive: true })).toBe(
      "/leaders",
    );
  });

  it("gives any other season its ?season=", () => {
    expect(seasonHref("/leaders", { id: "s 2", isActive: false })).toBe(
      "/leaders?season=s+2",
    );
  });

  it("gives every season a ?season= when the bare page is all seasons", () => {
    expect(
      seasonHref("/records", { id: "s3", isActive: true }, { allSeasons: true }),
    ).toBe("/records?season=s3");
  });
});

describe("finishedSeasonLink", () => {
  it("points an archived season's boards at its recap page", () => {
    expect(
      finishedSeasonLink({ id: "s 1", isActive: false, status: "PLAYOFFS" }),
    ).toEqual({ href: "/seasons/s%201", label: "Season recap" });
  });

  it("calls the current season's page its recap once the final is played", () => {
    expect(
      finishedSeasonLink({ id: "s3", isActive: true, status: "COMPLETE" }),
    ).toEqual({ href: "/seasons/s3", label: "Season recap" });
  });

  it("links nothing while the current season is still being played", () => {
    for (const status of ["SIGNUPS", "DRAFT", "REGULAR_SEASON", "PLAYOFFS"]) {
      expect(finishedSeasonLink({ id: "s3", isActive: true, status })).toBe(
        null,
      );
    }
  });
});
