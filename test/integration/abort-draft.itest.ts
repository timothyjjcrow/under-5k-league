import { describe, expect, it, vi } from "vitest";

// abortDraft is the escape hatch for the league's one unrecoverable mistake:
// startDraft is a one-way door (nothing else ever writes Draft.status back to
// NOT_STARTED), so starting with the wrong captains used to cap the season
// forever. These tests pin both the teardown and the guard that stops it being
// used as a mid-season roster tool.
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
import { abortDraft, undoLastSale } from "@/lib/draft-service";
import { addCaptain, startDraft } from "@/app/actions/admin";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
  runDraftToCompletion,
  sessionFor,
  startDraftState,
} from "./factories";

const admin = () => makeUser("Boss", "ADMIN").then(sessionFor);

/** A season mid-auction with two captains and a pool, the premature-start state. */
async function prematureStart(teamSize = 3) {
  const season = await makeSeason({
    teamSize,
    minTeams: 6,
    status: SEASON_STATUS.SIGNUPS,
  });
  const a = await makeCaptain(season.id, "Captain A", 100, 0);
  const b = await makeCaptain(season.id, "Captain B", 100, 1);
  const pool = [];
  for (let i = 0; i < 6; i++)
    pool.push(await makePlayer(season.id, `Pool ${i}`, 2000 + i * 100));
  await startDraftState(season.id); // sets DRAFT + IN_PROGRESS
  return { season, a, b, pool };
}

describe("abortDraft — the way back from a premature Start draft", () => {
  it("returns the season to SIGNUPS with captains and teams intact", async () => {
    const { season, a, b } = await prematureStart();

    const res = await abortDraft(season.id, await admin());

    expect(res.ok).toBe(true);
    const fresh = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
    expect(fresh.status).toBe(SEASON_STATUS.SIGNUPS);
    const draft = await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } });
    expect(draft.status).toBe(DRAFT_STATUS.NOT_STARTED);
    expect(draft.nominatedUserId).toBeNull();
    expect(draft.bidEndsAt).toBeNull();
    expect(draft.nominationEndsAt).toBeNull();
    expect(draft.currentBid).toBe(0);
    expect(draft.currentBidTeamId).toBeNull();
    // Teams and their captains survive — that is the whole point.
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(2);
    const captains = await prisma.teamMember.findMany({
      where: { seasonId: season.id },
    });
    expect(captains).toHaveLength(2);
    expect(captains.every((m) => m.isCaptain)).toBe(true);
    expect([a.team.id, b.team.id].sort()).toEqual(
      captains.map((m) => m.teamId).sort(),
    );
  });

  it("unlocks captain management again, so the real fix is possible", async () => {
    const { season } = await prematureStart();
    const late = await makePlayer(season.id, "Late Captain", 3000, {
      wantsCaptain: true,
    });

    // Before the abort, the whole reason this exists: captains are locked.
    const blocked = await addCaptain({}, formWith({ userId: late.id }));
    expect(blocked?.error).toMatch(/draft has started/i);

    await abortDraft(season.id, await admin());

    const allowed = await addCaptain({}, formWith({ userId: late.id }));
    expect(allowed?.error).toBeUndefined();
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(3);
  });

  it("lets the draft be started again afterwards", async () => {
    const { season } = await prematureStart();
    await abortDraft(season.id, await admin());

    const res = await startDraft({}, new FormData());

    expect(res?.error).toBeUndefined();
    const draft = await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } });
    expect(draft.status).toBe(DRAFT_STATUS.IN_PROGRESS);
    const fresh = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
    expect(fresh.status).toBe(SEASON_STATUS.DRAFT);
  });

  it("returns bought players to the pool and refunds exactly what was spent", async () => {
    const { season, a } = await prematureStart();
    // Two real purchases at different prices on the same team.
    const [p1, p2] = await prisma.registration.findMany({
      where: { seasonId: season.id, wantsCaptain: false },
      take: 2,
    });
    await prisma.teamMember.createMany({
      data: [
        { seasonId: season.id, teamId: a.team.id, userId: p1.userId, price: 30 },
        { seasonId: season.id, teamId: a.team.id, userId: p2.userId, price: 12 },
      ],
    });
    await prisma.team.update({ where: { id: a.team.id }, data: { budget: 58 } });

    const res = await abortDraft(season.id, await admin());

    expect(res).toMatchObject({ ok: true, playersReturned: 2, budgetRestored: 42 });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: a.team.id } });
    expect(team.budget).toBe(100); // 58 + 30 + 12, back to the starting budget
    const rostered = await prisma.teamMember.findMany({
      where: { seasonId: season.id, isCaptain: false },
    });
    expect(rostered).toHaveLength(0);
    // The registrations are untouched, so those players are draftable again.
    const stillActive = await prisma.registration.count({
      where: { seasonId: season.id, status: "ACTIVE" },
    });
    expect(stillActive).toBeGreaterThanOrEqual(2);
  });

  it("restores MMR-weighted budgets correctly (credits spend, not a flat reset)", async () => {
    // Budgets differ per captain by design (mmrWeightedBudgets), so there is no
    // single figure to reset to — the abort must credit back actual spend.
    const { season, a, b } = await prematureStart();
    await prisma.team.update({ where: { id: a.team.id }, data: { budget: 108 } });
    await prisma.team.update({ where: { id: b.team.id }, data: { budget: 92 } });
    const [p1] = await prisma.registration.findMany({
      where: { seasonId: season.id, wantsCaptain: false },
      take: 1,
    });
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: a.team.id, userId: p1.userId, price: 25 },
    });
    await prisma.team.update({ where: { id: a.team.id }, data: { budget: 83 } });

    await abortDraft(season.id, await admin());

    expect((await prisma.team.findUniqueOrThrow({ where: { id: a.team.id } })).budget).toBe(108);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: b.team.id } })).budget).toBe(92);
  });

  it("clears the bid audit trail so a re-run auction doesn't replay old prices", async () => {
    const { season, a } = await prematureStart();
    const draft = await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } });
    const [p1] = await prisma.registration.findMany({
      where: { seasonId: season.id, wantsCaptain: false },
      take: 1,
    });
    await prisma.bid.create({
      data: {
        draftId: draft.id,
        seasonId: season.id,
        teamId: a.team.id,
        userId: p1.userId,
        amount: 57,
      },
    });

    await abortDraft(season.id, await admin());

    expect(await prisma.bid.count({ where: { draftId: draft.id } })).toBe(0);
  });

  it("works from a PAUSED auction and from a COMPLETE draft", async () => {
    for (const status of [DRAFT_STATUS.PAUSED, DRAFT_STATUS.COMPLETE]) {
      const { season } = await prematureStart();
      await prisma.draft.update({
        where: { seasonId: season.id },
        data: { status, nominatedUserId: null, bidEndsAt: null },
      });

      const res = await abortDraft(season.id, await admin());

      expect(res.ok, status).toBe(true);
      const draft = await prisma.draft.findUniqueOrThrow({
        where: { seasonId: season.id },
      });
      expect(draft.status, status).toBe(DRAFT_STATUS.NOT_STARTED);
    }
  });

  it("aborts a fully-completed auction, clearing every roster it built", async () => {
    const season = await makeSeason({ teamSize: 3, status: SEASON_STATUS.SIGNUPS });
    await makeCaptain(season.id, "Captain A", 100, 0);
    await makeCaptain(season.id, "Captain B", 100, 1);
    for (let i = 0; i < 6; i++) await makePlayer(season.id, `P${i}`, 2000 + i * 50);
    await startDraftState(season.id);
    await runDraftToCompletion(season.id);
    const before = await prisma.teamMember.count({
      where: { seasonId: season.id, isCaptain: false },
    });
    expect(before).toBeGreaterThan(0);

    const res = await abortDraft(season.id, await admin());

    expect(res.ok).toBe(true);
    expect(
      await prisma.teamMember.count({ where: { seasonId: season.id, isCaptain: false } }),
    ).toBe(0);
  });
});

describe("abortDraft — guards", () => {
  it("refuses a non-admin", async () => {
    const { season } = await prematureStart();
    const player = sessionFor(await makeUser("Nobody"));
    const res = await abortDraft(season.id, player);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/admins only/i);
    const draft = await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } });
    expect(draft.status).toBe(DRAFT_STATUS.IN_PROGRESS);
  });

  it("refuses when the draft never started", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.NOT_STARTED },
    });
    const res = await abortDraft(season.id, await admin());
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/hasn't started/i);
  });

  it("refuses when there is no draft row at all", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    const res = await abortDraft(season.id, await admin());
    expect(res).toMatchObject({ ok: false });
  });

  it("REFUSES once a match result is recorded — rosters are load-bearing by then", async () => {
    const { season, a, b } = await prematureStart();
    await prisma.draft.update({
      where: { seasonId: season.id },
      data: { status: DRAFT_STATUS.COMPLETE, nominatedUserId: null, bidEndsAt: null },
    });
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: a.team.id,
        awayTeamId: b.team.id,
        bestOf: 2,
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        winnerTeamId: a.team.id,
      },
    });

    const res = await abortDraft(season.id, await admin());

    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/results are already recorded/i);
    const draft = await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } });
    expect(draft.status).toBe(DRAFT_STATUS.COMPLETE); // untouched
  });

  it("REFUSES once a game is imported, even with no completed match (partial series)", async () => {
    const { season, a, b } = await prematureStart();
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: a.team.id,
        awayTeamId: b.team.id,
        bestOf: 3,
        status: MATCH_STATUS.LIVE,
      },
    });
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: "8123456789",
        radiantWin: true,
        winnerTeamId: a.team.id,
        players: "[]",
      },
    });

    const res = await abortDraft(season.id, await admin());

    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/results are already recorded/i);
  });

  it("is idempotent under a double-click — the second call is refused, not a second teardown", async () => {
    const { season, a } = await prematureStart();
    const [p1] = await prisma.registration.findMany({
      where: { seasonId: season.id, wantsCaptain: false },
      take: 1,
    });
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: a.team.id, userId: p1.userId, price: 20 },
    });
    await prisma.team.update({ where: { id: a.team.id }, data: { budget: 80 } });
    const boss = await admin();

    const first = await abortDraft(season.id, boss);
    const second = await abortDraft(season.id, boss);

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false });
    // Budget credited exactly once.
    expect((await prisma.team.findUniqueOrThrow({ where: { id: a.team.id } })).budget).toBe(100);
  });

  it("does not touch another season's draft or rosters", async () => {
    const { season } = await prematureStart();
    const other = await makeSeason({ name: "Other", isActive: false, teamSize: 3 });
    const oc = await makeCaptain(other.id, "Other Captain", 100, 0);
    const op = await makePlayer(other.id, "Other Player", 2500);
    await prisma.teamMember.create({
      data: { seasonId: other.id, teamId: oc.team.id, userId: op.id, price: 15 },
    });
    await prisma.draft.create({
      data: { seasonId: other.id, status: DRAFT_STATUS.COMPLETE },
    });

    await abortDraft(season.id, await admin());

    expect(await prisma.teamMember.count({ where: { seasonId: other.id } })).toBe(2);
    const otherDraft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: other.id },
    });
    expect(otherDraft.status).toBe(DRAFT_STATUS.COMPLETE);
  });
});

function formWith(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

// "Undo last sale" used to target "the newest non-captain roster row", which is
// not the same thing as the newest SALE. A pool-dry draft leaves the season in
// DRAFT, where Sign free agent is legal — so undoing a disputed lot deleted the
// $0 signing instead: nothing refunded, the disputed sale still standing, and the
// auction re-opened anyway. price > 0 is an exact discriminator (auction rows are
// created at draft.currentBid, floored at MIN_BID=1; signFreeAgent hard-codes 0).
describe("undoLastSale — only ever reverts an actual auction purchase", () => {
  /** Pool-dry finish: draft COMPLETE while the season is still in DRAFT. */
  async function poolDryWithSale() {
    const season = await makeSeason({
      teamSize: 3,
      status: SEASON_STATUS.DRAFT,
    });
    const a = await makeCaptain(season.id, "Captain A", 100, 0);
    const b = await makeCaptain(season.id, "Captain B", 100, 1);
    const sold = await makePlayer(season.id, "Sold Player", 4000);
    // A real auction purchase, backdated so later rows are newer.
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: a.team.id,
        userId: sold.id,
        price: 57,
        isCaptain: false,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.team.update({ where: { id: a.team.id }, data: { budget: 43 } });
    await prisma.draft.create({
      data: {
        seasonId: season.id,
        status: DRAFT_STATUS.COMPLETE,
        nominatorTeamId: b.team.id,
        nominationIndex: 1,
      },
    });
    return { season, a, b, sold };
  }

  it("skips a newer free-agent signing and reverts the real sale instead", async () => {
    const { season, a, b, sold } = await poolDryWithSale();
    const late = await makePlayer(season.id, "Late Joiner", 2000);
    // signFreeAgent's shape: price 0, created AFTER the sale.
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: b.team.id, userId: late.id, price: 0 },
    });

    const res = await undoLastSale(season.id, await admin());

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.player).toBe("Sold Player");
      expect(res.price).toBe(57);
    }
    // The signing is untouched…
    const signing = await prisma.teamMember.findFirst({
      where: { seasonId: season.id, userId: late.id },
    });
    expect(signing).not.toBeNull();
    expect(signing?.price).toBe(0);
    // …and the real sale was reverted, with the money actually returned.
    expect(
      await prisma.teamMember.findFirst({ where: { seasonId: season.id, userId: sold.id } }),
    ).toBeNull();
    expect((await prisma.team.findUniqueOrThrow({ where: { id: a.team.id } })).budget).toBe(100);
  });

  it("refuses with signing-specific guidance when there are no sales at all", async () => {
    const season = await makeSeason({ teamSize: 3, status: SEASON_STATUS.DRAFT });
    const a = await makeCaptain(season.id, "Captain A", 100, 0);
    const late = await makePlayer(season.id, "Late Joiner", 2000);
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: a.team.id, userId: late.id, price: 0 },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });

    const res = await undoLastSale(season.id, await admin());

    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/free-agent signings.*Use Release/i);
    // Nothing was deleted and no budget moved.
    expect(await prisma.teamMember.count({ where: { seasonId: season.id } })).toBe(2);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: a.team.id } })).budget).toBe(100);
  });

  it("still says plain 'No sale to undo' on an empty roster", async () => {
    const season = await makeSeason({ teamSize: 3, status: SEASON_STATUS.DRAFT });
    await makeCaptain(season.id, "Captain A", 100, 0);
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });

    const res = await undoLastSale(season.id, await admin());

    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/^No sale to undo$/);
  });

  it("never targets a captain row, even one carrying a price after a transfer", async () => {
    // transferCaptaincy only flips isCaptain, so a player bought at $57 and then
    // promoted keeps that price — undo must not strip a team of its captain.
    const { season, a, sold } = await poolDryWithSale();
    await prisma.teamMember.updateMany({
      where: { seasonId: season.id, userId: sold.id },
      data: { isCaptain: true },
    });

    const res = await undoLastSale(season.id, await admin());

    expect(res).toMatchObject({ ok: false });
    expect(
      await prisma.teamMember.findFirst({ where: { seasonId: season.id, userId: sold.id } }),
    ).not.toBeNull();
    expect((await prisma.team.findUniqueOrThrow({ where: { id: a.team.id } })).budget).toBe(43);
  });

  it("reverts sales newest-first across repeated undos", async () => {
    const { season, a, b } = await poolDryWithSale();
    const second = await makePlayer(season.id, "Second Buy", 3000);
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: b.team.id, userId: second.id, price: 20 },
    });
    await prisma.team.update({ where: { id: b.team.id }, data: { budget: 80 } });

    const first = await undoLastSale(season.id, await admin());
    expect(first.ok && first.player).toBe("Second Buy");
    // Undo re-opens the auction; clear the clock so the next undo is allowed.
    await prisma.draft.update({
      where: { seasonId: season.id },
      data: { nominatedUserId: null },
    });
    const next = await undoLastSale(season.id, await admin());
    expect(next.ok && next.player).toBe("Sold Player");

    expect((await prisma.team.findUniqueOrThrow({ where: { id: a.team.id } })).budget).toBe(100);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: b.team.id } })).budget).toBe(100);
  });
});
