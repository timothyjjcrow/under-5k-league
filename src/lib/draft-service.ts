import { prisma } from "./prisma";
import { DEFAULTS, DRAFT_STATUS } from "./constants";
import { steamIdToAccountId } from "./dota";
import {
  canBid,
  maxBid,
  teamNeed,
  nextNominatorIndex,
  type DraftTeam,
} from "./draft";
import type { SessionUser } from "./auth";
import {
  draftCompleteMessage,
  playerSoldMessage,
  sendDiscordMessage,
} from "./discord";

export type ActionResult = { ok: true } | { ok: false; error: string };

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
    if (!season) return false;

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

    const cleared = {
      nominatedUserId: null,
      currentBid: 0,
      currentBidTeamId: null,
      bidEndsAt: null,
    };
    if (nextIdx === -1 || poolDry) {
      await tx.draft.update({
        where: { seasonId },
        data: { ...cleared, nominationEndsAt: null, status: DRAFT_STATUS.COMPLETE },
      });
      completedSeasonName = season.name;
    } else {
      await tx.draft.update({
        where: { seasonId },
        data: {
          ...cleared,
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
  }
  return resolved;
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
    if (!season || !nominator) return false;
    if (teamNeed(season.teamSize, nominator._count.members) <= 0) return false;

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
      // though this team is short (they'll play with standins).
      await tx.draft.update({
        where: { seasonId },
        data: {
          nominatedUserId: null,
          currentBid: 0,
          currentBidTeamId: null,
          bidEndsAt: null,
          nominationEndsAt: null,
          status: DRAFT_STATUS.COMPLETE,
        },
      });
      completedSeasonName = season.name;
      return true;
    }

    const amount = DEFAULTS.MIN_BID;
    await tx.draft.update({
      where: { seasonId },
      data: {
        nominatedUserId: pick.userId,
        currentBid: amount,
        currentBidTeamId: nominator.id,
        bidEndsAt: new Date(Date.now() + DEFAULTS.BID_TIMER_SECONDS * 1000),
        nominationEndsAt: null,
      },
    });
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
  }
  return resolved;
}

async function loadTeamsWithCounts(seasonId: string) {
  const teams = await prisma.team.findMany({
    where: { seasonId },
    orderBy: { draftOrder: "asc" },
    include: {
      captain: true,
      members: { include: { user: true }, orderBy: { price: "desc" } },
    },
  });
  return teams;
}

/** Everything the draft room client needs, tailored to the viewing user. */
export async function getDraftState(seasonId: string, viewer: SessionUser | null) {
  await resolveExpiredNomination(seasonId);
  await resolveStalledNomination(seasonId);

  const [season, draft, teams, playerRegs, members] = await Promise.all([
    prisma.season.findUnique({ where: { id: seasonId } }),
    prisma.draft.findUnique({ where: { seasonId } }),
    loadTeamsWithCounts(seasonId),
    prisma.registration.findMany({
      where: { seasonId, status: "ACTIVE", type: "PLAYER" },
      include: { user: true },
      orderBy: { mmr: "desc" },
    }),
    prisma.teamMember.findMany({ where: { seasonId } }),
  ]);
  if (!season) return null;

  const draftedIds = new Set(members.map((m) => m.userId));
  const available = playerRegs
    .filter((r) => !draftedIds.has(r.userId))
    .map((r) => ({
      userId: r.userId,
      name: r.user.name,
      avatar: r.user.avatar,
      mmr: r.mmr,
      rankTier: r.user.rankTier,
      roles: r.roles,
    }));

  const teamViews = teams.map((t) => ({
    id: t.id,
    name: t.name,
    budget: t.budget,
    draftOrder: t.draftOrder,
    captainId: t.captainId,
    need: teamNeed(season.teamSize, t.members.length),
    members: t.members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      avatar: m.user.avatar,
      price: m.price,
      isCaptain: m.isCaptain,
      rankTier: m.user.rankTier,
    })),
  }));

  const myTeam = viewer
    ? teams.find((t) => t.captainId === viewer.id)
    : undefined;
  const isAdmin = viewer?.role === "ADMIN";
  const now = Date.now();
  const bidOpen =
    !!draft?.nominatedUserId &&
    !!draft?.bidEndsAt &&
    draft.bidEndsAt.getTime() > now;

  const myDraftTeam: DraftTeam | undefined = myTeam
    ? { id: myTeam.id, budget: myTeam.budget, rosterCount: myTeam.members.length }
    : undefined;

  // Sale history reconstructed from rostered members (newest first) so a
  // fresh page load can seed its live feed — the feed itself is client-side
  // state diffing and would otherwise start empty mid-draft.
  const recentSales = teams
    .flatMap((t) =>
      t.members
        .filter((m) => !m.isCaptain)
        .map((m) => ({
          name: m.user.name,
          teamName: t.name,
          price: m.price,
          at: m.createdAt.getTime(),
        })),
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);

  const nominatedPlayer = draft?.nominatedUserId
    ? (playerRegs.find((r) => r.userId === draft.nominatedUserId) ?? null)
    : null;

  return {
    status: draft?.status ?? DRAFT_STATUS.NOT_STARTED,
    teamSize: season.teamSize,
    minBid: DEFAULTS.MIN_BID,
    now,
    bidEndsAt: draft?.bidEndsAt ? draft.bidEndsAt.getTime() : null,
    nominationEndsAt: draft?.nominationEndsAt
      ? draft.nominationEndsAt.getTime()
      : null,
    nominatorTeamId: draft?.nominatorTeamId ?? null,
    currentBid: draft?.currentBid ?? 0,
    currentBidTeamId: draft?.currentBidTeamId ?? null,
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
          // Same derivation as /players: linked Dota account, else from Steam.
          accountId:
            nominatedPlayer.user.dotaAccountId ??
            steamIdToAccountId(nominatedPlayer.user.steamId),
          // Contact chip is for league members — the room is signed-in-gated
          // in practice, but keep the same rule as /players anyway.
          discordName: viewer ? nominatedPlayer.user.discordName : "",
          discordVerified: viewer ? !!nominatedPlayer.user.discordId : false,
        }
      : null,
    teams: teamViews,
    available,
    me: {
      userId: viewer?.id ?? null,
      isAdmin,
      myTeamId: myTeam?.id ?? null,
      isMyTurn: !!myTeam && draft?.nominatorTeamId === myTeam.id,
      canNominate:
        draft?.status === DRAFT_STATUS.IN_PROGRESS &&
        !draft?.nominatedUserId &&
        !!myDraftTeam &&
        draft?.nominatorTeamId === myTeam?.id &&
        teamNeed(season.teamSize, myDraftTeam.rosterCount) > 0,
      canBid:
        bidOpen &&
        !!myDraftTeam &&
        draft?.currentBidTeamId !== myTeam?.id &&
        maxBid(myDraftTeam, season.teamSize) > (draft?.currentBid ?? 0),
      myMaxBid: myDraftTeam ? maxBid(myDraftTeam, season.teamSize) : 0,
      myBudget: myTeam?.budget ?? 0,
    },
  };
}

export type DraftState = NonNullable<Awaited<ReturnType<typeof getDraftState>>>;

/** A captain (or admin, on their behalf) nominates a player with an opening bid. */
export async function nominatePlayer(
  seasonId: string,
  viewer: SessionUser,
  playerId: string,
  amount: number,
): Promise<ActionResult> {
  await resolveExpiredNomination(seasonId);

  return prisma.$transaction(async (tx) => {
    const [season, draft] = await Promise.all([
      tx.season.findUnique({ where: { id: seasonId } }),
      tx.draft.findUnique({ where: { seasonId } }),
    ]);
    if (!season || !draft) return { ok: false as const, error: "No draft" };
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
    await tx.draft.update({
      where: { seasonId },
      data: {
        nominatedUserId: playerId,
        currentBid: amount,
        currentBidTeamId: nominator.id,
        bidEndsAt,
        nominationEndsAt: null,
      },
    });
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
  });
}

/** A captain raises the current high bid on the nominated player. */
export async function placeBid(
  seasonId: string,
  viewer: SessionUser,
  amount: number,
): Promise<ActionResult> {
  await resolveExpiredNomination(seasonId);

  return prisma.$transaction(async (tx) => {
    const [season, draft] = await Promise.all([
      tx.season.findUnique({ where: { id: seasonId } }),
      tx.draft.findUnique({ where: { seasonId } }),
    ]);
    if (!season || !draft) return { ok: false as const, error: "No draft" };
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
        nominatedUserId: draft.nominatedUserId,
        currentBid: draft.currentBid,
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
