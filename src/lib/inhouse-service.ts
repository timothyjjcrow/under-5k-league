import { prisma } from "./prisma";
import {
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_STATUS,
} from "./constants";
import {
  nextPickTeam,
  orderCaptains,
  playersNeeded,
  tallyMethod,
  type CaptainCandidate,
  type CaptainMethod,
} from "./inhouse";
import { summarizeInhouse } from "./inhouse-stats";
import {
  fetchOpenDotaMatch,
  fetchRecentMatchIds,
  parseMatchId,
  steamIdToAccountId,
  type OpenDotaMatch,
} from "./dota";
import { classifyGame } from "./match-import";
import type { SessionUser } from "./auth";

export type ActionResult = { ok: true } | { ok: false; error: string };

// The transaction-scoped Prisma client type (also satisfied by `prisma` itself).
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const pickDeadline = () => new Date(Date.now() + INHOUSE.PICK_SECONDS * 1000);
const voteDeadline = () => new Date(Date.now() + INHOUSE.VOTE_SECONDS * 1000);

type Record = { wins: number; losses: number; winRate: number; games: number };

/** Inhouse win/loss records for a set of users, from their completed lobbies. */
async function loadRecords(
  db: Tx,
  userIds: string[],
): Promise<Map<string, Record>> {
  if (userIds.length === 0) return new Map();
  const lobbies = await db.inhouseLobby.findMany({
    where: {
      status: INHOUSE_STATUS.COMPLETED,
      players: { some: { userId: { in: userIds } } },
    },
    include: { players: { include: { user: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const recs = summarizeInhouse(
    lobbies.map((l) => ({
      id: l.id,
      winnerTeam: l.winnerTeam,
      createdAt: l.createdAt,
      players: l.players.map((p) => ({
        userId: p.userId,
        name: p.user.name,
        avatar: p.user.avatar,
        team: p.team,
      })),
    })),
  );
  return new Map(
    recs.map((r) => [
      r.userId,
      { wins: r.wins, losses: r.losses, winRate: r.winRate, games: r.games },
    ]),
  );
}

/**
 * Form a lobby when enough players are waiting. Idempotent + safe to call on
 * every poll: no-ops unless the single active-lobby slot is free AND the queue
 * has reached LOBBY_SIZE. The lobby opens in the CAPTAIN_VOTE phase — players
 * vote on how captains are chosen before the draft starts (resolveCaptainVote).
 */
export async function maybeFormLobby(): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const active = await tx.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: { id: true },
    });
    if (active) return false;

    const queue = await tx.inhouseQueueEntry.findMany({
      orderBy: { joinedAt: "asc" },
      take: INHOUSE.LOBBY_SIZE,
    });
    if (queue.length < INHOUSE.LOBBY_SIZE) return false;

    const lobby = await tx.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.CAPTAIN_VOTE,
        voteEndsAt: voteDeadline(),
        radiantTeam: 1,
      },
    });

    // Everyone starts in the pool with no captain; the vote decides the two.
    await tx.inhouseLobbyPlayer.createMany({
      data: queue.map((q) => ({
        lobbyId: lobby.id,
        userId: q.userId,
        mmr: q.mmr,
      })),
    });

    await tx.inhouseQueueEntry.deleteMany({
      where: { userId: { in: queue.map((q) => q.userId) } },
    });
    return true;
  });
}

/**
 * Resolve the captain-selection vote once everyone has voted or the timer runs
 * out: tally the winning method, rank candidates, install the top two as
 * captains, and drop into the draft. Idempotent; safe on every poll.
 */
export async function resolveCaptainVote(): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.CAPTAIN_VOTE },
      include: { players: true },
    });
    if (!lobby) return false;

    const allVoted =
      lobby.players.length > 0 && lobby.players.every((p) => p.votedMethod);
    const expired = !!lobby.voteEndsAt && lobby.voteEndsAt.getTime() <= Date.now();
    if (!allVoted && !expired) return false;

    const method = tallyMethod(
      lobby.players
        .map((p) => p.votedMethod)
        .filter((m): m is CaptainMethod => !!m),
    );

    const nominations = new Map<string, number>();
    for (const p of lobby.players) {
      if (p.votedNomineeId) {
        nominations.set(
          p.votedNomineeId,
          (nominations.get(p.votedNomineeId) ?? 0) + 1,
        );
      }
    }

    const records = await loadRecords(
      tx,
      lobby.players.map((p) => p.userId),
    );
    const candidates: CaptainCandidate[] = lobby.players.map((p) => {
      const r = records.get(p.userId);
      return {
        userId: p.userId,
        mmr: p.mmr,
        joinedAt: p.createdAt,
        nominations: nominations.get(p.userId) ?? 0,
        wins: r?.wins ?? 0,
        winRate: r?.winRate ?? 0,
        games: r?.games ?? 0,
      };
    });

    const ordered = orderCaptains(method, candidates);
    const team1 = ordered[0]?.userId;
    const team2 = ordered[1]?.userId;

    for (const p of lobby.players) {
      const team = p.userId === team1 ? 1 : p.userId === team2 ? 2 : null;
      if (team) {
        await tx.inhouseLobbyPlayer.update({
          where: { id: p.id },
          data: { team, isCaptain: true },
        });
      }
    }
    await tx.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        status: INHOUSE_STATUS.DRAFTING,
        voteEndsAt: null,
        pickTeam: INHOUSE.FIRST_PICK_TEAM,
        pickEndsAt: pickDeadline(),
      },
    });
    return true;
  });
}

/** Cast (or change) your captain-selection ballot during the CAPTAIN_VOTE phase. */
export async function castVote(
  viewer: SessionUser,
  method: string,
  nomineeId?: string,
): Promise<ActionResult> {
  const m = method as CaptainMethod;
  if (m !== "MMR" && m !== "RECORD" && m !== "VOTE") {
    return { ok: false, error: "Invalid vote" };
  }
  const res = await prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.CAPTAIN_VOTE },
      include: { players: true },
    });
    if (!lobby) return { ok: false as const, error: "Voting isn't open" };
    const mine = lobby.players.find((p) => p.userId === viewer.id);
    if (!mine) {
      return { ok: false as const, error: "Only players in the lobby can vote" };
    }
    let nominee: string | null = null;
    if (m === "VOTE") {
      if (!nomineeId) return { ok: false as const, error: "Pick a player to captain" };
      if (!lobby.players.some((p) => p.userId === nomineeId)) {
        return { ok: false as const, error: "That player isn't in this lobby" };
      }
      nominee = nomineeId;
    }
    await tx.inhouseLobbyPlayer.update({
      where: { id: mine.id },
      data: { votedMethod: m, votedNomineeId: nominee },
    });
    return { ok: true as const };
  });
  if (res.ok) await resolveCaptainVote(); // resolve early if that was the last vote
  return res;
}

/** Assign a pool player to the team currently on the clock and advance the draft. */
async function applyPick(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  lobbyId: string,
  targetUserId: string,
): Promise<ActionResult> {
  const lobby = await tx.inhouseLobby.findUnique({
    where: { id: lobbyId },
    include: { players: true },
  });
  if (!lobby || lobby.status !== INHOUSE_STATUS.DRAFTING || !lobby.pickTeam) {
    return { ok: false, error: "The draft isn't running" };
  }
  const target = lobby.players.find((p) => p.userId === targetUserId);
  if (!target) return { ok: false, error: "That player isn't in this lobby" };
  if (target.team !== null) return { ok: false, error: "Player already drafted" };

  const team = lobby.pickTeam;
  const picksMade = lobby.players.filter(
    (p) => p.team !== null && !p.isCaptain,
  ).length;

  await tx.inhouseLobbyPlayer.update({
    where: { id: target.id },
    data: { team, pickIndex: picksMade },
  });

  const team1Picks =
    lobby.players.filter((p) => p.team === 1 && !p.isCaptain).length +
    (team === 1 ? 1 : 0);
  const team2Picks =
    lobby.players.filter((p) => p.team === 2 && !p.isCaptain).length +
    (team === 2 ? 1 : 0);

  const next = nextPickTeam(team1Picks, team2Picks);
  if (next === null) {
    await tx.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        status: INHOUSE_STATUS.READY,
        pickTeam: null,
        pickEndsAt: null,
      },
    });
  } else {
    await tx.inhouseLobby.update({
      where: { id: lobby.id },
      data: { pickTeam: next, pickEndsAt: pickDeadline() },
    });
  }
  return { ok: true };
}

/**
 * If a captain lets their pick clock run out, auto-draft the top remaining
 * player for them so the lobby never stalls. Idempotent; safe on every poll.
 */
export async function resolveStalledPick(): Promise<boolean> {
  const res = await prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.DRAFTING, pickTeam: { not: null } },
      include: { players: true },
    });
    if (!lobby || !lobby.pickEndsAt || lobby.pickEndsAt.getTime() > Date.now()) {
      return false;
    }
    const pool = lobby.players
      .filter((p) => p.team === null)
      .sort(
        (a, b) => b.mmr - a.mmr || a.createdAt.getTime() - b.createdAt.getTime(),
      );
    if (pool.length === 0) return false;
    const r = await applyPick(tx, lobby.id, pool[0].userId);
    return r.ok;
  });
  return res;
}

/** A captain (or admin, on their behalf) drafts a player from the pool. */
export async function makePick(
  viewer: SessionUser,
  targetUserId: string,
): Promise<ActionResult> {
  await resolveStalledPick();
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.DRAFTING },
      include: { players: true },
    });
    if (!lobby || !lobby.pickTeam) {
      return { ok: false as const, error: "The draft isn't running" };
    }
    const isAdmin = viewer.role === "ADMIN";
    const captainOnClock = lobby.players.find(
      (p) => p.team === lobby.pickTeam && p.isCaptain,
    );
    if (!isAdmin && captainOnClock?.userId !== viewer.id) {
      return { ok: false as const, error: "It's not your turn to pick" };
    }
    return applyPick(tx, lobby.id, targetUserId);
  });
}

/** Add the current user to the inhouse queue (or refresh their seed MMR). */
export async function joinQueue(
  viewer: SessionUser,
  mmr: number,
): Promise<ActionResult> {
  const safeMmr = Number.isFinite(mmr)
    ? Math.max(0, Math.min(12000, Math.floor(mmr)))
    : 0;

  const inActiveLobby = await prisma.inhouseLobbyPlayer.findFirst({
    where: {
      userId: viewer.id,
      lobby: { status: { in: INHOUSE_ACTIVE_STATUSES } },
    },
    select: { id: true },
  });
  if (inActiveLobby) {
    return { ok: false, error: "You're already in a live inhouse" };
  }

  await prisma.inhouseQueueEntry.upsert({
    where: { userId: viewer.id },
    create: { userId: viewer.id, mmr: safeMmr },
    update: { mmr: safeMmr }, // keep original joinedAt so we don't lose queue position
  });
  await maybeFormLobby();
  return { ok: true };
}

/** Remove the current user from the queue. No-op if they're not queued. */
export async function leaveQueue(viewer: SessionUser): Promise<ActionResult> {
  await prisma.inhouseQueueEntry.deleteMany({ where: { userId: viewer.id } });
  return { ok: true };
}

/** Launch the game once teams are set — whoever hosts the in-client lobby. */
export async function startGame(viewer: SessionUser): Promise<ActionResult> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.READY },
      include: { players: true },
    });
    if (!lobby) return { ok: false as const, error: "No lobby is ready to start" };
    const isMember = lobby.players.some((p) => p.userId === viewer.id);
    if (!isMember && viewer.role !== "ADMIN") {
      return { ok: false as const, error: "Only players in the lobby can start it" };
    }
    await tx.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        status: INHOUSE_STATUS.IN_PROGRESS,
        startedById: viewer.id,
        startedAt: new Date(),
      },
    });
    return { ok: true as const };
  });
}

// ---- Result recording (OpenDota only — no manual winner) ------------------

type LobbyPlayerFull = {
  userId: string;
  team: number | null;
  user: { name: string; dotaAccountId: number | null; steamId: string };
};

// One per-player line of the stored box score (mirrors the league Game blob).
type BoxScorePlayer = {
  userId: string | null;
  name: string | null;
  team: number | null;
  isRadiant: boolean;
  heroId: number;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number | null;
  gpm: number | null;
};

type BuiltResult = {
  winnerTeam: number;
  radiantTeam: number;
  dotaMatchId: string;
  durationSecs: number;
  radiantScore: number;
  direScore: number;
  boxScore: BoxScorePlayer[];
  startTime: number;
};

/**
 * Validate a fetched OpenDota match against the lobby's two rosters and, if it's
 * genuinely this game, build the full result + per-player box score. Returns
 * null when the match isn't between these teams. Reuses the unit-tested
 * classifyGame (rosters on opposite sides → winner + which side was Radiant).
 */
function buildResult(
  od: OpenDotaMatch,
  players: LobbyPlayerFull[],
): BuiltResult | null {
  const accountMap = new Map<
    number,
    { userId: string; name: string; team: number }
  >();
  const team1 = new Set<number>();
  const team2 = new Set<number>();
  for (const p of players) {
    const acc = p.user.dotaAccountId ?? steamIdToAccountId(p.user.steamId);
    if (acc == null || p.team == null) continue;
    accountMap.set(acc, { userId: p.userId, name: p.user.name, team: p.team });
    (p.team === 1 ? team1 : team2).add(acc);
  }
  if (team1.size === 0 || team2.size === 0) return null;

  const cls = classifyGame(
    od,
    { teamId: "1", accountIds: team1 },
    { teamId: "2", accountIds: team2 },
    3,
  );
  if (!cls.ok || !cls.winnerTeamId) return null;

  const boxScore: BoxScorePlayer[] = od.players.map((pl) => {
    const isRadiant = pl.isRadiant ?? pl.player_slot < 128;
    const m = pl.account_id != null ? accountMap.get(pl.account_id) : undefined;
    return {
      userId: m?.userId ?? null,
      name: m?.name ?? pl.personaname ?? null,
      team: m?.team ?? null,
      isRadiant,
      heroId: pl.hero_id,
      kills: pl.kills,
      deaths: pl.deaths,
      assists: pl.assists,
      netWorth: pl.net_worth ?? null,
      gpm: pl.gold_per_min ?? null,
    };
  });

  return {
    winnerTeam: cls.winnerTeamId === "1" ? 1 : 2,
    radiantTeam: cls.radiantTeamId === "1" ? 1 : 2,
    dotaMatchId: String(od.match_id),
    durationSecs: od.duration,
    radiantScore: od.radiant_score ?? 0,
    direScore: od.dire_score ?? 0,
    boxScore,
    startTime: od.start_time,
  };
}

/** Write a built result onto the lobby and close it out. */
async function applyResult(lobbyId: string, r: BuiltResult) {
  await prisma.inhouseLobby.update({
    where: { id: lobbyId },
    data: {
      status: INHOUSE_STATUS.COMPLETED,
      winnerTeam: r.winnerTeam,
      radiantTeam: r.radiantTeam,
      dotaMatchId: r.dotaMatchId,
      durationSecs: r.durationSecs,
      radiantScore: r.radiantScore,
      direScore: r.direScore,
      boxScore: JSON.stringify(r.boxScore),
    },
  });
}

/**
 * Find this inhouse game on OpenDota: scan the 10 players' recent matches (in
 * parallel), take the one they share, validate it, and return the most recent
 * match that started after the lobby formed — so a prior game with the same
 * players can't be mistaken for this one.
 */
async function findInhouseGame(
  players: LobbyPlayerFull[],
  floorSeconds: number,
): Promise<BuiltResult | null> {
  const accounts = players
    .map((p) => p.user.dotaAccountId ?? steamIdToAccountId(p.user.steamId))
    .filter((a): a is number => a != null);
  if (accounts.length === 0) return null;

  const lists = await Promise.all(
    accounts.map((acc) => fetchRecentMatchIds(acc, 10)),
  );
  const counts = new Map<number, number>();
  for (const ids of lists) {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  // A game shared by several of our players is a candidate; buildResult does the
  // real validation. Cap the full-match fetches to keep API usage sane.
  const candidateIds = [...counts.entries()]
    .filter(([, c]) => c >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id]) => id);
  if (candidateIds.length === 0) return null;

  const matches = await Promise.all(
    candidateIds.map((id) => fetchOpenDotaMatch(String(id))),
  );
  let best: BuiltResult | null = null;
  for (const od of matches) {
    if (!od || od.start_time < floorSeconds) continue;
    const r = buildResult(od, players);
    if (r && (!best || r.startTime > best.startTime)) best = r;
  }
  return best;
}

/**
 * On-demand: look up the result on OpenDota by scanning the players' recent
 * games. Needs the game finished + public match data enabled.
 */
export async function autoDetectResult(
  viewer: SessionUser,
): Promise<ActionResult> {
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: INHOUSE_STATUS.IN_PROGRESS },
    include: { players: { include: { user: true } } },
  });
  if (!lobby) return { ok: false, error: "No game is in progress" };
  if (
    !lobby.players.some((p) => p.userId === viewer.id) &&
    viewer.role !== "ADMIN"
  ) {
    return { ok: false, error: "Only players in the game can do that" };
  }
  await prisma.inhouseLobby.update({
    where: { id: lobby.id },
    data: { detectedAt: new Date() },
  });
  const found = await findInhouseGame(
    lobby.players,
    Math.floor(lobby.createdAt.getTime() / 1000),
  );
  if (!found) {
    return {
      ok: false,
      error:
        "Couldn't find the game on OpenDota yet — make sure it's finished and players have 'Expose Public Match Data' on. You can also paste the match ID.",
    };
  }
  await applyResult(lobby.id, found);
  return { ok: true };
}

/** Record the result from a specific Dota match id/URL (fetched via OpenDota). */
export async function recordMatch(
  viewer: SessionUser,
  input: string,
): Promise<ActionResult> {
  const matchId = parseMatchId(input);
  if (!matchId) return { ok: false, error: "Enter a valid Dota match ID or link" };

  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: INHOUSE_STATUS.IN_PROGRESS },
    include: { players: { include: { user: true } } },
  });
  if (!lobby) return { ok: false, error: "No game is in progress" };
  if (
    !lobby.players.some((p) => p.userId === viewer.id) &&
    viewer.role !== "ADMIN"
  ) {
    return { ok: false, error: "Only players in the game can do that" };
  }

  const od = await fetchOpenDotaMatch(matchId);
  if (!od) {
    return {
      ok: false,
      error: "Couldn't fetch that match from OpenDota (is the ID right and public?)",
    };
  }
  const built = buildResult(od, lobby.players);
  if (!built) {
    return {
      ok: false,
      error: "That match isn't between these two teams — check the ID.",
    };
  }
  await applyResult(lobby.id, built);
  return { ok: true };
}

/**
 * Automatic, throttled result detection run on poll: once a game has been going
 * long enough, quietly try OpenDota at most once per interval and close the
 * lobby out if we find it. Safe to call on every poll (claims the attempt
 * atomically so concurrent pollers don't all scan). Idempotent.
 */
export async function maybeAutoDetectResult(): Promise<boolean> {
  const now = Date.now();
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: INHOUSE_STATUS.IN_PROGRESS },
    include: { players: { include: { user: true } } },
  });
  if (!lobby || !lobby.startedAt) return false;
  if (now - lobby.startedAt.getTime() < INHOUSE.DETECT_MIN_MINUTES * 60_000) {
    return false; // too early — the game can't be over yet
  }

  // Claim this attempt so only one concurrent poll actually hits OpenDota.
  const cutoff = new Date(now - INHOUSE.DETECT_INTERVAL_SECONDS * 1000);
  const claim = await prisma.inhouseLobby.updateMany({
    where: {
      id: lobby.id,
      status: INHOUSE_STATUS.IN_PROGRESS,
      OR: [{ detectedAt: null }, { detectedAt: { lt: cutoff } }],
    },
    data: { detectedAt: new Date(now) },
  });
  if (claim.count === 0) return false;

  const found = await findInhouseGame(
    lobby.players,
    Math.floor(lobby.createdAt.getTime() / 1000),
  );
  if (!found) return false;
  await applyResult(lobby.id, found);
  return true;
}

/** Admin: scrap the current lobby (stuck draft, no-shows). Players can requeue. */
export async function cancelLobby(viewer: SessionUser): Promise<ActionResult> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
  });
  if (!lobby) return { ok: false, error: "No active lobby" };
  await prisma.inhouseLobby.update({
    where: { id: lobby.id },
    data: { status: INHOUSE_STATUS.CANCELLED, pickTeam: null, pickEndsAt: null },
  });
  return { ok: true };
}

type PlayerView = {
  userId: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  mmr: number;
  pickIndex: number | null;
};

// The shape of a lobby-player row (with its joined user) that we read from.
type LobbyPlayerRow = {
  userId: string;
  mmr: number;
  pickIndex: number | null;
  user: { name: string; avatar: string | null; rankTier: number | null };
};

type VoteCandidate = PlayerView & {
  wins: number;
  losses: number;
  winRate: number;
  games: number;
  nominations: number;
};

type VoteBlock = {
  candidates: VoteCandidate[];
  methodTallies: { VOTE: number; MMR: number; RECORD: number };
  votedCount: number;
  voterCount: number;
};

/** Everything the inhouse room client needs, tailored to the viewing user. */
export async function getInhouseState(viewer: SessionUser | null) {
  await maybeFormLobby();
  await resolveCaptainVote();
  await resolveStalledPick();
  await maybeAutoDetectResult();

  const [queue, lobbyRow] = await Promise.all([
    prisma.inhouseQueueEntry.findMany({
      orderBy: { joinedAt: "asc" },
      include: { user: true },
    }),
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      include: {
        startedBy: true,
        players: { include: { user: true } },
      },
    }),
  ]);

  // Records are only needed to render (and rank) the captain vote.
  const records =
    lobbyRow?.status === INHOUSE_STATUS.CAPTAIN_VOTE
      ? await loadRecords(prisma, lobbyRow.players.map((p) => p.userId))
      : new Map<string, Record>();

  const now = Date.now();
  const toView = (p: LobbyPlayerRow): PlayerView => ({
    userId: p.userId,
    name: p.user.name,
    avatar: p.user.avatar,
    rankTier: p.user.rankTier,
    mmr: p.mmr,
    pickIndex: p.pickIndex,
  });

  let lobby: null | {
    id: string;
    status: string;
    voteEndsAt: number | null;
    pickTeam: number | null;
    pickEndsAt: number | null;
    radiantTeam: number;
    winnerTeam: number | null;
    startedByName: string | null;
    onClockCaptain: { userId: string; name: string } | null;
    teams: {
      team: number;
      isRadiant: boolean;
      captain: PlayerView | null;
      players: PlayerView[];
    }[];
    pool: PlayerView[];
    vote: VoteBlock | null;
  } = null;

  if (lobbyRow) {
    const buildTeam = (team: number) => {
      const members = lobbyRow.players.filter((p) => p.team === team);
      const captain = members.find((p) => p.isCaptain) ?? null;
      const picks = members
        .filter((p) => !p.isCaptain)
        .sort((a, b) => (a.pickIndex ?? 0) - (b.pickIndex ?? 0));
      return {
        team,
        isRadiant: lobbyRow.radiantTeam === team,
        captain: captain ? toView(captain) : null,
        players: picks.map(toView),
      };
    };
    const onClock = lobbyRow.pickTeam
      ? lobbyRow.players.find(
          (p) => p.team === lobbyRow.pickTeam && p.isCaptain,
        )
      : null;

    let vote: VoteBlock | null = null;
    if (lobbyRow.status === INHOUSE_STATUS.CAPTAIN_VOTE) {
      const nominations = new Map<string, number>();
      const methodTallies = { VOTE: 0, MMR: 0, RECORD: 0 };
      for (const p of lobbyRow.players) {
        if (p.votedNomineeId) {
          nominations.set(
            p.votedNomineeId,
            (nominations.get(p.votedNomineeId) ?? 0) + 1,
          );
        }
        if (p.votedMethod && p.votedMethod in methodTallies) {
          methodTallies[p.votedMethod as keyof typeof methodTallies] += 1;
        }
      }
      const candidates: VoteCandidate[] = lobbyRow.players
        .map((p) => {
          const r = records.get(p.userId);
          return {
            ...toView(p),
            wins: r?.wins ?? 0,
            losses: r?.losses ?? 0,
            winRate: r?.winRate ?? 0,
            games: r?.games ?? 0,
            nominations: nominations.get(p.userId) ?? 0,
          };
        })
        .sort((a, b) => b.mmr - a.mmr || a.name.localeCompare(b.name));
      vote = {
        candidates,
        methodTallies,
        votedCount: lobbyRow.players.filter((p) => p.votedMethod).length,
        voterCount: lobbyRow.players.length,
      };
    }

    lobby = {
      id: lobbyRow.id,
      status: lobbyRow.status,
      voteEndsAt: lobbyRow.voteEndsAt ? lobbyRow.voteEndsAt.getTime() : null,
      pickTeam: lobbyRow.pickTeam,
      pickEndsAt: lobbyRow.pickEndsAt ? lobbyRow.pickEndsAt.getTime() : null,
      radiantTeam: lobbyRow.radiantTeam,
      winnerTeam: lobbyRow.winnerTeam,
      startedByName: lobbyRow.startedBy?.name ?? null,
      onClockCaptain: onClock
        ? { userId: onClock.userId, name: onClock.user.name }
        : null,
      teams: [buildTeam(1), buildTeam(2)],
      pool: lobbyRow.players
        .filter((p) => p.team === null)
        .sort((a, b) => b.mmr - a.mmr || a.createdAt.getTime() - b.createdAt.getTime())
        .map(toView),
      vote,
    };
  }

  const myLobbyPlayer = viewer
    ? (lobbyRow?.players.find((p) => p.userId === viewer.id) ?? null)
    : null;
  const inQueue = viewer ? queue.some((q) => q.userId === viewer.id) : false;
  const inLobby = !!myLobbyPlayer;
  const isCaptain = !!myLobbyPlayer?.isCaptain;
  const myTeam = myLobbyPlayer?.team ?? null;

  const myVote = myLobbyPlayer?.votedMethod
    ? {
        method: myLobbyPlayer.votedMethod as CaptainMethod,
        nomineeId: myLobbyPlayer.votedNomineeId,
      }
    : null;

  return {
    now,
    lobbySize: INHOUSE.LOBBY_SIZE,
    teamSize: INHOUSE.TEAM_SIZE,
    pickSeconds: INHOUSE.PICK_SECONDS,
    voteSeconds: INHOUSE.VOTE_SECONDS,
    needed: playersNeeded(queue.length),
    queue: queue.map((q) => ({
      userId: q.userId,
      name: q.user.name,
      avatar: q.user.avatar,
      rankTier: q.user.rankTier,
      mmr: q.mmr,
    })),
    lobby,
    me: {
      userId: viewer?.id ?? null,
      isLoggedIn: !!viewer,
      isAdmin: viewer?.role === "ADMIN",
      inQueue,
      inLobby,
      myTeam,
      isCaptain,
      isOnClock:
        lobby?.status === INHOUSE_STATUS.DRAFTING &&
        isCaptain &&
        myTeam === lobby.pickTeam,
      canVote: lobby?.status === INHOUSE_STATUS.CAPTAIN_VOTE && inLobby,
      myVote,
      canJoin: !!viewer && !inQueue && !inLobby,
      canStart:
        lobby?.status === INHOUSE_STATUS.READY &&
        (inLobby || viewer?.role === "ADMIN"),
      canRecord:
        lobby?.status === INHOUSE_STATUS.IN_PROGRESS &&
        (inLobby || viewer?.role === "ADMIN"),
      canCancel: !!lobby && viewer?.role === "ADMIN",
    },
  };
}

export type InhouseState = Awaited<ReturnType<typeof getInhouseState>>;
