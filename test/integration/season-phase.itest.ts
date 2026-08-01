import { afterEach, describe, expect, it, vi } from "vitest";

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
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { setSeasonPhase, startDraft } from "@/app/actions/admin";
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

describe("setSeasonPhase — the backward-into-DRAFT guard doesn't need a COMPLETE draft row", () => {
  // The first version keyed the results refusal on `draft?.status === COMPLETE`,
  // so the two shapes where DRAFT is MOST dangerous walked straight past it: a
  // hand-run league with no Draft row at all, and a post-abort NOT_STARTED row.
  // Both make Start draft UI-enabled over a played league — and until startDraft
  // grew its own results guard, that click was a trap with no exit (abortDraft
  // refuses over results; setSeasonPhase refuses to leave DRAFT mid-auction).
  async function playedSeason(draftStatus: string | null) {
    const season = await makeSeason({
      teamSize: 3,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const a = await makeTeam(season.id, "Alpha", 0);
    const b = await makeTeam(season.id, "Bravo", 1);
    if (draftStatus) {
      await prisma.draft.create({
        data: { seasonId: season.id, status: draftStatus },
      });
    }
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
    return season;
  }

  it("refuses over results with NO draft row (the hand-run league)", async () => {
    const season = await playedSeason(null);
    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.DRAFT));
    expect(res?.error).toMatch(/results are already recorded/i);
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.REGULAR_SEASON);
  });

  it("refuses over results with a NOT_STARTED draft row (post-abort)", async () => {
    const season = await playedSeason(DRAFT_STATUS.NOT_STARTED);
    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.DRAFT));
    expect(res?.error).toMatch(/results are already recorded/i);
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.REGULAR_SEASON);
  });

  it("still allows DRAFT as the REPAIR for a stranded live auction, results or not", async () => {
    // A draft IN_PROGRESS with the season outside DRAFT is the race state the
    // guarded phase write exists for; moving back INTO Draft restores
    // consistency and must not be refused by the results guard.
    const season = await playedSeason(DRAFT_STATUS.IN_PROGRESS);
    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.DRAFT));
    expect(res?.error).toBeUndefined();
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.DRAFT);
  });
});

describe("startDraft — results-blind no more", () => {
  it("refuses to open an auction over a league with recorded results", async () => {
    // Reached via the phase buttons: season walked into DRAFT with no Draft row,
    // two captains standing, pool available — the exact state where the old
    // action opened a live auction over a played league and the trap closed.
    const season = await makeSeason({
      teamSize: 3,
      status: SEASON_STATUS.DRAFT,
    });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    await makePlayer(season.id, "Pool Player", 3000);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: capA.team.id,
        awayTeamId: capB.team.id,
        bestOf: 2,
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 0,
        winnerTeamId: capA.team.id,
      },
    });

    const res = await startDraft({}, new FormData());

    expect(res?.error).toMatch(/results are already recorded/i);
    expect(
      await prisma.draft.findUnique({ where: { seasonId: season.id } }),
    ).toBeNull();
  });

  it("refuses on an imported game alone, before any series is decided", async () => {
    const season = await makeSeason({
      teamSize: 3,
      status: SEASON_STATUS.DRAFT,
    });
    const capA = await makeCaptain(season.id, "Captain A", 100, 0);
    const capB = await makeCaptain(season.id, "Captain B", 100, 1);
    await makePlayer(season.id, "Pool Player", 3000);
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: capA.team.id,
        awayTeamId: capB.team.id,
        bestOf: 3,
        status: MATCH_STATUS.LIVE,
        homeScore: 1,
        awayScore: 0,
      },
    });
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: "8333333333",
        radiantWin: true,
        winnerTeamId: capA.team.id,
        players: "[]",
      },
    });

    const res = await startDraft({}, new FormData());

    expect(res?.error).toMatch(/results are already recorded/i);
    expect(
      await prisma.draft.findUnique({ where: { seasonId: season.id } }),
    ).toBeNull();
  });
});

describe("setSeasonPhase — the write re-asserts the phase it judged", () => {
  it("two concurrent flips to different targets: exactly one wins", async () => {
    // The claim is the enforcement, not the read-time guards: both calls read
    // SIGNUPS, both pass their guards, and the WHERE {status: as-read} lets
    // exactly one land. Meaningful on SQLite already (no transaction involved,
    // so the reads interleave ahead of the serialized writes); real contention
    // under `npm run test:pg`.
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    await makeTeam(season.id, "Alpha", 0);
    await makeTeam(season.id, "Bravo", 1);

    const [a, b] = await Promise.all([
      setSeasonPhase({}, phaseForm(SEASON_STATUS.DRAFT)),
      setSeasonPhase({}, phaseForm(SEASON_STATUS.REGULAR_SEASON)),
    ]);

    // TWO legal schedules exist, and a slow runner produces either — the
    // first version asserted "exactly one winner" and flaked CI's mutation
    // shard when Promise.all happened to SEQUENCE the calls:
    //  * concurrent reads: both see SIGNUPS, the claim lets exactly one land,
    //    the loser reads "just changed".
    //  * sequential visibility: B reads AFTER A commits, so B's guards judge
    //    DRAFT and its claim re-asserts DRAFT — both succeed as the valid
    //    chain SIGNUPS→DRAFT→REGULAR_SEASON.
    // What the guarded write actually forbids — and what the old blind write
    // allowed — is a THIRD shape: both succeed off the same stale read and
    // the final phase is whichever write happened to land last (B's flip
    // silently overwritten). The assertions below hold in both legal
    // schedules and fail that one.
    const errors = [a, b].filter((r) => r?.error);
    const wins = [a, b].filter((r) => r?.message);
    expect(wins.length).toBeGreaterThanOrEqual(1);
    expect(wins.length + errors.length).toBe(2);
    const finalStatus = await statusOf(season.id);
    if (wins.length === 1) {
      expect(errors[0]?.error).toMatch(/just changed|already in/i);
      // The final phase is the winner's target, never a blend.
      expect(finalStatus).toBe(
        wins[0]?.message?.includes("Draft")
          ? SEASON_STATUS.DRAFT
          : SEASON_STATUS.REGULAR_SEASON,
      );
    } else {
      // Both won ⇒ B's claim can only have matched DRAFT, i.e. A committed
      // first and B saw it — the season MUST end at B's target. Ending at
      // DRAFT with two successes is exactly the lost-update the claim exists
      // to prevent.
      expect(finalStatus).toBe(SEASON_STATUS.REGULAR_SEASON);
    }
  });
});

describe("setSeasonPhase — the claim is what makes a stale flip lose", () => {
  afterEach(() => setRaceHook(null));

  it("a rival phase change in the gap wins; the stale write is refused", async () => {
    // Deterministic where the raced version can't be: BOTH orderings of two
    // concurrent flips are legal, so only a seam pins the claim. Here the
    // rival commits between the guards and the write — the blind update this
    // replaced would stamp REGULAR_SEASON over it and silently eat the other
    // admin's move.
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    await makeTeam(season.id, "Alpha", 0);
    await makeTeam(season.id, "Bravo", 1);
    let fired = false;
    setRaceHook(
      onceAt("admin.setSeasonPhase.beforeWrite", async () => {
        fired = true;
        await prisma.season.update({
          where: { id: season.id },
          data: { status: SEASON_STATUS.DRAFT },
        });
      }),
    );

    const res = await setSeasonPhase({}, phaseForm(SEASON_STATUS.REGULAR_SEASON));

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/just changed/i);
    // The rival's DRAFT stands — not overwritten by the stale REGULAR_SEASON.
    expect(await statusOf(season.id)).toBe(SEASON_STATUS.DRAFT);
  });
});
