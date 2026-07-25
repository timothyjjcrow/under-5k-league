import { describe, expect, it, vi } from "vitest";

// setSeasonPhase is the single most consequential admin control — it decides what
// the whole site shows and which engines run — and it had no integration coverage.
// It is a server action, so stub the request-scope bits to drive it against the DB.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import { setSeasonPhase } from "@/app/actions/admin";
import { pauseDraft } from "@/lib/draft-service";
import { nominatePlayer } from "@/lib/draft-service";
import { DRAFT_STATUS, MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeTeam,
  makeUser,
  sessionFor,
  startDraftState,
} from "./factories";

function phaseForm(phase: string): FormData {
  const fd = new FormData();
  fd.set("phase", phase);
  return fd;
}

async function statusOf(seasonId: string) {
  return (await prisma.season.findUniqueOrThrow({ where: { id: seasonId } })).status;
}

describe("setSeasonPhase — an unfinished auction can't be stranded", () => {
  it("refuses to leave DRAFT while the auction is LIVE", async () => {
    const season = await makeSeason({ teamSize: 3, status: SEASON_STATUS.DRAFT });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 4000);
    await startDraftState(season.id);
    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 4);

    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.REGULAR_SEASON));

    expect(res?.error).toMatch(/auction is live/i);
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.DRAFT);
  });

  it("refuses to leave DRAFT while the auction is PAUSED — parked is not finished", async () => {
    // The admin who pauses to settle a sale dispute is exactly the one who then
    // reaches for the phase buttons. Letting PAUSED through left the season
    // outside DRAFT with half-built rosters and no auction the panel could finish.
    const season = await makeSeason({ teamSize: 3, status: SEASON_STATUS.DRAFT });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 4000);
    const admin = sessionFor(await makeUser("Boss", "ADMIN"));
    await startDraftState(season.id);
    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 4);
    expect((await pauseDraft(season.id, admin)).ok).toBe(true);

    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.REGULAR_SEASON));

    expect(res?.error).toMatch(/paused, not finished/i);
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.DRAFT);
  });

  it("still lets a PAUSED auction stay in DRAFT (the escape is resume, not a phase flip)", async () => {
    const season = await makeSeason({ teamSize: 3, status: SEASON_STATUS.SIGNUPS });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    const star = await makePlayer(season.id, "Star", 4000);
    const admin = sessionFor(await makeUser("Boss", "ADMIN"));
    await startDraftState(season.id); // sets DRAFT
    await nominatePlayer(season.id, sessionFor(capA.user), star.id, 4);
    await pauseDraft(season.id, admin);

    // Targeting DRAFT itself is refused only because it's already there…
    const same = await setSeasonPhase({}, phaseForm(SEASON_STATUS.DRAFT));
    expect(same?.error).toMatch(/already in/i);
    // …and the paused auction is untouched either way.
    const draft = await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } });
    expect(draft.status).toBe(DRAFT_STATUS.PAUSED);
    expect(draft.nominatedUserId).toBe(star.id);
  });

  it("allows the flip once the auction is COMPLETE", async () => {
    const season = await makeSeason({ teamSize: 3, status: SEASON_STATUS.DRAFT });
    await makeCaptain(season.id, "Captain A", 100, 0);
    await startDraftState(season.id);
    await prisma.draft.update({
      where: { seasonId: season.id },
      data: { status: DRAFT_STATUS.COMPLETE, nominatedUserId: null, bidEndsAt: null },
    });

    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.REGULAR_SEASON));

    expect(res?.error).toBeUndefined();
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.REGULAR_SEASON);
  });
});

describe("setSeasonPhase — an unfinished bracket can't be stranded", () => {
  it("refuses to leave PLAYOFFS while a bracket match is unplayed", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.PLAYOFFS });
    const a = await makeTeam(season.id, "Alpha", 0);
    const b = await makeTeam(season.id, "Bravo", 1);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 5,
        phase: MATCH_PHASE.FINAL,
        homeTeamId: a.id,
        awayTeamId: b.id,
        bracketSlot: "R0M0",
        bestOf: 3,
        status: MATCH_STATUS.SCHEDULED,
      },
    });

    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.REGULAR_SEASON));

    expect(res?.error).toMatch(/bracket is still running/i);
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.PLAYOFFS);
  });

  it("permits PLAYOFFS -> COMPLETE even mid-bracket (the deliberate close-out escape)", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.PLAYOFFS });
    const a = await makeTeam(season.id, "Alpha", 0);
    const b = await makeTeam(season.id, "Bravo", 1);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 5,
        phase: MATCH_PHASE.FINAL,
        homeTeamId: a.id,
        awayTeamId: b.id,
        bracketSlot: "R0M0",
        bestOf: 3,
        status: MATCH_STATUS.SCHEDULED,
      },
    });

    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.COMPLETE));

    expect(res?.error).toBeUndefined();
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.COMPLETE);
  });
});

describe("setSeasonPhase — basic contract", () => {
  it("rejects a phase that isn't in the state machine", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    const res = await setSeasonPhase({}, phaseForm("BANANA"));
    expect(res?.error).toMatch(/invalid phase/i);
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.SIGNUPS);
  });

  it("rejects a no-op flip to the current phase", async () => {
    await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.SIGNUPS));
    expect(res?.error).toMatch(/already in/i);
  });

  it("errors clearly when there is no active season", async () => {
    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.DRAFT));
    expect(res?.error).toMatch(/no active season/i);
  });
});

describe("setSeasonPhase — a finished draft can't be reopened over a live league", () => {
  // Walking backward into DRAFT re-arms the auction engine: undoLastSaleAction's
  // only gate is `season.status === DRAFT`, and it deletes the newest non-captain
  // roster row and forces the draft to IN_PROGRESS with a fresh clock — after
  // which resolveStalledNomination auto-sells an undrafted signup onto a
  // mid-season roster on the next /draft poll from any visitor.
  async function midSeason() {
    const season = await makeSeason({
      teamSize: 3,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const a = await makeTeam(season.id, "Alpha", 0);
    const b = await makeTeam(season.id, "Bravo", 1);
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });
    return { season, a, b };
  }

  it("refuses REGULAR_SEASON -> DRAFT once a result is recorded", async () => {
    const { season, a, b } = await midSeason();
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: a.id,
        awayTeamId: b.id,
        bestOf: 2,
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 0,
        winnerTeamId: a.id,
      },
    });

    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.DRAFT));

    expect(res?.error).toMatch(/results are already recorded/i);
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.REGULAR_SEASON);
  });

  it("still allows the flip back when nothing has been played yet (a genuine redo)", async () => {
    const { season, a, b } = await midSeason();
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: a.id,
        awayTeamId: b.id,
        bestOf: 2,
        status: MATCH_STATUS.SCHEDULED,
      },
    });

    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.DRAFT));

    expect(res?.error).toBeUndefined();
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.DRAFT);
  });

  it("refuses from PLAYOFFS too, not just REGULAR_SEASON", async () => {
    const { season, a, b } = await midSeason();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.PLAYOFFS },
    });
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: a.id,
        awayTeamId: b.id,
        bestOf: 2,
        status: MATCH_STATUS.COMPLETED,
        winnerTeamId: a.id,
      },
    });

    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.DRAFT));

    expect(res?.error).toMatch(/results are already recorded/i);
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.PLAYOFFS);
  });

  it("refuses when a game is IMPORTED but no series has been decided yet", async () => {
    // The window the first version of this guard missed: auto-sync makes "one
    // series LIVE at 1-0" a routine state on opening night, and recomputeSeries
    // leaves an undecided series LIVE — so counting only COMPLETED left the
    // auction re-armable for exactly the hours everyone is watching.
    const { season, a, b } = await midSeason();
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: a.id,
        awayTeamId: b.id,
        bestOf: 3,
        status: MATCH_STATUS.LIVE,
        homeScore: 1,
        awayScore: 0,
      },
    });
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: "8222222222",
        radiantWin: true,
        winnerTeamId: a.id,
        players: "[]",
      },
    });
    expect(
      await prisma.match.count({
        where: { seasonId: season.id, status: MATCH_STATUS.COMPLETED },
      }),
    ).toBe(0); // nothing decided — the old guard saw zero and allowed it

    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.DRAFT));

    expect(res?.error).toMatch(/results are already recorded/i);
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.REGULAR_SEASON);
  });
});
