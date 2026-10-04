import type { Match } from "@prisma/client";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SchedulePage from "@/app/schedule/page";
import type { SeasonSnapshot } from "@/lib/queries";
import { getActiveSeason } from "@/lib/season";
import { seasonHero } from "./season-view";
import { ThisWeek } from "./this-week";

const database = vi.hoisted(() => ({
  team: { findMany: vi.fn().mockResolvedValue([]) },
  match: { findMany: vi.fn().mockResolvedValue([]) },
  standinAssignment: { findMany: vi.fn().mockResolvedValue([]) },
  teamMember: { findMany: vi.fn().mockResolvedValue([]) },
  draft: { findUnique: vi.fn().mockResolvedValue(null) },
  rescheduleRequest: { findMany: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/prisma", () => ({ prisma: database }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/season", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/season")>()),
  getActiveSeason: vi.fn(),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
}));

const kickoff = new Date("2026-10-03T22:00:00Z");

function fixture(
  bracketSlot: string | null,
  status: string,
  phase = "PLAYOFF",
): Match {
  return {
    id: bracketSlot ?? "regular",
    seasonId: "season",
    week: 5,
    phase,
    homeTeamId: "home",
    awayTeamId: "away",
    scheduledAt: kickoff,
    scheduleRevision: 0,
    logisticsRevision: 0,
    status,
    homeScore: status === "COMPLETED" ? 2 : 0,
    awayScore: 0,
    bestOf: 3,
    winnerTeamId: status === "COMPLETED" ? "home" : null,
    bracketSlot,
    forfeit: false,
    autoSyncedAt: null,
    autoSyncAttempts: 0,
    completedAt: status === "COMPLETED" ? kickoff : null,
    createdAt: kickoff,
  };
}

function snapshot(status = "PLAYOFFS") {
  return {
    season: {
      id: "season",
      name: "Test season",
      status,
      teamSize: 5,
      playoffTeams: 4,
      championTeamId: null,
    },
    teams: [],
  } as unknown as SeasonSnapshot;
}

function renderHeroMeta(matches: Match[]) {
  return renderToStaticMarkup(
    seasonHero(
      snapshot(),
      {
        user: null,
        isActiveReg: false,
        isRemovedReg: false,
        captaining: false,
        standinRegistrationOpen: false,
      },
      matches,
      null,
    ).meta,
  );
}

async function renderSlate(matches: Match[], status = "PLAYOFFS") {
  return renderToStaticMarkup(
    await ThisWeek({
      season: snapshot(status).season,
      matches,
      teams: [],
      teamName: new Map([
        ["home", "w4tkins's Team"],
        ["away", "Bad Boys of Dota"],
      ]),
      teamLogoUrl: new Map(),
      report: null,
      showCheckins: false,
      myPicks: null,
      pickemPlayable: false,
    }),
  );
}

describe("Home's playoff presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSeason).mockResolvedValue(null);
    database.team.findMany.mockResolvedValue([]);
    database.match.findMany.mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  });

  afterEach(() => vi.useRealTimers());

  const semifinals = () => [
    fixture("R0M0", "COMPLETED"),
    fixture("R0M1", "COMPLETED"),
  ];

  it("does not say a scheduled grand final is underway", () => {
    const html = renderHeroMeta([
      ...semifinals(),
      fixture("R1M0", "SCHEDULED", "FINAL"),
    ]);
    expect(html).toContain(">Grand final</span>");
    expect(html).not.toContain("underway");
  });

  it("marks a live grand final as underway", () => {
    expect(
      renderHeroMeta([...semifinals(), fixture("R1M0", "LIVE", "FINAL")]),
    ).toContain(">Grand final underway</span>");
  });

  it("reads live status from the earliest open round", () => {
    const html = renderHeroMeta([
      fixture("R0M0", "COMPLETED"),
      fixture("R0M1", "SCHEDULED"),
      fixture("R1M0", "LIVE", "FINAL"),
    ]);
    expect(html).toContain(">Semifinals</span>");
    expect(html).not.toContain("underway");
  });

  it("shows no round badge once every playoff result is recorded", () => {
    expect(
      renderHeroMeta([
        ...semifinals(),
        fixture("R1M0", "COMPLETED", "FINAL"),
      ]),
    ).not.toContain("Grand final");
  });

  it("takes the featured final's Full schedule link to the playoff section", async () => {
    const html = await renderSlate([
      ...semifinals(),
      fixture("R1M0", "SCHEDULED", "FINAL"),
    ]);
    expect(html).toContain("The grand final");
    expect(html).toMatch(/href="\/schedule#playoff-bracket"[^>]*>Full schedule/);
  });

  it("renders the scheduled final inside the real schedule destination", async () => {
    vi.mocked(getActiveSeason).mockResolvedValue(snapshot().season);
    database.team.findMany.mockResolvedValue([
      { id: "home", name: "w4tkins's Team", logoUrl: null, withdrawn: false },
      { id: "away", name: "Bad Boys of Dota", logoUrl: null, withdrawn: false },
    ]);
    database.match.findMany.mockResolvedValue([
      ...semifinals(),
      fixture("R1M0", "SCHEDULED", "FINAL"),
    ]);
    const page = await SchedulePage();
    const destination = Children.toArray(page.props.children).find(
      (child) =>
        isValidElement<{ id?: string }>(child) &&
        child.type === "section" &&
        child.props.id === "playoff-bracket",
    );
    expect(destination).toBeDefined();
    const html = renderToStaticMarkup(destination);
    expect(html).toContain('id="playoff-bracket"');
    expect(html).toContain("Grand final");
    expect(html).toContain('href="/matches/R1M0"');
    expect(html).toContain("w4tkins&#x27;s Team");
    expect(html).toContain("Bad Boys of Dota");
    expect(html).toContain(`dateTime="${kickoff.toISOString()}"`);
    expect(html).toContain("Upcoming");
    // The phone round list renders the final too, outside the wide bracket.
    expect(html).toMatch(
      /<article\b[^>]*aria-label="w4tkins&#x27;s Team vs Bad Boys of Dota · Upcoming"/,
    );
  });

  it("takes an earlier playoff slate to the same playoff section", async () => {
    expect(await renderSlate([fixture("R0M0", "SCHEDULED")])).toMatch(
      /href="\/schedule#playoff-bracket"[^>]*>Full schedule/,
    );
  });

  it("keeps a regular-season slate linked to regular fixtures", async () => {
    expect(
      await renderSlate(
        [fixture(null, "SCHEDULED", "REGULAR")],
        "REGULAR_SEASON",
      ),
    ).toMatch(/href="\/schedule#fixtures"[^>]*>Full schedule/);
  });
});
