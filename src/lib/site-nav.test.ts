import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRAFT_STATUS,
  REGISTRATION_STATUS,
  SEASON_STATUS,
} from "./constants";
import {
  exploreNav,
  footerNav,
  joinSeasonCta,
  phoneDock,
  seasonNav,
  type NavLink,
  type NavState,
} from "./site-nav";

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
        ...footerNav(s),
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
      ["Leaders", "Hero meta", "Record book", "Compare players"],
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

describe("footer", () => {
  it("keeps a few essentials, never a page the menus don't also offer", () => {
    for (const s of allStates()) {
      const links = hrefs(footerNav(s));
      expect(links.length).toBeLessThanOrEqual(3);
      for (const href of links) expect(exploreHrefs(s)).toContain(href);
    }
    expect(hrefs(footerNav(state(SEASON_STATUS.SIGNUPS)))).toEqual([
      "/news",
      "/features",
    ]);
    expect(
      footerNav(state(SEASON_STATUS.REGULAR_SEASON, null, true)).map(
        (link) => link.label,
      ),
    ).toEqual(["League news", "Feature tour", "Season history"]);
  });
});

describe("join button during signups", () => {
  const signups = {
    phase: SEASON_STATUS.SIGNUPS,
    seasonName: "Season 7",
    signedIn: true,
    registrationStatus: null,
    onRoster: false,
  };

  it("sends a viewer who hasn't joined to the signup form, through sign-in if needed", () => {
    expect(joinSeasonCta(signups)).toEqual({
      href: "/me",
      label: "Join Season 7",
    });
    expect(
      joinSeasonCta({ ...signups, signedIn: false }),
    ).toEqual({ href: "/login?next=/me", label: "Join Season 7" });
    // A player who withdrew can sign up again.
    expect(
      joinSeasonCta({
        ...signups,
        registrationStatus: REGISTRATION_STATUS.WITHDRAWN,
      }),
    ).not.toBeNull();
  });

  it("stays away from players who joined, were removed, or are on a roster", () => {
    for (const registrationStatus of [
      REGISTRATION_STATUS.ACTIVE,
      REGISTRATION_STATUS.REMOVED,
    ]) {
      expect(joinSeasonCta({ ...signups, registrationStatus })).toBeNull();
    }
    expect(joinSeasonCta({ ...signups, onRoster: true })).toBeNull();
  });

  it("only runs during signups", () => {
    for (const phase of PHASES) {
      if (phase === SEASON_STATUS.SIGNUPS) continue;
      expect(joinSeasonCta({ ...signups, phase })).toBeNull();
      expect(joinSeasonCta({ ...signups, phase, signedIn: false })).toBeNull();
    }
  });

  it("falls back to a short label for a long season name", () => {
    expect(
      joinSeasonCta({ ...signups, seasonName: "Winter Championship 2027" })
        ?.label,
    ).toBe("Join the season");
  });
});

describe("phone tab bar and its sheet", () => {
  it("never lists a page both as a tab and in the sheet, and drops none", () => {
    for (const s of allStates()) {
      for (const myTeamId of [null, "team-1"]) {
        const items = seasonNav(s, myTeamId);
        const { tabs, sheet } = phoneDock(
          items,
          myTeamId ? `/teams/${myTeamId}` : null,
        );
        expect(tabs.length).toBeLessThanOrEqual(3);
        expect(tabs[0]).toMatchObject({ href: "/", label: "Home" });
        const tabHrefs = hrefs(tabs);
        expect(new Set(tabHrefs).size).toBe(tabHrefs.length);
        for (const href of hrefs(sheet)) {
          expect(tabHrefs, href).not.toContain(href);
        }
        expect([...tabHrefs, ...hrefs(sheet)].sort()).toEqual(
          hrefs(items).sort(),
        );
      }
    }
  });

  it("puts Join in the second slot during signups and moves that page to the sheet", () => {
    const signups = seasonNav(state(SEASON_STATUS.SIGNUPS));
    const join = { href: "/me", label: "Join Season 7" };
    const { tabs, sheet } = phoneDock(signups, null, join);
    expect(tabs).toEqual([
      { href: "/", label: "Home", icon: "home" },
      { href: "/me", label: "Join", ariaLabel: "Join Season 7", icon: "join" },
      { href: "/players", label: "Players", icon: "team" },
    ]);
    expect(hrefs(sheet)).toEqual(["/inhouse"]);
  });

  it("keeps the season's current focus and the viewer's team one tap away", () => {
    const signups = seasonNav(state(SEASON_STATUS.SIGNUPS));
    expect(hrefs(phoneDock(signups, null).tabs)).toEqual([
      "/",
      "/inhouse",
      "/players",
    ]);
    expect(phoneDock(signups, null).sheet).toEqual([]);

    const live = seasonNav(
      state(SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS),
    );
    expect(hrefs(phoneDock(live, null).tabs)).toEqual([
      "/",
      "/draft",
      "/teams",
    ]);
    expect(hrefs(phoneDock(live, null).sheet)).toEqual([
      "/players",
      "/inhouse",
    ]);

    const regular = seasonNav(state(SEASON_STATUS.REGULAR_SEASON), "team-1");
    const dock = phoneDock(regular, "/teams/team-1");
    expect(dock.tabs.map((tab) => tab.label)).toEqual([
      "Home",
      "Schedule",
      "My Team",
    ]);
    expect(dock.sheet.map((link) => link.label)).toEqual([
      "Players",
      "Inhouse",
      "Teams",
    ]);
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
      expect(file, name).toContain("seasonPhaseLabel(");
      expect(file, name).not.toMatch(/\blabel:\s*["'`]/);
      expect(file, name).not.toMatch(/PHASE_LABEL|PHASE_TONE/);
    }
    expect(header).toContain("seasonNav(");
    expect(header).toContain("exploreNav(");
    expect(footer).toContain("footerNav(");
    // The footer is no second site map.
    expect(footer).not.toContain("seasonNav(");
    expect(footer).not.toContain("exploreNav(");
  });

  // Phones had a ☰ menu, the tab bar's sheet and the footer listing the same
  // pages. The tab bar's sheet is now the only phone menu.
  it("gives phones one menu, built from the tab bar's leftovers", () => {
    expect(header).toContain("phoneDock(");
    expect(header).not.toContain("Open menu");
    expect(header).not.toContain('id="mobile-nav"');
  });
});
