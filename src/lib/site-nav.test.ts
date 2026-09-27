import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import { exploreNav, seasonNav, type NavLink, type NavState } from "./site-nav";

const PHASES = [null, ...Object.values(SEASON_STATUS)];
const DRAFTS = [null, ...Object.values(DRAFT_STATUS)];

/** Every state the menus can be rendered in. */
function allStates(): NavState[] {
  return PHASES.flatMap((phase) =>
    DRAFTS.flatMap((draftStatus) =>
      [false, true].map((hasHistory) => ({ phase, draftStatus, hasHistory })),
    ),
  );
}

const state = (
  phase: string | null,
  draftStatus: string | null = null,
  hasHistory = false,
): NavState => ({ phase, draftStatus, hasHistory });

const hrefs = (links: NavLink[]) => links.map((link) => link.href);
const exploreHrefs = (s: NavState) =>
  exploreNav(s).flatMap((section) => hrefs(section.links));
const everyHref = (s: NavState) => [...hrefs(seasonNav(s)), ...exploreHrefs(s)];

describe("site navigation", () => {
  it("gives every page one name in every phase and on every surface", () => {
    const labelFor = new Map<string, string>();
    for (const s of allStates()) {
      for (const link of [
        ...seasonNav(s, "team-1"),
        ...exploreNav(s).flatMap((section) => section.links),
      ]) {
        const known = labelFor.get(link.href);
        if (known) expect(link.label, link.href).toBe(known);
        labelFor.set(link.href, link.label);
      }
    }
    const labels = [...labelFor.values()];
    expect(new Set(labels).size).toBe(labels.length);
    expect(labelFor.get("/schedule")).toBe("Schedule");
    expect(labelFor.get("/meta")).toBe("Hero meta");
    expect(labelFor.get("/news")).toBe("League news");
    expect(labelFor.get("/seasons")).toBe("Season history");
  });

  it("never lists a page in both the primary row and Explore", () => {
    for (const s of allStates()) {
      const primary = new Set(hrefs(seasonNav(s, "team-1")));
      for (const href of exploreHrefs(s)) {
        expect(primary.has(href), href).toBe(false);
      }
      const all = everyHref(s);
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it("groups Explore the same way everywhere", () => {
    const full = exploreNav(
      state(SEASON_STATUS.REGULAR_SEASON, DRAFT_STATUS.COMPLETE, true),
    );
    expect(full.map((section) => section.label)).toEqual([
      "Play",
      "Statistics",
      "League",
    ]);
    expect(full.map((section) => section.links.map((l) => l.label))).toEqual([
      ["Scrims", "Fantasy", "Pick'em"],
      ["Leaders", "Hero meta", "Compare players", "Record book"],
      ["League news", "Feature tour", "Hall of Fame", "Season history"],
    ]);
  });

  // During the live auction these three open onto "opens after the draft"
  // screens, so the menus wait for the auction like the feature tour does.
  it("offers Schedule, Fantasy and Pick'em only once the auction is complete", () => {
    const locked = ["/schedule", "/fantasy", "/pickem"];
    for (const draftStatus of [
      null,
      DRAFT_STATUS.NOT_STARTED,
      DRAFT_STATUS.IN_PROGRESS,
      DRAFT_STATUS.PAUSED,
    ]) {
      const listed = everyHref(state(SEASON_STATUS.DRAFT, draftStatus));
      for (const href of locked) expect(listed, href).not.toContain(href);
    }
    const drafted = everyHref(
      state(SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE),
    );
    for (const href of locked) expect(drafted).toContain(href);
    for (const phase of [
      SEASON_STATUS.REGULAR_SEASON,
      SEASON_STATUS.PLAYOFFS,
      SEASON_STATUS.COMPLETE,
    ]) {
      const listed = everyHref(state(phase));
      for (const href of locked) expect(listed, href).toContain(href);
    }
    for (const phase of [null, SEASON_STATUS.SIGNUPS]) {
      const listed = everyHref(state(phase, DRAFT_STATUS.COMPLETE));
      for (const href of locked) expect(listed, href).not.toContain(href);
    }
  });

  it("keeps Scrims and the evergreen pages listed in every phase", () => {
    for (const s of allStates()) {
      const listed = everyHref(s);
      for (const href of [
        "/",
        "/players",
        "/inhouse",
        "/scrims",
        "/news",
        "/features",
        "/records",
        "/players/compare",
        "/hall-of-fame",
      ]) {
        expect(listed, href).toContain(href);
      }
    }
  });

  it("follows the season's own chapters in the primary row", () => {
    expect(hrefs(seasonNav(state(null)))).toEqual(["/", "/players", "/inhouse"]);
    expect(hrefs(seasonNav(state(SEASON_STATUS.SIGNUPS)))).toEqual([
      "/",
      "/players",
      "/inhouse",
    ]);
    expect(
      hrefs(seasonNav(state(SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS))),
    ).toEqual(["/", "/players", "/inhouse", "/teams", "/draft"]);
    expect(
      hrefs(seasonNav(state(SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE))),
    ).toEqual(["/", "/players", "/inhouse", "/teams", "/draft", "/schedule"]);
    expect(hrefs(seasonNav(state(SEASON_STATUS.PLAYOFFS)))).toEqual([
      "/",
      "/players",
      "/inhouse",
      "/teams",
      "/schedule",
    ]);
    expect(hrefs(seasonNav(state(SEASON_STATUS.COMPLETE)))).toEqual([
      "/",
      "/players",
      "/inhouse",
      "/teams",
      "/schedule",
      "/recap",
    ]);
  });

  it("puts My Team beside Teams, including a captain's team before the draft", () => {
    expect(
      seasonNav(state(SEASON_STATUS.REGULAR_SEASON), "team-1").slice(3, 5),
    ).toEqual([
      { href: "/teams", label: "Teams" },
      { href: "/teams/team-1", label: "My Team" },
    ]);
    expect(hrefs(seasonNav(state(SEASON_STATUS.SIGNUPS), "team-1"))).toEqual([
      "/",
      "/players",
      "/inhouse",
      "/teams/team-1",
    ]);
    expect(hrefs(seasonNav(state(SEASON_STATUS.PLAYOFFS)))).not.toContain(
      "/teams/team-1",
    );
  });

  it("lists statistics from the regular season and history once it exists", () => {
    for (const phase of [null, SEASON_STATUS.SIGNUPS, SEASON_STATUS.DRAFT]) {
      const listed = exploreHrefs(state(phase, DRAFT_STATUS.COMPLETE));
      expect(listed).not.toContain("/leaders");
      expect(listed).not.toContain("/meta");
    }
    expect(exploreHrefs(state(SEASON_STATUS.REGULAR_SEASON))).toEqual(
      expect.arrayContaining(["/leaders", "/meta"]),
    );
    expect(exploreHrefs(state(SEASON_STATUS.SIGNUPS))).not.toContain(
      "/seasons",
    );
    expect(exploreHrefs(state(SEASON_STATUS.SIGNUPS, null, true))).toContain(
      "/seasons",
    );
  });
});

describe("navigation surfaces", () => {
  const source = (file: string) =>
    readFileSync(path.resolve(process.cwd(), file), "utf8");
  const header = source("src/components/site-header.tsx");
  const footer = source("src/components/site-footer.tsx");

  // The header and footer used to keep their own page lists and phase-label
  // maps, and drifted into different names for the same page. They must read
  // both from the shared modules, never re-declare them.
  it("builds the header and footer from the shared list and phase label", () => {
    for (const [name, file] of [
      ["header", header],
      ["footer", footer],
    ] as const) {
      expect(file, name).toContain('from "@/lib/site-nav"');
      expect(file, name).toContain("seasonNav(");
      expect(file, name).toContain("exploreNav(");
      expect(file, name).toContain("seasonPhaseLabel(");
      expect(file, name).not.toMatch(/\blabel:\s*["'`]/);
      expect(file, name).not.toMatch(/PHASE_LABEL|PHASE_TONE/);
    }
  });
});
