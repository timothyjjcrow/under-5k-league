import { describe, expect, it } from "vitest";
import {
  ADMIN_SECTION_TAB,
  ADMIN_TABS,
  adminAnchorTarget,
  adminForwardHref,
  adminHref,
  adminTab,
} from "./admin-tabs";
import { MEDAL_APPROVALS_ANCHOR } from "./medal-approval";
import { adminMatchRowId } from "./match-anchors";

describe("the admin tabs", () => {
  it("are seven, each with its own path under /admin", () => {
    expect(ADMIN_TABS).toHaveLength(7);
    expect(new Set(ADMIN_TABS.map((tab) => tab.path)).size).toBe(7);
    expect(adminTab("overview").path).toBe("/admin");
    for (const tab of ADMIN_TABS.slice(1)) expect(tab.path).toMatch(/^\/admin\/[a-z]+$/);
  });

  it("place every card on a tab that exists", () => {
    const ids = new Set(ADMIN_TABS.map((tab) => tab.id));
    for (const [anchor, tab] of Object.entries(ADMIN_SECTION_TAB)) {
      expect(anchor).toMatch(/^adm-[a-z-]+$/);
      expect(ids.has(tab), anchor).toBe(true);
    }
  });

  it("spell the medal approvals anchor the way medal-approval.ts does", () => {
    expect(ADMIN_SECTION_TAB[MEDAL_APPROVALS_ANCHOR]).toBe("people");
  });
});

describe("adminHref", () => {
  it("links a card on the tab that renders it, with or without the #", () => {
    expect(adminHref("#adm-standins")).toBe("/admin/matches#adm-standins");
    expect(adminHref("adm-draft")).toBe("/admin/season#adm-draft");
    expect(adminHref("adm-signups")).toBe("/admin/people#adm-signups");
    expect(adminHref("adm-attention")).toBe("/admin#adm-attention");
    expect(adminHref(MEDAL_APPROVALS_ANCHOR)).toBe("/admin/people#adm-medal-approvals");
  });

  it("links a match's result row on Matches", () => {
    expect(adminHref(adminMatchRowId("m1"))).toBe("/admin/matches#adm-match-m1");
    // The bare prefix is not a row.
    expect(adminAnchorTarget("adm-match-")).toBeNull();
  });

  it("lands the one-page admin's retired anchors on the card that took over", () => {
    expect(adminHref("playoffs")).toBe("/admin/matches#adm-playoffs");
    expect(adminHref("adm-record")).toBe("/admin/matches#adm-schedule");
    // Captains & draft split into Draft (Season) and Teams and Signups
    // (People); an old link lands on the auction, and the phase card's
    // settings fold on the Settings card.
    expect(adminHref("adm-captains")).toBe("/admin/season#adm-draft");
    expect(adminHref("adm-season-settings")).toBe("/admin/season#adm-settings");
  });

  it("passes a path through, like the next step's draft room link", () => {
    expect(adminHref("/draft")).toBe("/draft");
  });

  it("leaves an id no card answers to on Overview", () => {
    expect(adminAnchorTarget("adm-nowhere")).toBeNull();
    expect(adminHref("adm-nowhere")).toBe("/admin#adm-nowhere");
  });
});

describe("adminForwardHref", () => {
  it("sends an old /admin#card link to the card's tab, keeping the query", () => {
    expect(adminForwardHref("", "#adm-medal-approvals")).toBe(
      "/admin/people#adm-medal-approvals",
    );
    expect(adminForwardHref("?newsPage=2", "#adm-news")).toBe(
      "/admin/discord?newsPage=2#adm-news",
    );
    expect(adminForwardHref("", "#adm-match-abc")).toBe("/admin/matches#adm-match-abc");
    expect(adminForwardHref("", "#playoffs")).toBe("/admin/matches#adm-playoffs");
  });

  it("stays put for Overview's own cards, an unknown id and no hash", () => {
    expect(adminForwardHref("", "#adm-attention")).toBeNull();
    expect(adminForwardHref("", "#adm-season")).toBeNull();
    expect(adminForwardHref("", "#something-else")).toBeNull();
    expect(adminForwardHref("", "")).toBeNull();
  });
});
