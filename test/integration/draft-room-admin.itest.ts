import { describe, expect, it } from "vitest";
import {
  loadRegularSeasonStep,
  loadStartDraftPreflight,
} from "@/lib/draft-room-admin";
import { prisma } from "@/lib/prisma";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeTeam,
  startDraftState,
} from "./factories";

// The draft room's admin controls read their rows themselves (the admin
// panel has its own loader), so pin that they see the same state and build
// the same confirms as /admin.

async function setupSeason() {
  const season = await makeSeason({
    status: "SIGNUPS",
    teamSize: 3,
    minTeams: 3,
    budgetMmrWeight: 20,
    draftAt: new Date("2026-10-03T18:00:00.000Z"),
    draftRevision: 1,
  });
  const capA = await makeCaptain(season.id, "Cap A", 100, 0);
  const capB = await makeCaptain(season.id, "Cap B", 100, 1);
  const p1 = await makePlayer(season.id, "Pool One", 3000);
  await makePlayer(season.id, "Pool Two", 2800);
  await makePlayer(season.id, "Pool Three", 2600);
  await prisma.registration.update({
    where: { seasonId_userId: { seasonId: season.id, userId: p1.id } },
    data: { draftConfirmedRevision: 1, draftConfirmedAt: new Date() },
  });
  return { season, capA, capB, p1 };
}

describe("loadStartDraftPreflight", () => {
  it("builds the same Start draft confirm as the admin panel", async () => {
    const { season } = await setupSeason();
    const preflight = await loadStartDraftPreflight(season);
    expect(preflight).toEqual({
      canStart: true,
      blocker: null,
      confirm:
        "Start the draft with 2 captains? That is fewer than this season's 3-team target." +
        " 3 players for 4 open seats — 1 seat will go unfilled (standins cover them). Removing a captain would tighten it." +
        " Captains are locked once the auction begins — the way back is Abort draft, which returns every drafted player and refund and keeps the captains, but is refused once any result has been recorded." +
        " Draft confirmations: 1 of 5 ready; 4 awaiting. This is a warning only and does not block the draft." +
        " Unverified captain MMR sets draft budgets: Cap A (no medal), Cap B (no medal)." +
        " Cancel and check each with Edit medal & MMR first; a medal that matches the MMR marks it verified." +
        " Starting anyway is allowed.",
    });
  });

  it("refuses Start while a non-captain is already on a roster", async () => {
    const { season, capA, p1 } = await setupSeason();
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: capA.team.id,
        userId: p1.id,
        isCaptain: false,
        price: 5,
      },
    });
    const preflight = await loadStartDraftPreflight(season);
    expect(preflight?.canStart).toBe(false);
    expect(preflight?.blocker).toMatch(
      /^1 non-captain roster member is already assigned\./,
    );
  });

  it("offers nothing once the auction has started", async () => {
    const { season } = await setupSeason();
    await startDraftState(season.id);
    const current = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    expect(await loadStartDraftPreflight(current)).toBeNull();
  });
});

describe("loadRegularSeasonStep", () => {
  it("offers the Regular season phase button's confirm in the Draft phase", async () => {
    const season = await makeSeason({ status: "DRAFT" });
    expect(await loadRegularSeasonStep(season)).toEqual({
      confirmation:
        "Start the Regular season? League navigation and match tools update immediately, and Discord receives a league-start announcement.",
    });
  });

  it("offers nothing outside the Draft phase", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    expect(await loadRegularSeasonStep(season)).toBeNull();
  });

  it("offers nothing when the phase policy refuses the move", async () => {
    const season = await makeSeason({ status: "DRAFT" });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        homeTeamId: home.id,
        awayTeamId: away.id,
        week: 1,
        phase: "PLAYOFF",
        bracketSlot: "R1M1",
      },
    });
    expect(await loadRegularSeasonStep(season)).toBeNull();
  });
});
