import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  DEFAULTS,
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";
import { effectiveDotaAccountId } from "./dota-account";
import {
  canBid,
  canNominate,
  maxBid,
  teamNeed,
  nextNominatorIndex,
  type DraftTeam,
} from "./draft";
import { draftBudgetsForDisplay } from "./draft-budgets";
import type { SessionUser } from "./auth";
import { raceHook } from "./race-hook";
import { draftRecap } from "./draft-recap";
import type {
  DraftLotExpectation,
  DraftTurnExpectation,
} from "./draft-http";
import { weekReminderPrefix } from "./settings";
import {
  draftCompleteMessage,
  draftRecapMessage,
  playerSoldMessage,
  sendDiscordMessage,
} from "./discord";
import { canViewLeagueContact } from "./visibility";

export type DraftActionResult = { ok: true } | { ok: false; error: string };

/**
 * Finalize a nomination whose clock has expired: the current high bidder wins
 * the player at the current price, budget is deducted, and the nomination
 * advances to the next captain who still needs players. Idempotent + safe to
 * call on every poll (it no-ops unless a nomination has actually expired).
 */
export async function resolveExpiredNomination(seasonId: string): Promise<boolean> {
  // Set inside the transaction when this call is the one that finishes the
  // draft / lands the sale; Discord pings go out only after the commit.
  let completedSeasonName: string | null = null;
  let sale: { player: string; team: string; price: number } | null = null;
  const resolved = await prisma.$transaction(async (tx) => {
    const draft = await tx.draft.findUnique({ where: { seasonId } });
    if (
      !draft ||
      draft.status !== DRAFT_STATUS.IN_PROGRESS ||
      !draft.nominatedUserId ||
      !draft.currentBidTeamId ||
      !draft.bidEndsAt
    ) {
      return false;
    }
    if (draft.bidEndsAt.getTime() > Date.now()) return false;

    const season = await tx.season.findUnique({ where: { id: seasonId } });
    // Draft.status is not sufficient on its own: phase is the outer lifecycle
    // gate. If a prior race ever stranded a live Draft outside DRAFT, a random
    // visitor must not auto-sell another player before an admin repairs it.
    if (
      !season?.isActive ||
      season.status !== SEASON_STATUS.DRAFT
    )
      return false;

    // Claim the resolution atomically (the placeBid optimistic-lock pattern):
    // clear the nomination only if the auction is still exactly as read. Two
    // concurrent pollers both reaching here must produce ONE sale — without
    // this, Postgres read-committed lets both award the player (double
    // TeamMember create → P2002 explosion mid-poll, double budget decrement).
    const claim = await tx.draft.updateMany({
      where: {
        seasonId,
        status: DRAFT_STATUS.IN_PROGRESS,
        nominatedUserId: draft.nominatedUserId,
        currentBidTeamId: draft.currentBidTeamId,
        currentBid: draft.currentBid,
        bidEndsAt: draft.bidEndsAt,
      },
      data: {
        nominatedUserId: null,
        currentBid: 0,
        currentBidTeamId: null,
        bidEndsAt: null,
      },
    });
    if (claim.count === 0) return false;

    // Void the lot — no charge, no roster add — if the player was withdrawn
    // mid-auction (admin moderation) OR flipped to STANDIN on /me while on
    // the block. The type half matters: saveRegistration now refuses type
    // changes during a live/paused draft, but this is the write-time backstop
    // — a flip that slips through must cost nothing rather than charging the
    // team and minting a rostered STANDIN (the exact both-worlds state the
    // rostered-player check exists to prevent). The claim above already
    // cleared the nomination; the rotation still advances below.
    const nomReg = await tx.registration.findUnique({
      where: { seasonId_userId: { seasonId, userId: draft.nominatedUserId } },
    });
    if (nomReg && nomReg.status === "ACTIVE" && nomReg.type === "PLAYER") {
      // Award the player to the winning team.
      await tx.teamMember.create({
        data: {
          seasonId,
          teamId: draft.currentBidTeamId,
          userId: draft.nominatedUserId,
          price: draft.currentBid,
          isCaptain: false,
        },
      });
      await tx.team.update({
        where: { id: draft.currentBidTeamId },
        data: { budget: { decrement: draft.currentBid } },
      });
      const [soldUser, soldTeam] = await Promise.all([
        tx.user.findUnique({ where: { id: draft.nominatedUserId } }),
        tx.team.findUnique({ where: { id: draft.currentBidTeamId } }),
      ]);
      if (soldUser && soldTeam) {
        sale = { player: soldUser.name, team: soldTeam.name, price: draft.currentBid };
      }
    }

    // Recompute needs and pick the next nominator.
    const teams = await tx.team.findMany({
      where: { seasonId },
      orderBy: { draftOrder: "asc" },
      include: { _count: { select: { members: true } } },
    });
    const draftTeams: DraftTeam[] = teams.map((t) => ({
      id: t.id,
      budget: t.budget,
      rosterCount: t._count.members,
    }));
    const lastIndex = teams.findIndex((t) => t.id === draft.nominatorTeamId);
    const nextIdx = nextNominatorIndex(
      draftTeams,
      season.teamSize,
      lastIndex < 0 ? 0 : lastIndex,
    );

    // If the signup pool is exhausted, the draft is over even when some teams
    // are short — otherwise it would wait forever on a nomination that can
    // never happen (short teams play with standins).
    const [regs, members] = await Promise.all([
      tx.registration.findMany({
        where: { seasonId, status: "ACTIVE", type: "PLAYER" },
        select: { userId: true },
      }),
      tx.teamMember.findMany({ where: { seasonId }, select: { userId: true } }),
    ]);
    const draftedIds = new Set(members.map((m) => m.userId));
    const poolDry = !regs.some((r) => !draftedIds.has(r.userId));

    // The nomination fields were already cleared by the claim above; these
    // updates only advance the rotation (or finish the draft).
    if (nextIdx === -1 || poolDry) {
      await tx.draft.update({
        where: { seasonId },
        data: { nominationEndsAt: null, status: DRAFT_STATUS.COMPLETE },
      });
      completedSeasonName = season.name;
    } else {
      await tx.draft.update({
        where: { seasonId },
        data: {
          nominatorTeamId: teams[nextIdx].id,
          nominationIndex: nextIdx,
          nominationEndsAt: new Date(
            Date.now() + DEFAULTS.NOMINATION_TIMER_SECONDS * 1000,
          ),
        },
      });
    }
    return true;
  });
  if (sale) {
    const s = sale as { player: string; team: string; price: number };
    await sendDiscordMessage(playerSoldMessage(s.player, s.team, s.price));
  }
  if (completedSeasonName) {
    await sendDiscordMessage(draftCompleteMessage(completedSeasonName));
    await sendDraftRecap(seasonId);
  }
  return resolved;
}

/**
 * Post-completion Discord recap (best-effort, like every send): the auction's
 * superlatives via the same tested draftRecap math the /teams card uses.
 */
async function sendDraftRecap(seasonId: string): Promise<void> {
  const [teams, regs] = await Promise.all([
    prisma.team.findMany({
      where: { seasonId },
      include: { members: { include: { user: { select: { name: true } } } } },
    }),
    prisma.registration.findMany({
      where: { seasonId },
      select: { userId: true, mmr: true },
    }),
  ]);
  const mmrByUser = new Map(regs.map((r) => [r.userId, r.mmr]));
  const recap = draftRecap(
    teams.flatMap((t) =>
      t.members.map((m) => ({
        name: m.user.name,
        teamName: t.name,
        price: m.price,
        isCaptain: m.isCaptain,
        mmr: mmrByUser.get(m.userId) ?? null,
      })),
    ),
  );
  if (recap.totalSpent > 0) {
    await sendDiscordMessage(draftRecapMessage(recap));
  }
}

/**
 * If the team on the clock lets their nomination timer run out, auto-nominate
 * the top available player for them at the minimum bid — so a live draft never
 * stalls on an absent captain. Idempotent; safe to call on every poll.
 */
export async function resolveStalledNomination(
  seasonId: string,
): Promise<boolean> {
  let completedSeasonName: string | null = null;
  const resolved = await prisma.$transaction(async (tx) => {
    const draft = await tx.draft.findUnique({ where: { seasonId } });
    if (
      !draft ||
      draft.status !== DRAFT_STATUS.IN_PROGRESS ||
      draft.nominatedUserId ||
      !draft.nominatorTeamId ||
      !draft.nominationEndsAt ||
      draft.nominationEndsAt.getTime() > Date.now()
    ) {
      return false;
    }

    const [season, nominator] = await Promise.all([
      tx.season.findUnique({ where: { id: seasonId } }),
      tx.team.findFirst({
        where: { id: draft.nominatorTeamId },
        include: { _count: { select: { members: true } } },
      }),
    ]);
    if (
      !season?.isActive ||
      season.status !== SEASON_STATUS.DRAFT ||
      !nominator
    )
      return false;
    // Full roster OR no money for even the minimum bid — both mean this team
    // cannot legally take the clock, so ADVANCE instead of no-opping forever (an
    // expired clock plus an ineligible nominator would otherwise freeze the
    // draft). The affordability half matters because this is the ONE nomination
    // path with no maxBid check: nominatePlayer and placeBid both refuse an
    // unaffordable amount, but this resolver used to open a lot at MIN_BID on the
    // team's behalf regardless, and resolveExpiredNomination then decremented the
    // budget unguarded — leaving it negative. nextNominatorIndex now skips broke
    // teams too, so advancing here cannot cycle.
    if (
      !canNominate(
        {
          id: nominator.id,
          budget: nominator.budget,
          rosterCount: nominator._count.members,
        },
        season.teamSize,
      )
    ) {
      const teams = await tx.team.findMany({
        where: { seasonId },
        orderBy: { draftOrder: "asc" },
        include: { _count: { select: { members: true } } },
      });
      const idx = teams.findIndex((t) => t.id === nominator.id);
      const nextIdx = nextNominatorIndex(
        teams.map((t) => ({
          id: t.id,
          budget: t.budget,
          rosterCount: t._count.members,
        })),
        season.teamSize,
        idx < 0 ? 0 : idx,
      );
      if (nextIdx === -1) {
        const done = await tx.draft.updateMany({
          where: {
            seasonId,
            status: DRAFT_STATUS.IN_PROGRESS,
            nominationEndsAt: draft.nominationEndsAt,
          },
          data: { nominationEndsAt: null, status: DRAFT_STATUS.COMPLETE },
        });
        if (done.count === 0) return false;
        completedSeasonName = season.name;
      } else {
        const adv = await tx.draft.updateMany({
          where: {
            seasonId,
            status: DRAFT_STATUS.IN_PROGRESS,
            nominationEndsAt: draft.nominationEndsAt,
          },
          data: {
            nominatorTeamId: teams[nextIdx].id,
            nominationIndex: nextIdx,
            nominationEndsAt: new Date(
              Date.now() + DEFAULTS.NOMINATION_TIMER_SECONDS * 1000,
            ),
          },
        });
        if (adv.count === 0) return false;
      }
      return true;
    }

    const [regs, members] = await Promise.all([
      tx.registration.findMany({
        where: { seasonId, status: "ACTIVE", type: "PLAYER" },
        orderBy: { mmr: "desc" },
      }),
      tx.teamMember.findMany({ where: { seasonId }, select: { userId: true } }),
    ]);
    const drafted = new Set(members.map((m) => m.userId));
    const pick = regs.find((r) => !drafted.has(r.userId));
    if (!pick) {
      // Pool is dry — nothing left to nominate, so the draft is over even
      // though this team is short (they'll play with standins). Claimed, so
      // two concurrent pollers can't both COMPLETE and double-announce.
      const done = await tx.draft.updateMany({
        where: {
          seasonId,
          status: DRAFT_STATUS.IN_PROGRESS,
          nominationEndsAt: draft.nominationEndsAt,
        },
        data: {
          nominatedUserId: null,
          currentBid: 0,
          currentBidTeamId: null,
          bidEndsAt: null,
          nominationEndsAt: null,
          status: DRAFT_STATUS.COMPLETE,
        },
      });
      if (done.count === 0) return false;
      completedSeasonName = season.name;
      return true;
    }

    const amount = DEFAULTS.MIN_BID;
    // Claim the auto-nomination: only fire if nothing else nominated (or a
    // rival resolver already fired) since our read — two concurrent pollers
    // must open ONE auction with ONE opening Bid row.
    const claim = await tx.draft.updateMany({
      where: {
        seasonId,
        status: DRAFT_STATUS.IN_PROGRESS,
        nominatedUserId: null,
        nominationEndsAt: draft.nominationEndsAt,
      },
      data: {
        nominatedUserId: pick.userId,
        currentBid: amount,
        currentBidTeamId: nominator.id,
        bidEndsAt: new Date(Date.now() + DEFAULTS.BID_TIMER_SECONDS * 1000),
        nominationEndsAt: null,
      },
    });
    if (claim.count === 0) return false;
    await tx.bid.create({
      data: {
        draftId: draft.id,
        seasonId,
        teamId: nominator.id,
        userId: pick.userId,
        amount,
      },
    });
    return true;
  });
  if (completedSeasonName) {
    await sendDiscordMessage(draftCompleteMessage(completedSeasonName));
    await sendDraftRecap(seasonId);
  }
  return resolved;
}

/**
 * Admin: pause the live auction (disputes, bio breaks). Clocks are parked —
 * the lazy resolvers only fire on IN_PROGRESS, so nothing can expire or sell
 * while paused. Resume restarts whichever clock was running, at full length.
 */
export async function pauseDraft(
  seasonId: string,
  viewer: SessionUser,
): Promise<DraftActionResult> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  // A pause arriving just after zero must settle the expired clock, not grant
  // a fresh full clock on Resume. Both resolvers are idempotent and phase-
  // gated; after they run, the claim parks whichever clock is now current.
  await resolveExpiredNomination(seasonId);
  await resolveStalledNomination(seasonId);
  return prisma.$transaction(async (tx) => {
    const season = await tx.season.findUnique({ where: { id: seasonId } });
    if (!season?.isActive || season.status !== SEASON_STATUS.DRAFT) {
      return { ok: false as const, error: "The auction is not in the Draft phase" };
    }
    const claim = await tx.draft.updateMany({
      where: { seasonId, status: DRAFT_STATUS.IN_PROGRESS },
      data: {
        status: DRAFT_STATUS.PAUSED,
        bidEndsAt: null,
        nominationEndsAt: null,
      },
    });
    if (claim.count === 0)
      return { ok: false as const, error: "The draft isn't live" };
    return { ok: true as const };
  });
}

/** Admin: resume a paused auction with a fresh full clock for the live lot. */
export async function resumeDraft(
  seasonId: string,
  viewer: SessionUser,
): Promise<DraftActionResult> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  return prisma.$transaction(async (tx) => {
    const [season, draft] = await Promise.all([
      tx.season.findUnique({ where: { id: seasonId } }),
      tx.draft.findUnique({ where: { seasonId } }),
    ]);
    if (!season?.isActive || season.status !== SEASON_STATUS.DRAFT) {
      return { ok: false as const, error: "The auction is not in the Draft phase" };
    }
    if (!draft || draft.status !== DRAFT_STATUS.PAUSED) {
      return { ok: false as const, error: "The draft isn't paused" };
    }
    const clock = draft.nominatedUserId
      ? { bidEndsAt: new Date(Date.now() + DEFAULTS.BID_TIMER_SECONDS * 1000) }
      : {
          nominationEndsAt: new Date(
            Date.now() + DEFAULTS.NOMINATION_TIMER_SECONDS * 1000,
          ),
        };
    // Cancellation deliberately touches even an already-PAUSED draft. A
    // Resume that authorized itself just before that lifecycle write must lose
    // this updatedAt claim instead of rearming clocks on an archived season.
    await raceHook("draft.resume.beforeClaim");
    const claim = await tx.draft.updateMany({
      where: {
        seasonId,
        status: DRAFT_STATUS.PAUSED,
        updatedAt: draft.updatedAt,
      },
      data: { status: DRAFT_STATUS.IN_PROGRESS, ...clock },
    });
    if (claim.count === 0)
      return { ok: false as const, error: "The draft just changed — reload" };
    return { ok: true as const };
  });
}

export type VoidLotSummary = {
  ok: true;
  player: string;
  nominator: string;
};

/**
 * Cancel a mistaken/disputed live lot while the auction is paused.
 *
 * Undo repairs a completed sale; it deliberately cannot touch a live lot.
 * Without this companion operation, pausing a wrong nomination created a
 * dead end: the lot could neither settle while paused nor be corrected. The
 * same nominator keeps the turn and Resume gives them a fresh nomination
 * clock. All bids for the void lot are removed from the visible audit trail.
 */
export async function voidCurrentLot(
  seasonId: string,
  viewer: SessionUser,
): Promise<VoidLotSummary | { ok: false; error: string }> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  return prisma.$transaction(
    async (tx) => {
      const [season, draft] = await Promise.all([
        tx.season.findUnique({ where: { id: seasonId } }),
        tx.draft.findUnique({ where: { seasonId } }),
      ]);
      if (!season?.isActive || season.status !== SEASON_STATUS.DRAFT) {
        return { ok: false as const, error: "The auction is not in the Draft phase" };
      }
      if (!draft || draft.status !== DRAFT_STATUS.PAUSED) {
        return {
          ok: false as const,
          error: "Pause the auction before voiding a live lot",
        };
      }
      if (!draft.nominatedUserId) {
        return { ok: false as const, error: "There is no live lot to void" };
      }
      const [player, nominator] = await Promise.all([
        tx.user.findUnique({
          where: { id: draft.nominatedUserId },
          select: { name: true },
        }),
        tx.team.findUnique({
          where: { id: draft.nominatorTeamId ?? "" },
          select: { name: true },
        }),
      ]);
      const claim = await tx.draft.updateMany({
        where: {
          seasonId,
          status: DRAFT_STATUS.PAUSED,
          nominatedUserId: draft.nominatedUserId,
          currentBid: draft.currentBid,
          currentBidTeamId: draft.currentBidTeamId,
          updatedAt: draft.updatedAt,
        },
        data: {
          nominatedUserId: null,
          currentBid: 0,
          currentBidTeamId: null,
          bidEndsAt: null,
          nominationEndsAt: null,
        },
      });
      if (claim.count === 0) {
        return { ok: false as const, error: "The lot just changed — reload" };
      }
      await tx.bid.deleteMany({
        where: { draftId: draft.id, userId: draft.nominatedUserId },
      });
      return {
        ok: true as const,
        player: player?.name ?? "The nominated player",
        nominator: nominator?.name ?? "The team on the clock",
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/** Which purchase an undo actually reverted, so the toast can name it. */
export type UndoSaleSummary = {
  ok: true;
  player: string;
  team: string;
  price: number;
  /** The auction was PAUSED and has been left that way — say so in the toast. */
  paused: boolean;
};

/**
 * Admin: revert the most recent sale — the recovery path for a mis-click or a
 * disputed lot (previously nothing short of SQL could fix one). The player
 * returns to the pool, the buyer gets their money back and the next
 * nomination (they have the open seat); works from COMPLETE too, re-opening
 * the draft. Refused while a lot is live — undoing under an active clock
 * would shift budgets mid-auction.
 */
/**
 * Thrown once undoLastSale has already deleted the roster row and credited the
 * budget but can no longer safely re-open the auction. It must be a throw: a
 * `return` resolves the Prisma interactive transaction, which COMMITS it, so
 * the refund would stand with the sale never actually undone.
 */
class UndoRaceError extends Error {}

export async function undoLastSale(
  seasonId: string,
  viewer: SessionUser,
): Promise<UndoSaleSummary | { ok: false; error: string }> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  try {
    return await prisma.$transaction(async (tx) => {
    const [season, draft] = await Promise.all([
      tx.season.findUnique({ where: { id: seasonId } }),
      tx.draft.findUnique({ where: { seasonId } }),
    ]);
    // Action-level phase checks are useful copy, but the service owns the
    // invariant. Reading Season in this SERIALIZABLE transaction pairs with
    // setSeasonPhase's Draft read, so phase-advance-vs-Undo cannot commit a
    // REGULAR_SEASON with an IN_PROGRESS auction.
    if (!season?.isActive || season.status !== SEASON_STATUS.DRAFT) {
      return {
        ok: false as const,
        error:
          "The season has moved on — use Release / Sign free agent for roster corrections.",
      };
    }
    if (!draft) return { ok: false as const, error: "No draft" };
    if (
      draft.status !== DRAFT_STATUS.IN_PROGRESS &&
      draft.status !== DRAFT_STATUS.PAUSED &&
      draft.status !== DRAFT_STATUS.COMPLETE
    ) {
      return { ok: false as const, error: "The draft hasn't started" };
    }
    if (draft.nominatedUserId) {
      return {
        ok: false as const,
        error: "A lot is live — wait for it to settle before undoing.",
      };
    }
    // PROVENANCE: only ever target an actual auction purchase. `price > 0` is an
    // exact discriminator, not a heuristic — non-captain roster rows are created
    // in exactly two places: resolveExpiredNomination at `draft.currentBid`
    // (which nominatePlayer floors at DEFAULTS.MIN_BID = 1) and signFreeAgent at
    // a hard-coded 0. Without this filter "the newest non-captain row" was
    // whatever happened last: a pool-dry draft leaves the season in DRAFT, where
    // Sign free agent is legal, so undoing a disputed lot silently deleted the
    // $0 free-agent signing instead — refunding nothing, leaving the disputed
    // sale in place, and still re-opening the auction.
    const last = await tx.teamMember.findFirst({
      where: { seasonId, isCaptain: false, price: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      include: { user: { select: { name: true } }, team: { select: { name: true } } },
    });
    if (!last) {
      // Say WHICH nothing: "no sales at all" and "only signings" need different
      // actions from the admin.
      const signings = await tx.teamMember.count({
        where: { seasonId, isCaptain: false },
      });
      return {
        ok: false as const,
        error: signings
          ? "No auction sale to undo — the players on these rosters were free-agent signings. Use Release to remove one."
          : "No sale to undo",
      };
    }

    // deleteMany, not delete: two Undo clicks racing (or Undo racing an
    // abort's teardown) leave the loser deleting a row the winner already
    // removed — delete-by-unique raises P2025 there, which blew the losing
    // admin's panel to the error page mid-dispute. This is the FIRST write in
    // the transaction, so a zero count can safely return a typed refusal:
    // nothing has been written yet.
    const gone = await tx.teamMember.deleteMany({ where: { id: last.id } });
    if (gone.count === 0) {
      return {
        ok: false as const,
        error: "That sale was already undone — nothing changed.",
      };
    }
    // Void this lot's audit trail too. The Bid rows are keyed by
    // (draftId, userId) with no per-nomination id, so leaving them meant the
    // re-run auction's "Bid trail" replayed the VOIDED sale's prices — every
    // captain saw the price apparently falling from $57 to $1.
    await tx.bid.deleteMany({
      where: { draftId: draft.id, userId: last.userId },
    });
    await tx.team.update({
      where: { id: last.teamId },
      data: { budget: { increment: last.price } },
    });
    const order = await tx.team.findMany({
      where: { seasonId },
      orderBy: { draftOrder: "asc" },
      select: { id: true },
    });
    const nomIdx = order.findIndex((t) => t.id === last.teamId);
    // Re-assert the no-live-lot precondition AT THE WRITE, not just at the read
    // above. This was a blind update-by-seasonId, and the gap between the two is
    // wide (a roster delete, a Bid sweep, a budget credit and a team scan). The
    // realistic sequence: a disputed sale, a minute of captains arguing, the
    // nomination clock expires, a poller's resolveStalledNomination opens a
    // fresh lot — and then Undo lands, writing status + nominatorTeamId +
    // nominationEndsAt over the top while leaving nominatedUserId / currentBid /
    // bidEndsAt from that lot intact. The draft then held a LIVE AUCTION and a
    // running NOMINATION CLOCK simultaneously, which the state machine treats as
    // mutually exclusive: resolveExpiredNomination would go on to sell that
    // player to a team that never nominated them, and advance the rotation from
    // the nominator Undo had just repointed. Reproduced 11 times in 12 on
    // Postgres before this claim.
    //
    // A PAUSED draft stays PAUSED. Pause → Undo is the single most likely
    // draft-night sequence there is (a lot sells, the captains dispute it, the
    // admin parks the clocks to settle it), and flattening the status to
    // IN_PROGRESS here silently resumed the auction with a fresh 90-second
    // nomination clock running — while the room still showed nothing but the
    // Pause button having swapped to Resume, and the toast said only that the
    // sale was reverted. The admin's own "Resume auction" already grants a full
    // clock to whatever `nominatorTeamId` holds (resumeDraft's no-lot branch),
    // so parking it here costs nothing and keeps the pause meaning what it says.
    const wasPaused = draft.status === DRAFT_STATUS.PAUSED;
    const reopened = await tx.draft.updateMany({
      where: { seasonId, status: draft.status, nominatedUserId: null },
      data: {
        status: wasPaused ? DRAFT_STATUS.PAUSED : DRAFT_STATUS.IN_PROGRESS,
        nominatorTeamId: last.teamId,
        nominationIndex: nomIdx < 0 ? draft.nominationIndex : nomIdx,
        nominationEndsAt: wasPaused
          ? null
          : new Date(Date.now() + DEFAULTS.NOMINATION_TIMER_SECONDS * 1000),
      },
    });
    if (reopened.count === 0) {
      // THROW, never return: the refund and the roster delete above are already
      // written, and returning from a Prisma interactive transaction COMMITS
      // them — the player would be gone and the money back with the sale never
      // undone. Rolling back is the only correct outcome. (Same trap as the
      // inhouse draft's turn claim; caught outside the callback below.)
      throw new UndoRaceError(
        "A lot went live while you were undoing — let it settle and try again.",
      );
    }
    return {
      ok: true as const,
      player: last.user.name,
      team: last.team.name,
      price: last.price,
      paused: wasPaused,
    };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (e) {
    // Outside the callback on purpose — catching inside would resolve the
    // transaction and commit the very writes the throw exists to roll back.
    if (e instanceof UndoRaceError) {
      return { ok: false as const, error: e.message };
    }
    if ((e as { code?: string }).code === "P2034") {
      return {
        ok: false as const,
        error: "The phase, roster, or auction just changed — reload and try again.",
      };
    }
    throw e;
  }
}

/** What an abort actually threw away, so the caller can say so out loud. */
export type AbortDraftSummary = {
  ok: true;
  playersReturned: number;
  budgetRestored: number;
  teams: number;
  matchesRemoved: number;
  checkInsCleared: number;
  predictionsCleared: number;
  reschedulesCleared: number;
  fantasyRostersCleared: number;
  /** Standin bookings deleted with the rosters they covered — the ACTION
   *  sends one stand-down per row post-commit (the generateSchedule shape). */
  coverStandDowns: {
    standinName: string;
    discordId: string | null;
    teamName: string;
    homeName: string;
    awayName: string;
    week: number;
    isPlayoff: boolean;
  }[];
};

class AbortRaceError extends Error {}

/**
 * Admin: ABORT the draft and put the season back to pre-draft.
 *
 * The escape hatch for the one genuinely unrecoverable mistake in the league:
 * `startDraft` is a one-way door. Nothing else ever writes `Draft.status` back
 * to NOT_STARTED, and every captain control (addCaptain / removeCaptain /
 * randomizeDraftOrder / setDraftSettings) refuses once the status has moved off
 * it — so hitting "Start draft" with 2 of 8 captains designated permanently
 * capped the season at two teams, and the only way out was creating a new
 * season, which archives every registration and makes all 40 players sign up
 * again. Playoffs already had "Reset playoffs"; this is the draft's equivalent.
 *
 * Refuses once any result exists: by then rosters are load-bearing for
 * standings, box scores and the bracket, and dissolving them is not a recovery.
 * Budgets are restored by crediting back exactly what each team spent, which
 * reverses the auction whatever the starting budget was (they are MMR-weighted
 * per captain, so there is no single figure to reset to).
 */
export async function abortDraft(
  seasonId: string,
  viewer: SessionUser,
): Promise<AbortDraftSummary | { ok: false; error: string }> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  try {
    return await prisma.$transaction(
      async (tx) => {
        const [season, draft] = await Promise.all([
          tx.season.findUnique({ where: { id: seasonId } }),
          tx.draft.findUnique({ where: { seasonId } }),
        ]);
        if (!season?.isActive) {
          return { ok: false as const, error: "That is no longer the active season" };
        }
        if (!draft || draft.status === DRAFT_STATUS.NOT_STARTED) {
          return { ok: false as const, error: "The draft hasn't started" };
        }

        // Rosters become load-bearing the moment anything is played. Guard on
        // both recorded results AND imported games. The transaction is
        // SERIALIZABLE and importGameForMatch reads the same Season/Draft rows,
        // so an import racing this teardown cannot slip through the count.
        const [
          played,
          games,
          nonScheduled,
          matchesRemoved,
          checkInsCleared,
          predictionsCleared,
          reschedulesCleared,
          fantasyRostersCleared,
        ] = await Promise.all([
          tx.match.count({ where: { seasonId, status: MATCH_STATUS.COMPLETED } }),
          tx.game.count({ where: { match: { seasonId } } }),
          tx.match.count({
            where: { seasonId, status: { not: MATCH_STATUS.SCHEDULED } },
          }),
          tx.match.count({ where: { seasonId } }),
          tx.matchAvailability.count({ where: { match: { seasonId } } }),
          tx.prediction.count({ where: { match: { seasonId } } }),
          tx.rescheduleRequest.count({ where: { match: { seasonId } } }),
          tx.fantasyRoster.count({ where: { seasonId } }),
        ]);
        if (played > 0 || games > 0 || nonScheduled > 0) {
          return {
            ok: false as const,
            error:
              "A match has started or results are already recorded — the draft can't be aborted. Use Release / Sign free agent to fix a roster.",
          };
        }

        const claim = await tx.draft.updateMany({
          where: {
            seasonId,
            status: draft.status,
            updatedAt: draft.updatedAt,
          },
          data: {
            status: DRAFT_STATUS.NOT_STARTED,
            nominatedUserId: null,
            currentBid: 0,
            currentBidTeamId: null,
            bidEndsAt: null,
            nominationEndsAt: null,
            nominatorTeamId: null,
            nominationIndex: 0,
          },
        });
        if (claim.count === 0) throw new AbortRaceError();

        // Restore a captain-only setup using Team.captainId as the authority,
        // not the denormalized member flag. A bought player can legitimately be
        // promoted after completion; if the auction is then aborted they remain
        // the captain, but their auction price must become $0 and be refunded.
        // The former captain and every other non-authoritative roster row return
        // to the pool, including $0 free-agent signings made after completion.
        const [teamAuthorities, roster] = await Promise.all([
          tx.team.findMany({
            where: { seasonId },
            select: { id: true, captainId: true },
          }),
          tx.teamMember.findMany({
            where: { seasonId },
            select: { id: true, teamId: true, userId: true, price: true },
          }),
        ]);
        const captainByTeam = new Map(
          teamAuthorities.map((team) => [team.id, team.captainId]),
        );
        const retainedCaptains = roster.filter(
          (member) => captainByTeam.get(member.teamId) === member.userId,
        );
        if (retainedCaptains.length !== teamAuthorities.length) {
          throw new AbortRaceError();
        }
        const returned = roster.filter(
          (member) => captainByTeam.get(member.teamId) !== member.userId,
        );
        const spentByTeam = new Map<string, number>();
        for (const member of roster) {
          spentByTeam.set(
            member.teamId,
            (spentByTeam.get(member.teamId) ?? 0) + member.price,
          );
        }
        if (returned.length > 0) {
          await tx.teamMember.deleteMany({
            where: { id: { in: returned.map((member) => member.id) } },
          });
        }
        await tx.teamMember.updateMany({
          where: { id: { in: retainedCaptains.map((member) => member.id) } },
          data: { isCaptain: true, price: 0 },
        });
        for (const [teamId, spent] of spentByTeam) {
          if (spent !== 0) {
            await tx.team.update({
              where: { id: teamId },
              data: { budget: { increment: spent } },
            });
          }
        }
        await tx.bid.deleteMany({ where: { draftId: draft.id } });

        // Every fixture-level artifact was composed against the rosters being
        // dissolved. Preserve none of that semantically stale schedule: Match
        // cascades clear check-ins, predictions, cover and reschedules; fantasy
        // lineups are season-level and need an explicit reset.
        const staleCover = await tx.standinAssignment.findMany({
          where: { match: { seasonId } },
          select: {
            teamId: true,
            standin: { select: { name: true, discordId: true } },
            match: {
              select: {
                week: true,
                phase: true,
                homeTeam: { select: { name: true } },
                awayTeam: { select: { name: true } },
              },
            },
          },
        });
        const teamNames = new Map(
          (
            await tx.team.findMany({
              where: { seasonId },
              select: { id: true, name: true },
            })
          ).map((team) => [team.id, team.name]),
        );
        await raceHook("draft.abortDraft.beforeFixtureDelete");
        const removedMatches = await tx.match.deleteMany({
          where: {
            seasonId,
            status: MATCH_STATUS.SCHEDULED,
            games: { none: {} },
          },
        });
        if (removedMatches.count !== matchesRemoved) throw new AbortRaceError();
        await tx.fantasyRoster.deleteMany({ where: { seasonId } });
        await tx.setting.deleteMany({
          where: { key: { startsWith: weekReminderPrefix(seasonId) } },
        });

        // The draft time/readiness acknowledgements are deliberately kept: an
        // abort normally means "fix captains and rerun tonight", so asking the
        // same people to reconfirm the unchanged time adds no integrity. Match
        // night, week and champion state belong to the deleted schedule.
        const resetSeason = await tx.season.updateMany({
          where: {
            id: seasonId,
            isActive: true,
            status: season.status,
          },
          data: {
            status: SEASON_STATUS.SIGNUPS,
            currentWeek: 0,
            championTeamId: null,
            fantasyLockedAt: null,
          },
        });
        if (resetSeason.count === 0) throw new AbortRaceError();

        const teams = await tx.team.count({ where: { seasonId } });
        return {
          ok: true as const,
          playersReturned: returned.length,
          budgetRestored: [...spentByTeam.values()].reduce((n, value) => n + value, 0),
          teams,
          matchesRemoved,
          checkInsCleared,
          predictionsCleared,
          reschedulesCleared,
          fantasyRostersCleared,
          coverStandDowns: staleCover.map((assignment) => ({
            standinName: assignment.standin.name,
            discordId: assignment.standin.discordId,
            teamName: teamNames.get(assignment.teamId) ?? "their team",
            homeName: assignment.match.homeTeam.name,
            awayName: assignment.match.awayTeam.name,
            week: assignment.match.week,
            isPlayoff: assignment.match.phase !== MATCH_PHASE.REGULAR,
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof AbortRaceError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return {
        ok: false,
        error:
          "The auction, schedule, or results changed during the reset — nothing was aborted. Reload and review it.",
      };
    }
    throw error;
  }
}

/** Everything the draft room client needs, tailored to the viewing user. */
export async function getDraftState(seasonId: string, viewer: SessionUser | null) {
  await resolveExpiredNomination(seasonId);
  await resolveStalledNomination(seasonId);
  // One repeatable snapshot. The old Promise.all ran independent queries, so
  // a sale between them could return a new roster with an old budget, or a new
  // lot with the previous lot's Bid trail. SERIALIZABLE is the only isolation
  // level shared by this repository's SQLite dev/test DB and PostgreSQL.
  return prisma.$transaction(
    async (tx) => {
      const [season, draft, teams, playerRegs, viewerRegistration] =
        await Promise.all([
          tx.season.findUnique({ where: { id: seasonId } }),
          tx.draft.findUnique({ where: { seasonId } }),
          tx.team.findMany({
            where: { seasonId },
            orderBy: { draftOrder: "asc" },
            select: {
              id: true,
              name: true,
              budget: true,
              draftOrder: true,
              captainId: true,
              members: {
                orderBy: { price: "desc" },
                select: {
                  userId: true,
                  price: true,
                  isCaptain: true,
                  createdAt: true,
                  user: {
                    select: {
                      name: true,
                      avatar: true,
                      rankTier: true,
                    },
                  },
                },
              },
            },
          }),
          tx.registration.findMany({
            where: { seasonId, status: "ACTIVE", type: "PLAYER" },
            orderBy: { mmr: "desc" },
            select: {
              userId: true,
              mmr: true,
              roles: true,
              favoriteHeroes: true,
              statement: true,
              captainNote: true,
              user: {
                select: {
                  name: true,
                  avatar: true,
                  rankTier: true,
                  dotaAccountIdV2: true,
                  legacyDotaAccountId: true,
                  steamId: true,
                  discordName: true,
                  discordId: true,
                },
              },
            },
          }),
          viewer
            ? tx.registration.findUnique({
                where: {
                  seasonId_userId: { seasonId, userId: viewer.id },
                },
                select: { status: true },
              })
            : null,
        ]);
      if (!season) return null;

      const members = teams.flatMap((team) => team.members);
      const draftedIds = new Set(members.map((member) => member.userId));
      const available = playerRegs
        .filter((registration) => !draftedIds.has(registration.userId))
        .map((registration) => ({
          userId: registration.userId,
          name: registration.user.name,
          avatar: registration.user.avatar,
          mmr: registration.mmr,
          rankTier: registration.user.rankTier,
          roles: registration.roles,
        }));

      const displayBudgets = draftBudgetsForDisplay({
        seasonIsActive: season.isActive,
        seasonStatus: season.status,
        draftStatus: draft?.status,
        baseBudget: season.draftBudget,
        budgetMmrWeight: season.budgetMmrWeight,
        teamSize: season.teamSize,
        teams,
        captainMmrs: playerRegs,
      });
      const teamViews = teams.map((team) => ({
        id: team.id,
        name: team.name,
        budget: displayBudgets.byTeam.get(team.id) ?? team.budget,
        draftOrder: team.draftOrder,
        captainId: team.captainId,
        need: teamNeed(season.teamSize, team.members.length),
        members: team.members.map((member) => ({
          userId: member.userId,
          name: member.user.name,
          avatar: member.user.avatar,
          price: member.price,
          isCaptain: member.isCaptain,
          rankTier: member.user.rankTier,
        })),
      }));

      const myTeam = viewer
        ? teams.find((team) => team.captainId === viewer.id)
        : undefined;
      const rosterTeam = viewer
        ? teams.find((team) =>
            team.members.some((member) => member.userId === viewer.id),
          )
        : undefined;
      const rosterSeat = rosterTeam?.members.find(
        (member) => member.userId === viewer?.id,
      );
      const now = Date.now();
      const bidOpen =
        season.status === SEASON_STATUS.DRAFT &&
        !!draft?.nominatedUserId &&
        !!draft.bidEndsAt &&
        draft.bidEndsAt.getTime() > now;
      const myBudget = myTeam
        ? (displayBudgets.byTeam.get(myTeam.id) ?? myTeam.budget)
        : 0;
      const myDraftTeam: DraftTeam | undefined = myTeam
        ? {
            id: myTeam.id,
            budget: myBudget,
            rosterCount: myTeam.members.length,
          }
        : undefined;

      const recentSales = teams
        .flatMap((team) =>
          team.members
            .filter((member) => !member.isCaptain && member.price > 0)
            .map((member) => ({
              name: member.user.name,
              teamName: team.name,
              price: member.price,
              at: member.createdAt.getTime(),
            })),
        )
        .sort((a, b) => b.at - a.at)
        .slice(0, 8);
      const nominatedPlayer = draft?.nominatedUserId
        ? (playerRegs.find(
            (registration) => registration.userId === draft.nominatedUserId,
          ) ?? null)
        : null;
      const canSeeNominatedContact = nominatedPlayer
        ? canViewLeagueContact(
            viewer,
            nominatedPlayer.userId,
            viewerRegistration?.status === "ACTIVE",
          )
        : false;
      const lotBidRows =
        draft?.nominatedUserId != null
          ? await tx.bid.findMany({
              where: {
                draftId: draft.id,
                userId: draft.nominatedUserId,
              },
              orderBy: { createdAt: "desc" },
              take: 9,
              select: { teamId: true, amount: true, createdAt: true },
            })
          : [];

      return {
        seasonId: season.id,
        seasonName: season.name,
        seasonStatus: season.status,
        draftAtMs: season.draftAt?.getTime() ?? null,
        draftRevision: season.draftRevision,
        draftVersion: draft?.updatedAt.getTime() ?? null,
        status: draft?.status ?? DRAFT_STATUS.NOT_STARTED,
        budgetsProjected: displayBudgets.isProjected,
        teamSize: season.teamSize,
        minBid: DEFAULTS.MIN_BID,
        now,
        bidEndsAt: draft?.bidEndsAt?.getTime() ?? null,
        nominationEndsAt: draft?.nominationEndsAt?.getTime() ?? null,
        nominatorTeamId: draft?.nominatorTeamId ?? null,
        nominatedUserId: draft?.nominatedUserId ?? null,
        currentBid: draft?.currentBid ?? 0,
        currentBidTeamId: draft?.currentBidTeamId ?? null,
        lotBids: lotBidRows.slice(0, 8).map((bid) => ({
          teamId: bid.teamId,
          amount: bid.amount,
          at: bid.createdAt.getTime(),
        })),
        lotBidsTruncated: lotBidRows.length > 8,
        recentSales,
        nominatedPlayer: nominatedPlayer
          ? {
              userId: nominatedPlayer.userId,
              name: nominatedPlayer.user.name,
              avatar: nominatedPlayer.user.avatar,
              mmr: nominatedPlayer.mmr,
              rankTier: nominatedPlayer.user.rankTier,
              roles: nominatedPlayer.roles,
              favoriteHeroes: nominatedPlayer.favoriteHeroes,
              statement: nominatedPlayer.statement,
              captainNote: nominatedPlayer.captainNote,
              accountId: effectiveDotaAccountId(nominatedPlayer.user),
              discordName: canSeeNominatedContact
                ? nominatedPlayer.user.discordName
                : "",
              discordVerified:
                canSeeNominatedContact && !!nominatedPlayer.user.discordId,
            }
          : null,
        teams: teamViews,
        available,
        me: {
          userId: viewer?.id ?? null,
          isAdmin: viewer?.role === "ADMIN",
          myTeamId: myTeam?.id ?? null,
          rosterTeamId: rosterTeam?.id ?? null,
          rosterTeamName: rosterTeam?.name ?? null,
          rosterPrice: rosterSeat?.price ?? null,
          rosterIsCaptain: rosterSeat?.isCaptain ?? false,
          isMyTurn: !!myTeam && draft?.nominatorTeamId === myTeam.id,
          canNominate:
            season.status === SEASON_STATUS.DRAFT &&
            draft?.status === DRAFT_STATUS.IN_PROGRESS &&
            !draft.nominatedUserId &&
            !!myDraftTeam &&
            draft.nominatorTeamId === myTeam?.id &&
            teamNeed(season.teamSize, myDraftTeam.rosterCount) > 0,
          canBid:
            bidOpen &&
            !!myDraftTeam &&
            draft?.currentBidTeamId !== myTeam?.id &&
            maxBid(myDraftTeam, season.teamSize) > (draft?.currentBid ?? 0),
          myMaxBid: myDraftTeam ? maxBid(myDraftTeam, season.teamSize) : 0,
          myBudget,
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export type DraftState = NonNullable<Awaited<ReturnType<typeof getDraftState>>>;

/** A captain (or admin, on their behalf) nominates a player with an opening bid. */
export async function nominatePlayer(
  seasonId: string,
  viewer: SessionUser,
  playerId: string,
  amount: number,
  expected?: DraftTurnExpectation,
): Promise<DraftActionResult> {
  await resolveExpiredNomination(seasonId);

  try {
    return await prisma.$transaction(async (tx) => {
    const [season, draft] = await Promise.all([
      tx.season.findUnique({ where: { id: seasonId } }),
      tx.draft.findUnique({ where: { seasonId } }),
    ]);
    if (!season || !draft) return { ok: false as const, error: "No draft" };
    if (!season.isActive || season.status !== SEASON_STATUS.DRAFT) {
      return { ok: false as const, error: "The auction is not in the Draft phase" };
    }
    if (
      expected &&
      (draft.updatedAt.getTime() !== expected.draftVersion ||
        draft.nominatorTeamId !== expected.nominatorTeamId ||
        draft.nominationEndsAt?.getTime() !== expected.nominationEndsAt)
    ) {
      return {
        ok: false as const,
        error: "The nomination turn changed — review the live room before acting.",
      };
    }
    if (draft.status !== DRAFT_STATUS.IN_PROGRESS)
      return { ok: false as const, error: "Draft is not live" };
    if (draft.nominatedUserId)
      return { ok: false as const, error: "A nomination is already in progress" };

    const nominator = await tx.team.findFirst({
      where: { id: draft.nominatorTeamId ?? "" },
      include: { _count: { select: { members: true } } },
    });
    if (!nominator) return { ok: false as const, error: "No team on the clock" };

    const isAdmin = viewer.role === "ADMIN";
    if (nominator.captainId !== viewer.id && !isAdmin)
      return { ok: false as const, error: "It's not your turn to nominate" };

    // Player must be signed up and not already drafted.
    const [reg, already] = await Promise.all([
      tx.registration.findUnique({
        where: { seasonId_userId: { seasonId, userId: playerId } },
      }),
      tx.teamMember.findUnique({
        where: { seasonId_userId: { seasonId, userId: playerId } },
      }),
    ]);
    if (!reg || reg.status !== "ACTIVE" || reg.type !== "PLAYER")
      return { ok: false as const, error: "Player is not available" };
    if (already) return { ok: false as const, error: "Player already drafted" };

    const team: DraftTeam = {
      id: nominator.id,
      budget: nominator.budget,
      rosterCount: nominator._count.members,
    };
    if (!Number.isInteger(amount) || amount < DEFAULTS.MIN_BID)
      return { ok: false as const, error: "Bid too low" };
    if (amount > maxBid(team, season.teamSize))
      return { ok: false as const, error: "You can't afford that opening bid" };

    const bidEndsAt = new Date(Date.now() + DEFAULTS.BID_TIMER_SECONDS * 1000);
    // Claim the nomination slot: if the auto-skip resolver (or an admin
    // nomination) landed between our read and this write, reject instead of
    // silently replacing a live auction.
    //
    // The claim also re-asserts the TURN the authorization above was judged
    // against — nominatorTeamId AND nominationEndsAt. `nominatedUserId: null`
    // alone misses the one rival that moves the turn while leaving the lot
    // empty: undoLastSale repoints nominatorTeamId to the refunded buyer with
    // a fresh clock. Without these, a captain's in-flight nomination composed
    // under the OLD turn landed after the undo — a lot opened out of turn,
    // and the buyer the undo promised the next nomination never got it. The
    // clock is included for the same reason the inhouse turn claim carries
    // pickEndsAt: the rotation can hand the SAME team a fresh turn, so team
    // id alone does not identify one.
    // Seam: the rival is undoLastSale repointing the rotation (nominatorTeamId
    // + a fresh clock, lot still empty) between this transaction's reads and
    // the claim. It only writes the Draft row, which this tx has READ but not
    // written — safe for a second connection (Postgres-only in tests; SQLite
    // pins one connection).
    await raceHook("draft.nominatePlayer.beforeClaim");
    const claim = await tx.draft.updateMany({
      where: {
        seasonId,
        status: DRAFT_STATUS.IN_PROGRESS,
        nominatedUserId: null,
        nominatorTeamId: draft.nominatorTeamId,
        nominationEndsAt: draft.nominationEndsAt,
        updatedAt: draft.updatedAt,
      },
      data: {
        nominatedUserId: playerId,
        currentBid: amount,
        currentBidTeamId: nominator.id,
        bidEndsAt,
        nominationEndsAt: null,
      },
    });
    if (claim.count === 0) {
      return {
        ok: false as const,
        error: "The draft just changed — check the clock and try again",
      };
    }
    await tx.bid.create({
      data: {
        draftId: draft.id,
        seasonId,
        teamId: nominator.id,
        userId: playerId,
        amount,
      },
    });
    return { ok: true as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if ((error as { code?: string }).code === "P2034") {
      return {
        ok: false,
        error: "The player pool or nomination turn just changed — review the room.",
      };
    }
    throw error;
  }
}

/** A captain raises the current high bid on the nominated player. */
export async function placeBid(
  seasonId: string,
  viewer: SessionUser,
  amount: number,
  expected?: DraftLotExpectation,
): Promise<DraftActionResult> {
  await resolveExpiredNomination(seasonId);

  return prisma.$transaction(async (tx) => {
    const [season, draft] = await Promise.all([
      tx.season.findUnique({ where: { id: seasonId } }),
      tx.draft.findUnique({ where: { seasonId } }),
    ]);
    if (!season || !draft) return { ok: false as const, error: "No draft" };
    if (!season.isActive || season.status !== SEASON_STATUS.DRAFT) {
      return { ok: false as const, error: "The auction is not in the Draft phase" };
    }
    if (
      expected &&
      (draft.updatedAt.getTime() !== expected.draftVersion ||
        draft.nominatedUserId !== expected.nominatedUserId ||
        draft.currentBid !== expected.currentBid ||
        draft.currentBidTeamId !== expected.currentBidTeamId ||
        draft.bidEndsAt?.getTime() !== expected.bidEndsAt)
    ) {
      return {
        ok: false as const,
        error: "The auction lot changed — review the live price before bidding.",
      };
    }
    if (draft.status !== DRAFT_STATUS.IN_PROGRESS || !draft.nominatedUserId)
      return { ok: false as const, error: "Nothing is up for auction" };
    if (!draft.bidEndsAt || draft.bidEndsAt.getTime() <= Date.now())
      return { ok: false as const, error: "Bidding has closed" };

    const myTeam = await tx.team.findFirst({
      where: { seasonId, captainId: viewer.id },
      include: { _count: { select: { members: true } } },
    });
    if (!myTeam) return { ok: false as const, error: "Only captains can bid" };
    if (draft.currentBidTeamId === myTeam.id)
      return { ok: false as const, error: "You already hold the high bid" };

    const team: DraftTeam = {
      id: myTeam.id,
      budget: myTeam.budget,
      rosterCount: myTeam._count.members,
    };
    if (!canBid(team, season.teamSize, amount, draft.currentBid))
      return { ok: false as const, error: "Invalid bid amount" };

    const bidEndsAt = new Date(Date.now() + DEFAULTS.BID_TIMER_SECONDS * 1000);
    // Optimistic lock: only apply the bid if the auction is still exactly as we
    // read it. If a concurrent bid landed first (possible under Postgres's
    // connection pool), the WHERE matches no rows and we reject — so two
    // simultaneous bids can never both "win".
    const applied = await tx.draft.updateMany({
      where: {
        seasonId,
        // The status belongs in the claim, not just the read above: an admin
        // pausing the auction between this transaction's read and its write
        // would otherwise have the bid land on a PAUSED draft AND re-arm
        // bidEndsAt, so the paused lot silently kept a running clock.
        status: DRAFT_STATUS.IN_PROGRESS,
        nominatedUserId: draft.nominatedUserId,
        currentBid: draft.currentBid,
        currentBidTeamId: draft.currentBidTeamId,
        bidEndsAt: draft.bidEndsAt,
        updatedAt: draft.updatedAt,
      },
      data: {
        currentBid: amount,
        currentBidTeamId: myTeam.id,
        bidEndsAt,
      },
    });
    if (applied.count === 0) {
      return { ok: false as const, error: "Another bid just landed — try again" };
    }
    await tx.bid.create({
      data: {
        draftId: draft.id,
        seasonId,
        teamId: myTeam.id,
        userId: draft.nominatedUserId,
        amount,
      },
    });
    return { ok: true as const };
  });
}
