/**
 * Inhouse betting, end to end against a real database.
 *
 * The pure math is pinned in `src/lib/inhouse-bets.test.ts`; this file is about
 * everything that math can't see — the guarded claims, the ledger, the four
 * terminal paths a lobby can die down, and the one invariant that makes the
 * whole economy checkable:
 *
 *     for every account:  balance === Σ its ledger deltas
 *
 * The GRANT row IS the opening 500, so START_BALANCE is not added on top of the
 * sum — that would double-count it. `expectLedgerClosed` asserts the identity
 * and the once-ever grant together, and is called from most tests here rather
 * than only the fuzz, because a leg written without its receipt (or a receipt
 * written without its leg) is the failure mode that looks correct in every
 * individual assertion.
 *
 * A note on what is staged and what is raced, because this repo has been bitten
 * by the difference four times: staging the conflicting row before a call is
 * caught by the function's own READ-time check, so such a test passes against
 * code with no write-time guard at all. Nothing below stages a rival. Crash
 * recovery IS staged — deliberately, because "the request that won the claim
 * died" is a state, not a race — and the genuine contention tests use `raceN`
 * (concurrent on Postgres, sequential on SQLite) plus a `raceHook` seam for the
 * interleaving `Promise.all` cannot steer.
 *
 * ONE test in here reads SOURCE rather than the database (`[source]` in its
 * name), and its own comment says why: the branch it protects — `applyFloor`'s
 * compare-and-swap losing — needs a rival committing between two statements
 * INSIDE settlement's transaction, and there is no seam in there to steer one
 * with. Every no-rival run is byte-identical with the CAS and without it, so a
 * behavioural test of it would be vacuous. Stated rather than left looking like
 * coverage; if a seam ever lands in `applyFloor`, replace it with a real one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import {
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_BET_OUTCOME,
  INHOUSE_BET_STATUS,
  INHOUSE_BETS,
  INHOUSE_CRED_REASON,
  INHOUSE_STATUS,
} from "@/lib/constants";
import { steamIdToAccountId } from "@/lib/dota";
import type { SessionUser } from "@/lib/auth";
import {
  acceptMatch,
  cancelLobby,
  castVote,
  declineMatch,
  getInhouseState,
  joinQueue,
  makePick,
  recordMatch,
  resolveAbandonedLobby,
  startGame,
  voidLastResult,
} from "@/lib/inhouse-service";
import {
  adjustCred,
  credProfitBoard,
  ensureCredAccount,
  placeInhouseBet,
  resolveUnsettledBets,
  settleInhouseBets,
} from "@/lib/inhouse-bet-service";
import { runResultSync } from "@/lib/result-sync-service";
import {
  ON_POSTGRES,
  makeUser,
  raceAll,
  raceN,
  sessionFor,
} from "./factories";

// The inhouse result path only ever touches OpenDota. Stub the two network
// calls and keep steamIdToAccountId / classifyGame / buildResult real — the
// team reconciliation those do is exactly what the VOID_LINEUP rule reads.
vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchRecentMatchIds: vi.fn(async () => [] as number[]),
    fetchOpenDotaMatch: vi.fn(async () => null),
  };
});
import { fetchOpenDotaMatch, fetchRecentMatchIds } from "@/lib/dota";

// Discord sends are best-effort network calls; the formatters stay real, so
// what the void's correction actually SAYS is asserted here rather than mocked
// away — the message is the only thing that amends an already-published payout.
vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return { ...actual, sendInhouseDiscordMessage: vi.fn(async () => true) };
});
import { sendInhouseDiscordMessage } from "@/lib/discord";

// `logAdminAction` resolves the actor from the session rather than a parameter,
// so a forced cancel writes "(unknown)" with no cookie jar to read. Everything
// else in auth stays real — inhouse only imports the SessionUser TYPE from it.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getSessionUser: vi.fn(async () => ({ id: "admin-session", name: "Boss" })),
  };
});

const mockRecent = vi.mocked(fetchRecentMatchIds);
const mockMatch = vi.mocked(fetchOpenDotaMatch);

beforeEach(() => {
  mockRecent.mockReset();
  mockMatch.mockReset();
  mockRecent.mockResolvedValue([]);
  mockMatch.mockResolvedValue(null);
});
afterEach(() => setRaceHook(null));

// ---- harness ---------------------------------------------------------------

type Player = { user: Awaited<ReturnType<typeof makeUser>>; session: SessionUser };

/** A lobby that has finished drafting: teams locked, betting window open. */
type ReadyLobby = {
  admin: SessionUser;
  players: Player[];
  lobbyId: string;
  /** Both sides, captain first — five each. */
  t1: Player[];
  t2: Player[];
};

let userSeq = 0;

/** Queue ten fresh players; the tenth trips lobby formation. */
async function enqueue(mmrFor: (i: number) => number): Promise<Player[]> {
  const out: Player[] = [];
  for (let i = 0; i < INHOUSE.LOBBY_SIZE; i++) {
    const user = await makeUser(`Bet${userSeq++}`);
    const session = sessionFor(user);
    await joinQueue(session, mmrFor(i));
    out.push({ user, session });
  }
  return out;
}

/** Re-queue an existing cohort — the same ten play a second game. */
async function reQueue(players: Player[], mmrFor: (i: number) => number) {
  for (const [i, p] of players.entries()) await joinQueue(p.session, mmrFor(i));
}

/** Accept the ready check, then vote MMR captains (the last vote resolves it). */
async function voteThrough(players: Player[]) {
  for (const p of players) await acceptMatch(p.session);
  for (const p of players) await castVote(p.session, "MMR");
}

/** Admin-drive the draft: always take the top-MMR player left in the pool. */
async function draftOut(admin: SessionUser) {
  for (let guard = 0; guard < 30; guard++) {
    const lobby = await prisma.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.DRAFTING },
      include: { players: true },
    });
    if (!lobby) return;
    const pool = lobby.players
      .filter((p) => p.team === null)
      .sort((a, b) => b.mmr - a.mmr);
    if (pool.length === 0) return;
    const r = await makePick(admin, pool[0].userId);
    if (!r.ok) throw new Error(`pick failed: ${r.error}`);
  }
  throw new Error("draft did not reach READY");
}

/** Group a READY lobby's roster into the two sides, captain first. */
async function sidesOf(lobbyId: string, players: Player[]) {
  const rows = await prisma.inhouseLobbyPlayer.findMany({ where: { lobbyId } });
  const byId = new Map(players.map((p) => [p.user.id, p]));
  const side = (team: number) =>
    rows
      .filter((r) => r.team === team)
      .sort((a, b) => (a.pickIndex ?? -1) - (b.pickIndex ?? -1))
      .map((r) => byId.get(r.userId)!);
  return { t1: side(1), t2: side(2) };
}

/** Queue → vote → draft. Returns a READY lobby with its betting window open. */
async function readyLobby(): Promise<ReadyLobby> {
  const admin = sessionFor(await makeUser(`BetAdmin${userSeq++}`, "ADMIN"));
  const players = await enqueue((i) => 5000 - i * 100);
  await voteThrough(players);
  await draftOut(admin);
  const lobby = await prisma.inhouseLobby.findFirstOrThrow({
    where: { status: INHOUSE_STATUS.READY },
    orderBy: { createdAt: "desc" },
  });
  const { t1, t2 } = await sidesOf(lobby.id, players);
  return { admin, players, lobbyId: lobby.id, t1, t2 };
}

/** Reuse a cohort for a second game (the floor's once-a-day rule needs two). */
async function nextLobby(prev: ReadyLobby): Promise<ReadyLobby> {
  await reQueue(prev.players, (i) => 5000 - i * 100);
  await voteThrough(prev.players);
  await draftOut(prev.admin);
  const lobby = await prisma.inhouseLobby.findFirstOrThrow({
    where: { status: INHOUSE_STATUS.READY },
    orderBy: { createdAt: "desc" },
  });
  const { t1, t2 } = await sidesOf(lobby.id, prev.players);
  return { ...prev, lobbyId: lobby.id, t1, t2 };
}

/** Each player's OpenDota account id, mirroring buildResult's own mapping. */
async function accountOf(players: Player[]): Promise<Map<string, number>> {
  const rows = await prisma.user.findMany({
    where: { id: { in: players.map((p) => p.user.id) } },
    select: { id: true, steamId: true, dotaAccountId: true },
  });
  return new Map(
    rows.map((u) => [u.id, u.dotaAccountId ?? steamIdToAccountId(u.steamId)!]),
  );
}

/**
 * A whole-second start time that is provably AFTER every bet already placed.
 *
 * OpenDota reports `start_time` in whole seconds, so the obvious
 * `floor(Date.now()/1000)` can land up to 999ms in the PAST — before a bet
 * placed earlier in the same second — and void an entire pot as VOID_LATE.
 * That would be a flake keyed to the wall clock's sub-second phase, green all
 * morning and red once in twenty runs. `+1` is the smallest value that cannot.
 */
function startTimeAfterNow(): number {
  return Math.floor(Date.now() / 1000) + 1;
}

/** An OpenDota match payload with explicit per-side account lists. */
function odMatch(opts: {
  matchId: number;
  radiant: number[];
  dire: number[];
  radiantWin: boolean;
  startTimeSec: number;
  durationSecs?: number;
}) {
  const line = (accountId: number, i: number, isRadiant: boolean) => ({
    account_id: accountId,
    player_slot: isRadiant ? i : 128 + i,
    hero_id: i + 1,
    isRadiant,
    kills: isRadiant ? 10 : 3,
    deaths: isRadiant ? 3 : 10,
    assists: 8,
    personaname: `p${accountId}`,
    net_worth: 20000 - i * 500,
    gold_per_min: 500,
    last_hits: 200,
  });
  return {
    match_id: opts.matchId,
    radiant_win: opts.radiantWin,
    duration: opts.durationSecs ?? 2400,
    start_time: opts.startTimeSec,
    radiant_score: 30,
    dire_score: 20,
    players: [
      ...opts.radiant.map((a, i) => line(a, i, true)),
      ...opts.dire.map((a, i) => line(a, i, false)),
    ],
  };
}

let matchSeq = 9_100_000;

/** What `stageGame` needs to build the played game. */
type PlayOpts = {
  /** Which drafted side wins. Team 1 is Radiant in the payload below. */
  winner: 1 | 2;
  durationSecs?: number;
  startTimeSec?: number;
  /** Drafted-team-1 player who actually played Dire, and vice versa. */
  swap?: { fromT1: Player; fromT2: Player };
};

/**
 * Start the game and hand OpenDota the match it produced, WITHOUT recording it.
 *
 * Split out of `playAndRecord` so a test can record the same staged game twice
 * — which is what a request dying mid-claim looks like from the outside: the
 * match id is still valid, the lobby is still IN_PROGRESS, and the admin simply
 * presses the button again.
 *
 * `swap` stages the one thing that makes VOID_LINEUP reachable: a player who
 * clicked the wrong slot in the hand-hosted Dota lobby and physically played
 * the other side. It is not a race — it is what the played game says happened.
 */
async function stageGame(ctx: ReadyLobby, opts: PlayOpts): Promise<number> {
  const started = await startGame(ctx.t1[0].session);
  if (!started.ok) throw new Error(`startGame failed: ${started.error}`);

  const acc = await accountOf(ctx.players);
  let radiantIds = ctx.t1.map((p) => acc.get(p.user.id)!);
  let direIds = ctx.t2.map((p) => acc.get(p.user.id)!);
  if (opts.swap) {
    const a = acc.get(opts.swap.fromT1.user.id)!;
    const z = acc.get(opts.swap.fromT2.user.id)!;
    radiantIds = radiantIds.filter((id) => id !== a).concat(z);
    direIds = direIds.filter((id) => id !== z).concat(a);
  }

  const matchId = matchSeq++;
  mockMatch.mockResolvedValue(
    odMatch({
      matchId,
      radiant: radiantIds,
      dire: direIds,
      // team 1 is the Radiant majority, so radiant_win decides in its terms.
      radiantWin: opts.winner === 1,
      startTimeSec: opts.startTimeSec ?? startTimeAfterNow(),
      durationSecs: opts.durationSecs,
    }) as never,
  );
  return matchId;
}

/**
 * Play the game out and record it through the ordinary paste path — so
 * settlement runs where production runs it (inside applyResult, after the
 * teamFixes loop).
 */
async function playAndRecord(ctx: ReadyLobby, opts: PlayOpts) {
  const matchId = await stageGame(ctx, opts);
  const res = await recordMatch(ctx.admin, String(matchId));
  if (!res.ok) throw new Error(`recordMatch failed: ${res.error}`);
  return matchId;
}

// ---- assertions ------------------------------------------------------------

async function balanceOf(userId: string): Promise<number> {
  const row = await prisma.inhouseCredit.findUnique({ where: { userId } });
  return row?.balance ?? INHOUSE_BETS.START_BALANCE;
}

async function ledgerOf(userId: string) {
  return prisma.inhouseCreditEntry.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * THE invariant: every account's balance is exactly the sum of its receipts,
 * and the opening grant was written once. A movement with no receipt (or a
 * receipt with no movement) is the one bug class that leaves every other
 * assertion in this file passing.
 */
async function expectLedgerClosed() {
  const accounts = await prisma.inhouseCredit.findMany();
  for (const acct of accounts) {
    const entries = await ledgerOf(acct.userId);
    const sum = entries.reduce((s, e) => s + e.delta, 0);
    expect({ user: acct.userId, balance: acct.balance }).toEqual({
      user: acct.userId,
      // Not START_BALANCE + Σ: the GRANT row IS the opening balance, so adding
      // it again would hide a missing 500 in every account at once.
      balance: sum,
    });
    const grants = entries.filter(
      (e) => e.reason === INHOUSE_CRED_REASON.GRANT,
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].delta).toBe(INHOUSE_BETS.START_BALANCE);
  }
}

/**
 * Betting is zero-sum: matched Cred moves between the ten and is never created
 * or destroyed. Summed over the PROFIT reasons (which excludes the two faucets,
 * GRANT and FLOOR, and the admin ADJUST escape hatch) the whole league must sit
 * at exactly zero, forever.
 */
async function expectZeroSum() {
  const board = await credProfitBoard();
  const total = [...board.values()].reduce((s, v) => s + v, 0);
  expect(total).toBe(0);
}

/**
 * Move an account to an exact balance THROUGH THE LEDGER.
 *
 * Never `inhouseCredit.update({ balance })` in a test: a bare column write is
 * money with no receipt, and `expectLedgerClosed` — the assertion most of these
 * tests lean on — would then fail on the setup rather than the behaviour, or
 * worse, be quietly dropped from the tests that need it most.
 */
async function drainTo(admin: SessionUser, userId: string, target: number) {
  await ensureCredAccount(userId);
  const balance = await balanceOf(userId);
  if (balance === target) return;
  const res = await adjustCred(admin, userId, target - balance, "test setup");
  if (!res.ok) throw new Error(`drainTo failed: ${res.error}`);
}

const betRow = (lobbyId: string, userId: string) =>
  prisma.inhouseBet.findUniqueOrThrow({
    where: { lobbyId_userId: { lobbyId, userId } },
  });

/**
 * The body of `applyFloor`, for the one guard in this file that reads source.
 *
 * A function ends at the first `}` in column 0 — everything nested is indented
 * — which is enough for a file that is one module of plain functions, and it
 * fails loudly (a `-1` index) rather than silently matching the wrong thing if
 * that ever stops being true.
 */
function floorSource(): string {
  const src = readFileSync(
    path.join(process.cwd(), "src/lib/inhouse-bet-service.ts"),
    "utf8",
  );
  const at = src.indexOf("async function applyFloor(");
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

// ---------------------------------------------------------------------------

describe("inhouse betting — placement gates", () => {
  it("refuses a spectator: eligibility is roster membership, never a session", async () => {
    const ctx = await readyLobby();
    const outsider = sessionFor(await makeUser("Nosy"));

    const res = await placeInhouseBet(outsider, 50);
    expect(res).toEqual({ ok: false, error: "You're not in this game." });
    expect(await prisma.inhouseBet.count()).toBe(0);
    // They DO get an account — `ensureCredAccount` runs outside the transaction
    // so the debit is that transaction's first write, and it runs before the
    // gate. Harmless (a funded account nobody can spend from this lobby) but
    // surprising enough to pin: the assertion someone would reach for here is
    // "nothing at all was written", and it would be wrong.
    expect(await balanceOf(outsider.id)).toBe(INHOUSE_BETS.START_BALANCE);
    const state = await getInhouseState(outsider);
    expect(state.lobby?.id).toBe(ctx.lobbyId);
    expect(state.lobby?.pot?.slips).toEqual([]);
    expect(state.me.canBet).toBe(false);
    await expectLedgerClosed();
  });

  it("has no way to buy a position on the other team — the side is server-derived", async () => {
    const ctx = await readyLobby();
    // The action takes a stake and nothing else. There is no side parameter to
    // tamper with, and the confirmation write re-asserts membership of THAT
    // side (`players: { some: { userId, team } }`), so an alt or a proxy has
    // nothing to aim at.
    expect((await placeInhouseBet(ctx.t1[0].session, 50)).ok).toBe(true);
    expect((await placeInhouseBet(ctx.t2[0].session, 50)).ok).toBe(true);

    expect((await betRow(ctx.lobbyId, ctx.t1[0].user.id)).team).toBe(1);
    expect((await betRow(ctx.lobbyId, ctx.t2[0].user.id)).team).toBe(2);
  });

  it("refuses before the teams lock, and stamps no window until READY", async () => {
    const admin = sessionFor(await makeUser("BetAdminEarly", "ADMIN"));
    const players = await enqueue((i) => 5000 - i * 100);

    // READY_CHECK: the window is four phases away.
    let lobby = await prisma.inhouseLobby.findFirstOrThrow({});
    expect(lobby.status).toBe(INHOUSE_STATUS.READY_CHECK);
    expect(lobby.betsCloseAt).toBeNull();
    // The wording is the OWN-TEAM refusal, not the phase one, and that is worth
    // knowing before someone "fixes" it: `placeInhouseBet` looks up a lobby
    // filtered to READY/IN_PROGRESS, so a pre-READY lobby isn't found at all
    // and `myTeam` arrives null — indistinguishable, from betGateError's
    // inputs, from a spectator. The phase sentence below therefore belongs to
    // the ROOM's call of the same pure gate (labelling a disabled chip from a
    // payload that does carry the status), which is where the unit test covers
    // it. Nobody meets this sentence by tapping: `me.canBet` is false in every
    // pre-READY phase, so no chip is offered.
    expect(await placeInhouseBet(players[0].session, 50)).toEqual({
      ok: false,
      error: "You're not in this game.",
    });

    // DRAFTING: still nothing to bet on — the sides don't exist yet.
    await voteThrough(players);
    lobby = await prisma.inhouseLobby.findFirstOrThrow({});
    expect(lobby.status).toBe(INHOUSE_STATUS.DRAFTING);
    expect(lobby.betsCloseAt).toBeNull();
    // …including from an installed CAPTAIN, who by then does have a side. The
    // refusal is structural (no bettable lobby exists yet), not a check anyone
    // could regress by editing a status list.
    const capId = (
      await prisma.inhouseLobbyPlayer.findFirstOrThrow({
        where: { lobbyId: lobby.id, isCaptain: true },
      })
    ).userId;
    const cap = players.find((p) => p.user.id === capId)!;
    expect((await placeInhouseBet(cap.session, 50)).ok).toBe(false);

    // READY stamps the window in the same claim as the status.
    await draftOut(admin);
    lobby = await prisma.inhouseLobby.findFirstOrThrow({});
    expect(lobby.status).toBe(INHOUSE_STATUS.READY);
    expect(lobby.betsCloseAt).not.toBeNull();
    const openFor = lobby.betsCloseAt!.getTime() - Date.now();
    expect(openFor).toBeGreaterThan(0);
    expect(openFor).toBeLessThanOrEqual(INHOUSE_BETS.WINDOW_SECONDS * 1000);
    expect(await prisma.inhouseBet.count()).toBe(0);
  });

  it("refuses once the window has closed, and never charges for the attempt", async () => {
    const ctx = await readyLobby();
    await prisma.inhouseLobby.update({
      where: { id: ctx.lobbyId },
      data: { betsCloseAt: new Date(Date.now() - 1000) },
    });

    expect(await placeInhouseBet(ctx.t1[0].session, 50)).toEqual({
      ok: false,
      error: "Betting has closed on this game.",
    });
    expect(await balanceOf(ctx.t1[0].user.id)).toBe(INHOUSE_BETS.START_BALANCE);
    expect(await prisma.inhouseBet.count()).toBe(0);
    await expectLedgerClosed();
  });

  it("pressing Start does NOT close the window", async () => {
    // Deliberate: nobody should ever be the person who cut the betting short,
    // and Start has to stay instant. The window closes on `betsCloseAt` alone.
    const ctx = await readyLobby();
    expect((await startGame(ctx.t1[0].session)).ok).toBe(true);
    expect((await placeInhouseBet(ctx.t1[1].session, 30)).ok).toBe(true);

    const bet = await betRow(ctx.lobbyId, ctx.t1[1].user.id);
    expect(bet.confirmedAt).not.toBeNull();
  });

  it("refuses stakes below MIN, above MAX, and off the STEP", async () => {
    const ctx = await readyLobby();
    const me = ctx.t1[0].session;
    const band = `A bet is ${INHOUSE_BETS.MIN_STAKE}–${INHOUSE_BETS.MAX_STAKE} Cred.`;
    const step = `Bets go in ${INHOUSE_BETS.STEP}s of Cred.`;

    // Off-step is checked before the band, so 5 and 105 report the step rule.
    expect(await placeInhouseBet(me, 5)).toEqual({ ok: false, error: step });
    expect(await placeInhouseBet(me, 15)).toEqual({ ok: false, error: step });
    expect(await placeInhouseBet(me, 10.5)).toEqual({ ok: false, error: step });
    // On-step but outside the band.
    expect(await placeInhouseBet(me, 0)).toEqual({ ok: false, error: band });
    expect(await placeInhouseBet(me, -10)).toEqual({ ok: false, error: band });
    expect(
      await placeInhouseBet(me, INHOUSE_BETS.MAX_STAKE + INHOUSE_BETS.STEP),
    ).toEqual({ ok: false, error: band });

    // The two edges are legal.
    expect((await placeInhouseBet(me, INHOUSE_BETS.MIN_STAKE)).ok).toBe(true);
    expect((await placeInhouseBet(ctx.t1[1].session, INHOUSE_BETS.MAX_STAKE)).ok).toBe(
      true,
    );
    expect(await prisma.inhouseBet.count()).toBe(2);
    await expectLedgerClosed();
  });

  it("refuses a stake the player can't afford, and the debit's own WHERE agrees", async () => {
    const ctx = await readyLobby();
    const me = ctx.t1[0];
    await drainTo(ctx.admin, me.user.id, 30);

    expect(await placeInhouseBet(me.session, 50)).toEqual({
      ok: false,
      error: "Not enough Cred — you have 30.",
    });
    expect(await balanceOf(me.user.id)).toBe(30);
    // What they CAN afford still goes through, to the last Cred.
    expect((await placeInhouseBet(me.session, 30)).ok).toBe(true);
    expect(await balanceOf(me.user.id)).toBe(0);
    await expectLedgerClosed();
  });

  it("is single-shot: a second bet is refused and never debits twice", async () => {
    const ctx = await readyLobby();
    const me = ctx.t1[0];

    expect((await placeInhouseBet(me.session, 50)).ok).toBe(true);
    // Same amount, a different amount, and the other direction all refuse:
    // a bet is immutable — no raise, no withdraw, no side switch.
    expect(await placeInhouseBet(me.session, 50)).toEqual({
      ok: false,
      error: "You already have a bet on this game.",
    });
    expect((await placeInhouseBet(me.session, 100)).ok).toBe(false);

    expect(await balanceOf(me.user.id)).toBe(INHOUSE_BETS.START_BALANCE - 50);
    expect(
      await prisma.inhouseBet.count({ where: { userId: me.user.id } }),
    ).toBe(1);
    expect(
      await prisma.inhouseCreditEntry.count({
        where: { userId: me.user.id, reason: INHOUSE_CRED_REASON.STAKE },
      }),
    ).toBe(1);
    await expectLedgerClosed();
  });

  it("two simultaneous bets from one player produce exactly one debit", async () => {
    // RACED, not staged. Staging a bet row first is caught by the read-time
    // `alreadyBet` count, so that version of this test passes against a service
    // with no @@unique behind it at all. `raceN` is concurrent on Postgres
    // (`npm run test:pg`) and sequential here, where SQLite serialises writers.
    const ctx = await readyLobby();
    const me = ctx.t1[0];

    const results = await raceN(2, () => placeInhouseBet(me.session, 100));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await balanceOf(me.user.id)).toBe(INHOUSE_BETS.START_BALANCE - 100);
    expect(await prisma.inhouseBet.count()).toBe(1);
    await expectLedgerClosed();
  });

  it("an admin deduction racing a bet cannot overdraw the account", async () => {
    // THE test for `balance: { gte: stake }` in placeInhouseBet's debit, and
    // the one the mutation ratchet proved was missing: with the predicate
    // deleted, the suite still passed.
    //
    // Why the test above does NOT cover it — this is the "something upstream
    // serializes this" trap CLAUDE.md warns about, and it caught us here too.
    // Racing one player against THEMSELVES on one lobby is stopped by
    // @@unique([lobbyId, userId]): the loser's bet create raises P2002, which
    // rolls its own transaction back — debit included. So the balance
    // predicate is never the thing that fires, and deleting it changes
    // nothing. The rival has to come from a DIFFERENT PATH.
    //
    // `adjustCred` is that path. An admin correcting someone's balance while
    // that player places their FIRST bet on the lobby meets no unique
    // constraint at all, and the two writes touch the same row from two
    // connections. Unguarded, the account goes NEGATIVE — a state nothing else
    // in the system can produce, whose only symptom is a player later unable
    // to bet for no reason anyone can see.
    const ctx = await readyLobby();
    const me = ctx.t1[0];
    const admin = ctx.admin;
    await drainTo(admin, me.user.id, 100);

    // Both want the same 100. Exactly one may have it. `raceAll` is concurrent
    // on Postgres and sequential on SQLite, so this only has real contention
    // under `npm run test:pg` — which is where it belongs.
    const [adjusted, bet] = await raceAll([
      () => adjustCred(admin, me.user.id, -100, "clawback racing a bet"),
      () => placeInhouseBet(me.session, 100),
    ]);

    const balance = await balanceOf(me.user.id);
    expect(balance).toBeGreaterThanOrEqual(0);
    // Exactly one of the two claimed it; whichever lost says so rather than
    // silently half-applying.
    expect([adjusted.ok, bet.ok].filter(Boolean)).toHaveLength(1);
    expect(balance).toBe(0);
    // And the books still close — a lost race must leave no orphan receipt.
    await expectLedgerClosed();
  });

  it("publishes the pot the instant a bet lands — slips, coverage and the viewer's own slip", async () => {
    const ctx = await readyLobby();
    await placeInhouseBet(ctx.t1[0].session, 100);
    await placeInhouseBet(ctx.t2[0].session, 40);

    const state = await getInhouseState(ctx.t1[0].session);
    const pot = state.lobby?.pot;
    expect(pot).not.toBeNull();
    expect(pot!.pool1).toBe(100);
    expect(pot!.pool2).toBe(40);
    expect(pot!.matched).toBe(40);
    expect(pot!.closesAt).not.toBeNull();
    // Public: every slip is visible to everyone, because the panel is a live
    // argument and a pot nobody can see is an argument nobody can join.
    expect(pot!.slips.map((s) => [s.userId, s.stake, s.covered])).toEqual([
      [ctx.t1[0].user.id, 100, 40],
      [ctx.t2[0].user.id, 40, 40],
    ]);
    // The viewer's own slip is read off the SAME potView, so "40 of your 100 is
    // covered" and the payout can't disagree by a Cred.
    expect(state.me.myBet).toEqual({ stake: 100, team: 1, covered: 40 });
    expect(state.me.cred).toBe(INHOUSE_BETS.START_BALANCE - 100);
    expect(state.me.canBet).toBe(false); // already in
    const other = await getInhouseState(ctx.t1[1].session);
    expect(other.me.canBet).toBe(true);
    expect(other.me.myBet).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The design doc's three worked examples, asserted to the Cred. If one of these
// moves, the doc and the code have parted company — fix whichever is wrong, but
// never quietly re-baseline the numbers.
// ---------------------------------------------------------------------------

describe("inhouse betting — settlement, the three worked examples", () => {
  it("1: balanced pool (200 v 200), the favoured side wins", async () => {
    const ctx = await readyLobby();
    const [kessler, roo, vex, bo] = ctx.t1;
    const [dooley, mig, nine] = ctx.t2;
    for (const [p, s] of [
      [kessler, 100],
      [roo, 50],
      [vex, 40],
      [bo, 10],
      [dooley, 100],
      [mig, 60],
      [nine, 40],
    ] as const) {
      expect((await placeInhouseBet(p.session, s)).ok).toBe(true);
    }

    await playAndRecord(ctx, { winner: 1 });

    // Both sides matched at ratio 1.0 — everyone's whole stake was live.
    expect(await balanceOf(kessler.user.id)).toBe(600);
    expect(await balanceOf(roo.user.id)).toBe(550);
    expect(await balanceOf(vex.user.id)).toBe(540);
    expect(await balanceOf(bo.user.id)).toBe(510);
    expect(await balanceOf(dooley.user.id)).toBe(400);
    expect(await balanceOf(mig.user.id)).toBe(440);
    expect(await balanceOf(nine.user.id)).toBe(460);

    const lobby = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: ctx.lobbyId },
    });
    expect(lobby.betSettlement).toBe(INHOUSE_BET_STATUS.SETTLED);
    const deltas = JSON.parse(lobby.betDeltas) as Record<string, number>;
    expect(deltas[kessler.user.id]).toBe(100);
    expect(deltas[dooley.user.id]).toBe(-100);
    expect(Object.values(deltas).reduce((s, v) => s + v, 0)).toBe(0);

    const row = await betRow(ctx.lobbyId, kessler.user.id);
    expect(row).toMatchObject({
      outcome: INHOUSE_BET_OUTCOME.WON,
      matched: 100,
      payout: 100,
    });
    expect(row.settledAt).not.toBeNull();

    // The room's post-game banner reads betDeltas, never re-derives the pot.
    const state = await getInhouseState(dooley.session);
    expect(state.lastResult?.credDelta).toBe(-100);

    await expectLedgerClosed();
    await expectZeroSum();
  });

  it("2: the underdog side out-stakes the favourite (120 v 280) and wins", async () => {
    const ctx = await readyLobby();
    const [ash, boT1] = ctx.t1;
    const [dooley, mig, nine, pia] = ctx.t2;
    for (const [p, s] of [
      [ash, 100],
      [boT1, 20],
      [dooley, 100],
      [mig, 100],
      [nine, 60],
      [pia, 20],
    ] as const) {
      expect((await placeInhouseBet(p.session, s)).ok).toBe(true);
    }

    await playAndRecord(ctx, { winner: 2 });

    // M = 120. Short side (team 1) matched 1.0; the long side takes
    // 120/280 by largest remainder: 43 / 43 / 26 / 8 — summing to 120 exactly.
    expect((await betRow(ctx.lobbyId, dooley.user.id)).matched).toBe(43);
    expect((await betRow(ctx.lobbyId, mig.user.id)).matched).toBe(43);
    expect((await betRow(ctx.lobbyId, nine.user.id)).matched).toBe(26);
    expect((await betRow(ctx.lobbyId, pia.user.id)).matched).toBe(8);
    expect((await betRow(ctx.lobbyId, ash.user.id)).matched).toBe(100);

    // The underdog side's extra 160 was never live and comes home untouched.
    expect(await balanceOf(dooley.user.id)).toBe(543);
    expect(await balanceOf(mig.user.id)).toBe(543);
    expect(await balanceOf(nine.user.id)).toBe(526);
    expect(await balanceOf(pia.user.id)).toBe(508);
    expect(await balanceOf(ash.user.id)).toBe(400);
    expect(await balanceOf(boT1.user.id)).toBe(480);

    await expectLedgerClosed();
    await expectZeroSum();
  });

  it("3: lopsided (500 v 20) — staking 500 against 20 wins 20", async () => {
    const ctx = await readyLobby();
    for (const p of ctx.t1) {
      expect((await placeInhouseBet(p.session, INHOUSE_BETS.MAX_STAKE)).ok).toBe(
        true,
      );
    }
    const q = ctx.t2[0];
    expect((await placeInhouseBet(q.session, 20)).ok).toBe(true);

    await playAndRecord(ctx, { winner: 1 });

    // Long-side ratio 20/500 = 0.04 → 4 each, with no remainder to hand out.
    for (const p of ctx.t1) {
      expect((await betRow(ctx.lobbyId, p.user.id)).matched).toBe(4);
      expect(await balanceOf(p.user.id)).toBe(504); // 96 each comes home
    }
    expect(await balanceOf(q.user.id)).toBe(480);

    // The receipts show the split the design promises: the WHOLE stake comes
    // back as RETURN, and only the matched part moves as WIN/LOSS — which is
    // what makes the profit board net profit rather than turnover.
    const legs = await ledgerOf(ctx.t1[0].user.id);
    expect(
      legs.map((l) => [l.reason, l.delta]).filter(([r]) => r !== INHOUSE_CRED_REASON.GRANT),
    ).toEqual([
      [INHOUSE_CRED_REASON.STAKE, -100],
      [INHOUSE_CRED_REASON.RETURN, 100],
      [INHOUSE_CRED_REASON.WIN, 4],
    ]);

    await expectLedgerClosed();
    await expectZeroSum();
  });

  it("settles exactly once however many pollers arrive", async () => {
    const ctx = await readyLobby();
    await placeInhouseBet(ctx.t1[0].session, 50);
    await placeInhouseBet(ctx.t2[0].session, 50);
    await playAndRecord(ctx, { winner: 1 });

    const before = await balanceOf(ctx.t1[0].user.id);

    // RACED against `settleInhouseBets` DIRECTLY, not merely against the
    // sweeper — and the difference is the whole test. `resolveUnsettledBets`
    // probes for `betSettlement: PENDING`, so once a pot is paid it never
    // reaches the claim again: racing only the sweeper leaves the claim
    // completely unexercised, and passes just as happily with its PENDING
    // predicate deleted. Verified by deleting it. The three result paths
    // (button, pasted id, background scan) all call this function directly,
    // and under concurrent unauthenticated /api/sync pings they arrive together.
    const settled = await raceN(4, () => settleInhouseBets(ctx.lobbyId));
    expect(settled.filter((s) => s !== null)).toHaveLength(0);
    // …and the sweeper, which must find nothing left to do.
    const swept = await raceN(4, () => resolveUnsettledBets());
    expect(swept.every((s) => s === false)).toBe(true);

    expect(await balanceOf(ctx.t1[0].user.id)).toBe(before);
    expect(
      await prisma.inhouseCreditEntry.count({
        where: { reason: INHOUSE_CRED_REASON.WIN },
      }),
    ).toBe(1);
    await expectLedgerClosed();
    await expectZeroSum();
  });
});

// ---------------------------------------------------------------------------

describe("inhouse betting — voids", () => {
  it("VOID_LINEUP: a slot swap refunds the swapper and settles the rest from the RECOMPUTED pools", async () => {
    const ctx = await readyLobby();
    const swapper = ctx.t1[0]; // drafted team 1, will actually play Dire
    const decoy = ctx.t2[4]; // drafted team 2, plays Radiant — abstains
    const b = ctx.t1[1];
    const c = ctx.t2[0];

    await placeInhouseBet(swapper.session, 100);
    await placeInhouseBet(b.session, 40);
    await placeInhouseBet(c.session, 100);

    await playAndRecord(ctx, {
      winner: 1,
      swap: { fromT1: swapper, fromT2: decoy },
    });

    // The played game is the truth: teamFixes moved the swapper onto team 2, so
    // his frozen team-1 slip no longer matches the side he played.
    expect(
      (
        await prisma.inhouseLobbyPlayer.findFirstOrThrow({
          where: { lobbyId: ctx.lobbyId, userId: swapper.user.id },
        })
      ).team,
    ).toBe(2);
    expect(await betRow(ctx.lobbyId, swapper.user.id)).toMatchObject({
      outcome: INHOUSE_BET_OUTCOME.VOID_LINEUP,
      matched: 0,
      payout: 0,
    });
    expect(await balanceOf(swapper.user.id)).toBe(INHOUSE_BETS.START_BALANCE);

    // THE POINT OF THIS TEST: the survivors are matched against pools of 40 and
    // 100 (M = 40), not the 140-v-100 pools that included the voided stake. Had
    // the void been applied AFTER the pools were computed, B would be matched
    // for 29 and C for 100 — every individual rule still reading correctly.
    expect(await betRow(ctx.lobbyId, b.user.id)).toMatchObject({
      outcome: INHOUSE_BET_OUTCOME.WON,
      matched: 40,
      payout: 40,
    });
    expect(await betRow(ctx.lobbyId, c.user.id)).toMatchObject({
      outcome: INHOUSE_BET_OUTCOME.LOST,
      matched: 40,
      payout: -40,
    });
    expect(await balanceOf(b.user.id)).toBe(540);
    expect(await balanceOf(c.user.id)).toBe(460);

    // A refund reads as a REFUND leg, not a RETURN + WIN/LOSS pair.
    const legs = (await ledgerOf(swapper.user.id)).filter(
      (l) => l.reason !== INHOUSE_CRED_REASON.GRANT,
    );
    expect(legs.map((l) => [l.reason, l.delta])).toEqual([
      [INHOUSE_CRED_REASON.STAKE, -100],
      [INHOUSE_CRED_REASON.REFUND, 100],
    ]);
    await expectLedgerClosed();
    await expectZeroSum();
  });

  it("VOID_LATE: a bet placed after the played game's own start_time is refunded", async () => {
    const ctx = await readyLobby();
    const late = ctx.t1[0];
    const b = ctx.t1[1];
    const c = ctx.t2[0];

    await placeInhouseBet(late.session, 100);
    await placeInhouseBet(b.session, 50);
    await placeInhouseBet(c.session, 50);

    // Re-time the slips around a start_time we then hand OpenDota. Valve's
    // clock is the one timestamp ten interested parties can't forge, which is
    // why the void keys on it rather than on anything the site writes.
    const startSec = Math.floor(Date.now() / 1000);
    const startMs = startSec * 1000;
    await prisma.inhouseBet.updateMany({
      where: { lobbyId: ctx.lobbyId },
      data: { placedAt: new Date(startMs - 120_000) },
    });
    await prisma.inhouseBet.updateMany({
      where: { lobbyId: ctx.lobbyId, userId: late.user.id },
      data: { placedAt: new Date(startMs + 60_000) },
    });

    await playAndRecord(ctx, { winner: 1, startTimeSec: startSec });

    expect(
      (
        await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: ctx.lobbyId } })
      ).matchStartTime?.getTime(),
    ).toBe(startMs);
    expect(await betRow(ctx.lobbyId, late.user.id)).toMatchObject({
      outcome: INHOUSE_BET_OUTCOME.VOID_LATE,
      matched: 0,
      payout: 0,
    });
    expect(await balanceOf(late.user.id)).toBe(INHOUSE_BETS.START_BALANCE);

    // Recomputed pools again: 50 v 50, so B is matched for his whole 50 —
    // never the 17 the 150-v-50 pools would have left him.
    expect((await betRow(ctx.lobbyId, b.user.id)).matched).toBe(50);
    expect(await balanceOf(b.user.id)).toBe(550);
    expect(await balanceOf(c.user.id)).toBe(450);
    await expectLedgerClosed();
    await expectZeroSum();
  });
});

// ---------------------------------------------------------------------------
// applyResult's COMPLETED claim and its teamFixes loop are ONE transaction, and
// this is the section that says why in money terms.
//
// VOID_LINEUP reads `InhouseLobbyPlayer.team`, which the teamFixes loop is what
// writes. While those were two separate statements the claim committed on its
// own, so for the width of that gap the row read COMPLETED, with a PENDING pot,
// against the DRAFT roster — and `resolveUnsettledBets` runs on EVERY page view
// of the entire site via /api/sync. Anything landing in there settles the pot
// against the side each player was drafted onto rather than the side they
// PLAYED: the slot-swapper collects instead of being voided, the survivors are
// matched against a pool that included his stake, and it is PERMANENT, because
// settlement is single-winner and the real call a moment later finds nothing
// left to do.
//
// The seam is `inhouse.applyResult.beforeTeamFixes`. The first test fires it as
// a request DEATH, which needs no second connection and therefore runs on
// SQLite; the second runs the actual rival there and is Postgres-only.
// ---------------------------------------------------------------------------

describe("inhouse betting — the result claim and the played roster", () => {
  /** A lobby whose t1[0] physically played Dire, with three stakes on it. */
  async function withSwappedSlot() {
    const ctx = await readyLobby();
    const swapper = ctx.t1[0]; // drafted team 1, will actually play Dire
    const decoy = ctx.t2[4]; // drafted team 2, plays Radiant — abstains
    const b = ctx.t1[1];
    const c = ctx.t2[0];
    expect((await placeInhouseBet(swapper.session, 100)).ok).toBe(true);
    expect((await placeInhouseBet(b.session, 40)).ok).toBe(true);
    expect((await placeInhouseBet(c.session, 100)).ok).toBe(true);
    return { ctx, swapper, decoy, b, c };
  }

  it("a request dying between the claim and the roster leaves the sweeper nothing to mis-settle", async () => {
    const { ctx, swapper, decoy, b, c } = await withSwappedSlot();
    const matchId = await stageGame(ctx, {
      winner: 1,
      swap: { fromT1: swapper, fromT2: decoy },
    });

    // Serverless, a dropped connection, a deploy mid-write: the request that
    // won the claim is allowed to die before the loop under it lands. The
    // interesting question is what the NEXT reader finds.
    let fired = false;
    setRaceHook(
      onceAt("inhouse.applyResult.beforeTeamFixes", async () => {
        fired = true;
        throw new Error("the request died mid-claim");
      }),
    );
    await expect(recordMatch(ctx.admin, String(matchId))).rejects.toThrow(
      "the request died mid-claim",
    );
    expect(fired).toBe(true); // the seam was reached — not a vacuous pass
    setRaceHook(null);

    // THE ASSERTION, first because it is the one that costs money: the sweeper
    // that every page view runs finds NO work. With the claim on its own
    // statement it finds a COMPLETED lobby with a PENDING pot and pays it out
    // against the draft, crediting the swapper for a game he played on the
    // other side.
    expect(await resolveUnsettledBets()).toBe(false);

    // …because the claim rolled back with the loop. Nothing about this lobby
    // has moved: no result, no pot, and every player still on the side the
    // draft put them.
    const lobby = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: ctx.lobbyId },
    });
    expect(lobby.status).toBe(INHOUSE_STATUS.IN_PROGRESS);
    expect(lobby.winnerTeam).toBeNull();
    expect(lobby.betSettlement).toBe(INHOUSE_BET_STATUS.PENDING);
    expect(
      (
        await prisma.inhouseLobbyPlayer.findFirstOrThrow({
          where: { lobbyId: ctx.lobbyId, userId: swapper.user.id },
        })
      ).team,
    ).toBe(1);
    expect(await balanceOf(swapper.user.id)).toBe(400); // staked, not settled

    // And the retry is byte-identical to the happy path — the whole point of
    // rolling back rather than half-committing. Same match id, same button.
    expect((await recordMatch(ctx.admin, String(matchId))).ok).toBe(true);
    expect(await betRow(ctx.lobbyId, swapper.user.id)).toMatchObject({
      outcome: INHOUSE_BET_OUTCOME.VOID_LINEUP,
      matched: 0,
      payout: 0,
    });
    expect(await balanceOf(swapper.user.id)).toBe(INHOUSE_BETS.START_BALANCE);
    // Survivors matched against the RECOMPUTED 40-v-100 pools, not the 140.
    expect(await betRow(ctx.lobbyId, b.user.id)).toMatchObject({
      outcome: INHOUSE_BET_OUTCOME.WON,
      matched: 40,
    });
    expect(await balanceOf(b.user.id)).toBe(540);
    expect(await balanceOf(c.user.id)).toBe(460);
    await expectLedgerClosed();
    await expectZeroSum();
  });

  // The rival for real, on a second connection. It is the production
  // interleaving rather than a stand-in for it: /api/sync answers an
  // unauthenticated page view from anywhere while this transaction is open.
  //
  // It does NOT deadlock, and the reason is the same fact the fix rests on —
  // `resolveUnsettledBets` opens with a plain SELECT, which under READ
  // COMMITTED reads the last COMMITTED version of the lobby row rather than
  // blocking on the write lock this transaction holds. It therefore sees an
  // IN_PROGRESS lobby, finds no work, and returns. SQLite pins one connection,
  // so there it would hang instead: skipped, per the race-hook contract.
  describe.skipIf(!ON_POSTGRES)("under a real rival", () => {
    it("a sweeper polling mid-claim cannot see the draft roster", async () => {
      const { ctx, swapper, decoy } = await withSwappedSlot();

      let swept: boolean | null = null;
      setRaceHook(
        onceAt("inhouse.applyResult.beforeTeamFixes", async () => {
          swept = await resolveUnsettledBets();
        }),
      );
      await playAndRecord(ctx, {
        winner: 1,
        swap: { fromT1: swapper, fromT2: decoy },
      });

      // false = it never saw the half-written state. Not null, which would
      // mean the seam never fired and this test measured nothing.
      expect(swept).toBe(false);
      expect(await betRow(ctx.lobbyId, swapper.user.id)).toMatchObject({
        outcome: INHOUSE_BET_OUTCOME.VOID_LINEUP,
        payout: 0,
      });
      await expectLedgerClosed();
      await expectZeroSum();
    });
  });
});

// ---------------------------------------------------------------------------
// The ONE refund rule. Not one of the four paths below has a line of betting
// code in it — each flips the lobby into a state the sweeper recognises. These
// tests exist to prove that claim, since "no edits were needed" is exactly what
// an untested gap looks like from here.
// ---------------------------------------------------------------------------

describe("inhouse betting — refunds ride the sweeper", () => {
  it("cancelLobby: the pot comes back in full on the next poll", async () => {
    const ctx = await readyLobby();
    await placeInhouseBet(ctx.t1[0].session, 100);
    await placeInhouseBet(ctx.t2[0].session, 30);

    expect((await cancelLobby(ctx.admin)).ok).toBe(true);
    // The cancel itself writes no money — the lobby is merely CANCELLED with a
    // pot still marked PENDING.
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: ctx.lobbyId } }))
        .betSettlement,
    ).toBe(INHOUSE_BET_STATUS.PENDING);
    expect(await balanceOf(ctx.t1[0].user.id)).toBe(400);

    // RACED: four pollers reach the refund together and only one may hand the
    // money back. On SQLite `raceN` runs them in sequence (one connection, so
    // real contention is impossible and staging it would prove nothing); under
    // `npm run test:pg` this is the claim actually under fire.
    const swept = await raceN(4, () => resolveUnsettledBets());
    expect(swept.filter(Boolean)).toHaveLength(1);
    expect(await balanceOf(ctx.t1[0].user.id)).toBe(INHOUSE_BETS.START_BALANCE);
    expect(await balanceOf(ctx.t2[0].user.id)).toBe(INHOUSE_BETS.START_BALANCE);
    expect(await betRow(ctx.lobbyId, ctx.t1[0].user.id)).toMatchObject({
      outcome: INHOUSE_BET_OUTCOME.REFUNDED,
      matched: 0,
      payout: 0,
    });
    const lobby = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: ctx.lobbyId },
    });
    expect(lobby.betSettlement).toBe(INHOUSE_BET_STATUS.REFUNDED);
    expect(lobby.betDeltas).toBe("{}");
    // Idempotent: a second sweeper finds nothing left to do.
    expect(await resolveUnsettledBets()).toBe(false);
    await expectLedgerClosed();
    await expectZeroSum();
  });

  it("resolveAbandonedLobby: a stake locked on a game nobody ever hosted comes back", async () => {
    const ctx = await readyLobby();
    await placeInhouseBet(ctx.t1[0].session, 60);
    await placeInhouseBet(ctx.t2[0].session, 20);
    expect((await startGame(ctx.t1[0].session)).ok).toBe(true);

    // Nobody can compel a Dota game. Six hours later the abandon sweep gives up.
    await prisma.inhouseLobby.update({
      where: { id: ctx.lobbyId },
      data: {
        startedAt: new Date(
          Date.now() - (INHOUSE.ABANDON_IN_PROGRESS_HOURS + 1) * 3_600_000,
        ),
      },
    });
    expect(await resolveAbandonedLobby()).toBe(true);
    expect(await resolveUnsettledBets()).toBe(true);

    expect(await balanceOf(ctx.t1[0].user.id)).toBe(INHOUSE_BETS.START_BALANCE);
    expect(await balanceOf(ctx.t2[0].user.id)).toBe(INHOUSE_BETS.START_BALANCE);
    await expectLedgerClosed();
    await expectZeroSum();
  });

  it("failReadyCheck can never have a pot to refund — the window opens four phases later", async () => {
    // Asserted, not assumed. "That path needs no handling" is the sentence this
    // repo has been wrong about before, so the claim is pinned from both ends:
    // the window is provably unopened during the ready check, and the sweeper
    // provably finds no work after the check fails.
    const players = await enqueue(() => 3000);
    const lobby = await prisma.inhouseLobby.findFirstOrThrow({});
    expect(lobby.status).toBe(INHOUSE_STATUS.READY_CHECK);
    expect(lobby.betsCloseAt).toBeNull();
    expect(lobby.betSettlement).toBeNull();
    expect((await placeInhouseBet(players[0].session, 50)).ok).toBe(false);

    expect((await declineMatch(players[3].session)).ok).toBe(true);
    const dead = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(dead.status).toBe(INHOUSE_STATUS.CANCELLED);
    // betSettlement is null, so the sweeper's indexed probe never sees it —
    // which is why a league that never bets pays one index read per resolver.
    expect(dead.betSettlement).toBeNull();
    expect(await prisma.inhouseBet.count()).toBe(0);
    expect(await resolveUnsettledBets()).toBe(false);
  });

  it("voidLastResult: a paid-out pot is reversed to exactly its pre-game value", async () => {
    const ctx = await readyLobby();
    const bettors = [ctx.t1[0], ctx.t1[1], ctx.t2[0], ctx.t2[1]];
    for (const [p, s] of [
      [ctx.t1[0], 100],
      [ctx.t1[1], 20],
      [ctx.t2[0], 60],
      [ctx.t2[1], 30],
    ] as const) {
      await placeInhouseBet(p.session, s);
    }
    const pre = new Map<string, number>();
    for (const p of bettors) pre.set(p.user.id, INHOUSE_BETS.START_BALANCE);

    await playAndRecord(ctx, { winner: 1 });
    // The pot really did pay before it was unwound — otherwise this test would
    // pass just as happily against a reversal that reverses nothing.
    expect(await balanceOf(ctx.t1[0].user.id)).not.toBe(
      INHOUSE_BETS.START_BALANCE,
    );

    expect((await voidLastResult(ctx.admin)).ok).toBe(true);
    // Raced for the same reason the refund is: the reversal claim elects one
    // winner, and a second one would claw the payout back twice.
    const swept = await raceN(4, () => resolveUnsettledBets());
    expect(swept.filter(Boolean)).toHaveLength(1);

    for (const p of bettors) {
      expect({ id: p.user.id, bal: await balanceOf(p.user.id) }).toEqual({
        id: p.user.id,
        bal: pre.get(p.user.id),
      });
      expect(await betRow(ctx.lobbyId, p.user.id)).toMatchObject({
        outcome: INHOUSE_BET_OUTCOME.REFUNDED,
        matched: 0,
        payout: 0,
      });
    }
    const lobby = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: ctx.lobbyId },
    });
    expect(lobby.betSettlement).toBe(INHOUSE_BET_STATUS.REVERSED);
    // The ORIGINAL payout survives in the ledger (WIN then REVERSAL) — the
    // record of what happened has to outlive the undo.
    const legs = (await ledgerOf(ctx.t1[0].user.id)).map((l) => l.reason);
    expect(legs).toContain(INHOUSE_CRED_REASON.WIN);
    expect(legs).toContain(INHOUSE_CRED_REASON.REVERSAL);
    expect(await resolveUnsettledBets()).toBe(false);
    await expectLedgerClosed();
    await expectZeroSum();
  });

  it("voidLastResult: leaves a record and corrects the channel it lied to", async () => {
    // The void used to be MONEY-SILENT. It erases a result and every payout
    // that came off it, yet the lobby just reads CANCELLED like any abandoned
    // game, the Elo swing recomputes away, and the match id that would say
    // WHICH game is nulled by the claim — so there was no trace anywhere. And
    // the result post is still sitting in Discord naming each player's payout,
    // which nobody edits and nobody notifies.
    const ctx = await readyLobby();
    await placeInhouseBet(ctx.t1[0].session, 100);
    await placeInhouseBet(ctx.t2[0].session, 60);
    const matchId = await playAndRecord(ctx, { winner: 1 });

    const sent = vi.mocked(sendInhouseDiscordMessage);
    sent.mockClear();
    expect((await voidLastResult(ctx.admin)).ok).toBe(true);

    const log = await prisma.adminAction.findMany({
      where: { action: "voidLastResult" },
    });
    expect(log).toHaveLength(1);
    // The match id in particular: the claim has already nulled it on the lobby,
    // so this row is the only place left that names the game.
    expect(log[0].summary).toContain(String(matchId));
    expect(log[0].summary).toContain("2 confirmed bet(s)");
    expect(log[0].summary).toContain("160 Cred staked");

    expect(sent).toHaveBeenCalledTimes(1);
    const msg = sent.mock.calls[0][0];
    expect(msg).toContain("voided");
    expect(msg).toContain("2 slips");
    expect(msg).toContain("160 Cred");
    // The anchor back to the post it corrects.
    expect(msg).toContain(`opendota.com/matches/${matchId}`);
    // Nobody is being asked to do anything, so nothing may ring a phone.
    expect(sent.mock.calls[0][1]).toBeUndefined();
  });

  it("voidLastResult: a betless void is logged but says nothing in Discord", async () => {
    // The correction exists to amend published payout figures. With no pot
    // there are none, and a channel gets muted by notifications nobody can act
    // on — but the destructive act is still worth an audit row.
    const ctx = await readyLobby();
    await playAndRecord(ctx, { winner: 1 });

    const sent = vi.mocked(sendInhouseDiscordMessage);
    sent.mockClear();
    expect((await voidLastResult(ctx.admin)).ok).toBe(true);

    expect(sent).not.toHaveBeenCalled();
    const log = await prisma.adminAction.findMany({
      where: { action: "voidLastResult" },
    });
    expect(log).toHaveLength(1);
    expect(log[0].summary).toContain("no Cred was staked");
  });

  it("voidLastResult: a losing claim writes no record and sends nothing", async () => {
    // Post-claim ordering, the cancelLobby rule: two admins pressing Void must
    // not produce two audit rows and two corrections for one voided game.
    const ctx = await readyLobby();
    await placeInhouseBet(ctx.t1[0].session, 40);
    await placeInhouseBet(ctx.t2[0].session, 40);
    await playAndRecord(ctx, { winner: 1 });

    const sent = vi.mocked(sendInhouseDiscordMessage);
    sent.mockClear();
    const results = await raceN(3, () => voidLastResult(ctx.admin));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.adminAction.count()).toBe(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The void and the claw-back it queues.
//
// `reverseLobbyBets` unwinds a payout with an UNFLOORED `{ increment: -payout }`
// — deliberately, because it is undoing a specific movement rather than
// enforcing a balance. That is only safe while the money it is taking back is
// still there, and a winner who has re-staked their winnings on the game
// running right now has spent it. So the void refuses while a live lobby holds
// confirmed stakes, and `adjustCred` — the one repair for the residual case the
// refusal cannot cover — must be able to CREDIT an account that is already
// below zero. The two fixes are one story and are tested as one.
// ---------------------------------------------------------------------------

describe("inhouse betting — voiding against live money", () => {
  it("refuses to void while a live game is holding stakes, then lets it through", async () => {
    const first = await readyLobby();
    const winner = first.t1[0];
    await placeInhouseBet(winner.session, 100);
    await placeInhouseBet(first.t2[0].session, 100);
    await playAndRecord(first, { winner: 1 });
    expect(await balanceOf(winner.user.id)).toBe(600);

    // The next game forms and someone stakes on it. That stake is what makes
    // the claw-back queued behind a void unsafe. Deliberately somebody who was
    // not in the first pot: the guard is about ANY live stake, not about the
    // people this void would touch — and the same ten play both games, so
    // picking `second.t1[0]` would have staked the winner's own winnings and
    // measured the wrong thing.
    const second = await nextLobby(first);
    const staker = second.players.find(
      (pl) =>
        pl.user.id !== winner.user.id && pl.user.id !== first.t2[0].user.id,
    )!;
    expect((await placeInhouseBet(staker.session, 100)).ok).toBe(true);

    const refused = await voidLastResult(first.admin);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    // "Nothing happened" is the one answer an admin can't act on: the message
    // has to say a live pot is why, and that waiting is the fix.
    expect(refused.error).toContain("Cred staked");
    expect(refused.error).toContain("finished");

    // Nothing moved — the previous result stands and its pot stays settled.
    const lobby1 = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: first.lobbyId },
    });
    expect(lobby1.status).toBe(INHOUSE_STATUS.COMPLETED);
    expect(lobby1.betSettlement).toBe(INHOUSE_BET_STATUS.SETTLED);
    expect(await resolveUnsettledBets()).toBe(false);
    expect(await balanceOf(winner.user.id)).toBe(600);

    // A WAIT, not a lockout: once the live game is out of the way the same
    // press goes through. The admin loses one game, not the ability to void.
    expect((await cancelLobby(second.admin)).ok).toBe(true);
    for (let n = 0; n < 4 && (await resolveUnsettledBets()); n++);
    // cancelLobby re-queues its ten with a backdated heartbeat; left there
    // they would form a lobby around the void this test is about to press.
    await prisma.inhouseQueueEntry.deleteMany();

    expect((await voidLastResult(first.admin)).ok).toBe(true);
    expect(await resolveUnsettledBets()).toBe(true);
    expect(await balanceOf(winner.user.id)).toBe(INHOUSE_BETS.START_BALANCE);
    await expectLedgerClosed();
    await expectZeroSum();
  });

  it("adjustCred can credit an account the claw-back drove below zero", async () => {
    // THE RESIDUAL CASE the refusal above deliberately leaves open, built
    // through the reversal path rather than by writing a negative number into
    // the column: `voidLastResult` checks for live stakes at READ time only
    // (re-asserting it at the write would put the hot betting path on
    // Serializable to close a gap of milliseconds), and the reversal it queues
    // does not run until the next sweep. A stake placed in between lands on
    // exactly the money that is about to be taken back.
    const first = await readyLobby();
    const p = first.t1[0];
    const q = first.t2[0];
    // Small, so the winnings are ALL of this player's balance. A player at 500
    // can absorb a claw-back; the one this is about could not.
    await drainTo(first.admin, p.user.id, 20);
    expect((await placeInhouseBet(p.session, 20)).ok).toBe(true);
    expect((await placeInhouseBet(q.session, 20)).ok).toBe(true);
    // Short of REAL_GAME_SECONDS on purpose: the bankruptcy floor would
    // otherwise top this player up and paper over the negative balance.
    await playAndRecord(first, {
      winner: 1,
      durationSecs: INHOUSE_BETS.REAL_GAME_SECONDS - 1,
    });
    expect(await balanceOf(p.user.id)).toBe(40);

    // Legal: no lobby is live yet, so the refusal above has nothing to refuse.
    expect((await voidLastResult(first.admin)).ok).toBe(true);

    const second = await nextLobby(first);
    expect((await placeInhouseBet(p.session, 40)).ok).toBe(true);
    expect(await balanceOf(p.user.id)).toBe(0);

    expect(await resolveUnsettledBets()).toBe(true);
    // Below zero, exactly as the unfloored decrement promises. Pinned rather
    // than fixed: a floored claw-back would leave the books open (money the
    // ledger says was taken back and the column says wasn't).
    expect(await balanceOf(p.user.id)).toBe(-20);

    // …and this is the whole point. The one operation that repairs a negative
    // balance must not itself be refused for being applied to one. The old
    // predicate was `gte: Math.max(0, -delta)`, which on a CREDIT reads
    // `gte: 0` — so the admin found the fix locked behind the bug.
    expect(await adjustCred(first.admin, p.user.id, 20, "repair after a void")).toEqual(
      { ok: true },
    );
    expect(await balanceOf(p.user.id)).toBe(0);

    // The asymmetry is the fix, not a blanket removal: a DEBIT still
    // re-asserts affordability in its own WHERE.
    const debit = await adjustCred(first.admin, p.user.id, -10, "not this one");
    expect(debit.ok).toBe(false);
    expect(await balanceOf(p.user.id)).toBe(0);

    // Close the books: the live stake comes home and the league nets to zero.
    expect((await cancelLobby(second.admin)).ok).toBe(true);
    for (let n = 0; n < 4 && (await resolveUnsettledBets()); n++);
    expect(await balanceOf(p.user.id)).toBe(40);
    await expectLedgerClosed();
    await expectZeroSum();
  });
});

// ---------------------------------------------------------------------------

describe("inhouse betting — the forced cancel", () => {
  it("refuses to cancel a LIVE game with confirmed bets, and names the override", async () => {
    const ctx = await readyLobby();
    await placeInhouseBet(ctx.t1[0].session, 100);
    await placeInhouseBet(ctx.t2[0].session, 50);
    expect((await startGame(ctx.t1[0].session)).ok).toBe(true);

    const res = await cancelLobby(ctx.admin);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // "Nothing happened" is the one answer an admin can't act on: the message
    // has to say a live pot is why and how to override it.
    expect(res.error).toContain("Cred staked");
    expect(res.error).toContain("forced cancel");
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: ctx.lobbyId } }))
        .status,
    ).toBe(INHOUSE_STATUS.IN_PROGRESS);
  });

  it("lets an admin force it through, and writes the pot into the AdminAction", async () => {
    // Admins are deliberately NOT locked out: an unkillable lobby holds the
    // single active slot for six hours, which is strictly worse.
    const ctx = await readyLobby();
    await placeInhouseBet(ctx.t1[0].session, 100);
    await placeInhouseBet(ctx.t2[0].session, 50);
    expect((await startGame(ctx.t1[0].session)).ok).toBe(true);

    expect((await cancelLobby(ctx.admin, { force: true })).ok).toBe(true);
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: ctx.lobbyId } }))
        .status,
    ).toBe(INHOUSE_STATUS.CANCELLED);

    const log = await prisma.adminAction.findMany({
      where: { action: "cancelLobby" },
    });
    expect(log).toHaveLength(1);
    // The numbers that made it destructive live IN the summary — the row is the
    // whole record, and after the sweeper refunds there is nothing left to join.
    expect(log[0].summary).toContain("2 confirmed bet(s)");
    expect(log[0].summary).toContain("150 Cred staked");

    expect(await resolveUnsettledBets()).toBe(true);
    expect(await balanceOf(ctx.t1[0].user.id)).toBe(INHOUSE_BETS.START_BALANCE);
    await expectLedgerClosed();
  });

  it("a cancel with no confirmed bets needs no override at all", async () => {
    const ctx = await readyLobby();
    expect((await startGame(ctx.t1[0].session)).ok).toBe(true);
    expect((await cancelLobby(ctx.admin)).ok).toBe(true);
    expect(await prisma.adminAction.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("inhouse betting — the bankruptcy floor", () => {
  /** A pot exists (settlement is what runs the floor) and `broke` is at zero. */
  async function withBrokeParticipant(ctx: ReadyLobby, broke: Player) {
    await placeInhouseBet(ctx.t1[0].session, 10);
    await placeInhouseBet(ctx.t2[0].session, 10);
    await drainTo(ctx.admin, broke.user.id, 0);
  }

  const today = () => new Date().toISOString().slice(0, 10);

  it("tops a broke participant up to the floor after a real game", async () => {
    const ctx = await readyLobby();
    // Deliberately someone who never bet: the floor is a PARTICIPATION net, and
    // a player who sat the pot out is no less broke for it.
    const broke = ctx.t1[3];
    await withBrokeParticipant(ctx, broke);

    await playAndRecord(ctx, { winner: 1, durationSecs: 2400 });

    expect(await balanceOf(broke.user.id)).toBe(INHOUSE_BETS.FLOOR);
    const floors = await prisma.inhouseCreditEntry.findMany({
      where: { reason: INHOUSE_CRED_REASON.FLOOR },
    });
    expect(floors).toHaveLength(1);
    expect(floors[0]).toMatchObject({
      userId: broke.user.id,
      delta: INHOUSE_BETS.FLOOR,
      refId: `${broke.user.id}:${today()}`,
    });
    await expectLedgerClosed();
  });

  it("refuses a second top-up the same UTC day", async () => {
    // The designated-donor mint: park at the floor, max-bet, lose, get restored,
    // repeat. The @@unique([reason, refId]) on "<userId>:<yyyy-mm-dd>" is the
    // guard; this is the test that it is actually load-bearing.
    const first = await readyLobby();
    const broke = first.t1[3];
    await withBrokeParticipant(first, broke);
    await playAndRecord(first, { winner: 1, durationSecs: 2400 });
    expect(await balanceOf(broke.user.id)).toBe(INHOUSE_BETS.FLOOR);

    const second = await nextLobby(first);
    const brokeAgain = second.players.find((p) => p.user.id === broke.user.id)!;
    await withBrokeParticipant(second, brokeAgain);
    await playAndRecord(second, { winner: 1, durationSecs: 2400 });

    expect(await balanceOf(broke.user.id)).toBe(0);
    expect(
      await prisma.inhouseCreditEntry.count({
        where: { reason: INHOUSE_CRED_REASON.FLOOR },
      }),
    ).toBe(1);

    // And the SECOND game still paid out normally. This is the assertion that
    // makes the test worth having: the guard is a read-then-skip, not a caught
    // P2002 — a duplicate create inside an open interactive transaction poisons
    // it on Postgres and rolls back the whole settlement here, so dropping the
    // check doesn't merely double-pay the floor, it strands the entire second
    // pot as PENDING with every stake debited and no outcome. Nothing in the
    // floor's own numbers above can see that.
    const lobby2 = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: second.lobbyId },
    });
    expect(lobby2.betSettlement).toBe(INHOUSE_BET_STATUS.SETTLED);
    expect(await betRow(second.lobbyId, second.t1[0].user.id)).toMatchObject({
      outcome: INHOUSE_BET_OUTCOME.WON,
      matched: 10,
      payout: 10,
    });
    await expectLedgerClosed();
    await expectZeroSum();
  });

  it("refuses on a game too short to be a game", async () => {
    // Without this the floor pays out on 4-minute feed-fests, which is a faucet
    // with a crank on it.
    const ctx = await readyLobby();
    const broke = ctx.t1[3];
    await withBrokeParticipant(ctx, broke);

    await playAndRecord(ctx, {
      winner: 1,
      durationSecs: INHOUSE_BETS.REAL_GAME_SECONDS - 1,
    });

    expect(await balanceOf(broke.user.id)).toBe(0);
    expect(
      await prisma.inhouseCreditEntry.count({
        where: { reason: INHOUSE_CRED_REASON.FLOOR },
      }),
    ).toBe(0);
    await expectLedgerClosed();
  });

  it("tops up by exactly the gap — the receipt IS the movement", async () => {
    // The other floor tests all start their broke player at 0, where a top-up
    // of the whole FLOOR and a top-up of the GAP are the same number — so a
    // hard-coded `delta: FLOOR` would read correct in every one of them while
    // the ledger silently drifted from the column for every partial top-up.
    const ctx = await readyLobby();
    const broke = ctx.t1[3];
    await placeInhouseBet(ctx.t1[0].session, 10);
    await placeInhouseBet(ctx.t2[0].session, 10);
    await drainTo(ctx.admin, broke.user.id, 40);

    await playAndRecord(ctx, { winner: 1, durationSecs: 2400 });

    expect(await balanceOf(broke.user.id)).toBe(INHOUSE_BETS.FLOOR);
    const floors = await prisma.inhouseCreditEntry.findMany({
      where: { reason: INHOUSE_CRED_REASON.FLOOR },
    });
    expect(floors).toHaveLength(1);
    expect(floors[0].delta).toBe(INHOUSE_BETS.FLOOR - 40);
    await expectLedgerClosed();
  });

  it("[source] the top-up is a compare-and-swap, and the receipt follows it", async () => {
    // A SOURCE GUARD, and the reason is worth stating rather than hiding: the
    // branch this protects — the CAS finding the balance moved and skipping —
    // is not reachable from a test in this file. The rival has to commit
    // between applyFloor's `findMany` and its write, both of which are inside
    // settlement's transaction, and there is no seam in there to steer it
    // with. Every no-rival run produces byte-identical output from the fixed
    // code and from the absolute `balance: FLOOR` write it replaced, so a
    // behavioural test of it would be vacuous — which is exactly what an
    // untested gap looks like from here, hence this.
    //
    // What it protects: `balance: FLOOR` is the ONE absolute assignment in the
    // whole money layer, on a row this transaction has NOT written, read
    // without a lock. Under Postgres READ COMMITTED an admin `adjustCred`
    // landing in that window is silently overwritten — a lost update, after
    // which the receipt says one thing and the column another and
    // `expectLedgerClosed` stops holding for that account forever.
    const body = floorSource();
    // (1) a conditional write, re-asserting the exact balance it read…
    const move = body.indexOf("inhouseCredit.updateMany(");
    expect(move).toBeGreaterThan(-1);
    expect(body.slice(move)).toMatch(/balance: acct\.balance/);
    // (2) …that SKIPS when it loses, rather than retrying or throwing (the
    // floor is a safety net, and the settlement around it is already correct).
    expect(body).toMatch(/moved\.count === 0\)\s*continue/);
    // (3) and the receipt is written AFTER the movement. Written first it
    // records a top-up the CAS then declines to make.
    const receipt = body.indexOf("inhouseCreditEntry.create(");
    expect(receipt).toBeGreaterThan(move);
  });

  it("a void takes the floor back with the payout, and releases the day key", async () => {
    // Reversing only the wager legs MINTS Cred. A player whose loss dropped
    // them under the floor is topped back up to it; hand their stake back and
    // leave the top-up in place and they end a game that officially never
    // happened strictly better off than before it — up to a free 100.
    const first = await readyLobby();
    const loser = first.t2[0];
    const winner = first.t1[0];
    await drainTo(first.admin, loser.user.id, 30);
    expect((await placeInhouseBet(winner.session, 30)).ok).toBe(true);
    expect((await placeInhouseBet(loser.session, 30)).ok).toBe(true);

    await playAndRecord(first, { winner: 1, durationSecs: 2400 });
    // Staked out, lost it, and caught by the net.
    expect(await balanceOf(loser.user.id)).toBe(INHOUSE_BETS.FLOOR);
    expect(await balanceOf(winner.user.id)).toBe(530);
    expect(
      await prisma.inhouseCreditEntry.count({
        where: { reason: INHOUSE_CRED_REASON.FLOOR },
      }),
    ).toBe(1);

    expect((await voidLastResult(first.admin)).ok).toBe(true);
    expect(await resolveUnsettledBets()).toBe(true);

    // EXACTLY pre-game, which is what this function's own docstring promises:
    // 30, not the 130 that reversing the wager legs alone leaves behind.
    expect(await balanceOf(loser.user.id)).toBe(30);
    expect(await balanceOf(winner.user.id)).toBe(INHOUSE_BETS.START_BALANCE);
    // DELETED, not offset with a compensating row: `refId` is
    // "<userId>:<utc-day>" and the @@unique([reason, refId]) IS the once-a-day
    // rule, so an offsetting entry leaves the day key burned and the player
    // punished — un-floorable tonight — for an admin's void.
    expect(
      await prisma.inhouseCreditEntry.count({
        where: { reason: INHOUSE_CRED_REASON.FLOOR },
      }),
    ).toBe(0);
    await expectLedgerClosed();

    // The proof that the key is genuinely released, and the assertion the
    // "deleted vs offset" choice exists for: the same player, the same UTC
    // day, floored again by the next game.
    const second = await nextLobby(first);
    // One stake is all a pot needs — settlement (and therefore the floor) runs
    // off `betSettlement: PENDING`, not off the pool being matched. Anyone but
    // the broke player: the point is that the FLOOR reaches a player who sat
    // this one out, and staking would move his balance.
    const punter = second.players.find((pl) => pl.user.id !== loser.user.id)!;
    expect((await placeInhouseBet(punter.session, 10)).ok).toBe(true);
    await playAndRecord(second, { winner: 1, durationSecs: 2400 });

    expect(await balanceOf(loser.user.id)).toBe(INHOUSE_BETS.FLOOR);
    const floors = await prisma.inhouseCreditEntry.findMany({
      where: { reason: INHOUSE_CRED_REASON.FLOOR },
    });
    expect(floors).toHaveLength(1);
    expect(floors[0]).toMatchObject({
      userId: loser.user.id,
      refId: `${loser.user.id}:${today()}`,
    });
    await expectLedgerClosed();
  });
});

// ---------------------------------------------------------------------------

describe("inhouse betting — the stranded pot", () => {
  it("runResultSync settles it on the `no lobby, empty queue` early return", async () => {
    const ctx = await readyLobby();
    await placeInhouseBet(ctx.t1[0].session, 100);
    await placeInhouseBet(ctx.t2[0].session, 100);
    expect((await startGame(ctx.t1[0].session)).ok).toBe(true);

    // STAGED, and staged on purpose: this is not a race but a CRASH. The
    // request that won applyResult's COMPLETED claim is allowed to die before
    // the payout — serverless, a dropped connection, a deploy mid-settlement —
    // and every result path requires IN_PROGRESS, so nothing re-triggers it.
    // These are exactly the columns that claim writes.
    await prisma.inhouseLobby.update({
      where: { id: ctx.lobbyId },
      data: {
        status: INHOUSE_STATUS.COMPLETED,
        winnerTeam: 1,
        radiantTeam: 1,
        durationSecs: 2400,
        matchStartTime: new Date(startTimeAfterNow() * 1000),
      },
    });

    // The branch predicate, read from the DB: no active lobby and an empty
    // queue. The ten who played have closed their tabs, and the room has nobody
    // polling it — so `syncInhouse`'s early return is the only path that runs.
    expect(
      await prisma.inhouseLobby.count({
        where: { status: { in: [...INHOUSE_ACTIVE_STATUSES] } },
      }),
    ).toBe(0);
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);

    const out = await runResultSync();
    // The early-return shape. Below it the chain would have to find something
    // active to report, and there is nothing.
    expect(out.inhouse).toBe(false);
    expect(out.watch).toBe(false);

    expect(await balanceOf(ctx.t1[0].user.id)).toBe(600);
    expect(await balanceOf(ctx.t2[0].user.id)).toBe(400);
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: ctx.lobbyId } }))
        .betSettlement,
    ).toBe(INHOUSE_BET_STATUS.SETTLED);
    await expectLedgerClosed();
    await expectZeroSum();
  });
});

// ---------------------------------------------------------------------------

describe("inhouse betting — the profit board and the admin escape hatch", () => {
  it("ranks net profit, never balance: faucets and corrections are excluded", async () => {
    const ctx = await readyLobby();
    const winner = ctx.t1[0];
    const loser = ctx.t2[0];
    await placeInhouseBet(winner.session, 100);
    await placeInhouseBet(loser.session, 100);
    await playAndRecord(ctx, { winner: 1 });

    // An admin hands someone 250 Cred; a broke player is caught by the floor.
    expect((await adjustCred(ctx.admin, ctx.t1[1].user.id, 250, "goodwill")).ok).toBe(
      true,
    );

    const board = await credProfitBoard();
    expect(board.get(winner.user.id)).toBe(100);
    expect(board.get(loser.user.id)).toBe(-100);
    // The GRANT (500) and the ADJUST (250) are liquidity, never score — which
    // is what keeps the board centred on zero and makes attendance unrankable.
    expect(board.get(ctx.t1[1].user.id) ?? 0).toBe(0);
    await expectZeroSum();
  });

  it("adjustCred is admin-only, logged, and can't take an account below zero", async () => {
    const ctx = await readyLobby();
    const target = ctx.t1[0];

    expect(await adjustCred(target.session, target.user.id, 50, "self-serve")).toEqual(
      { ok: false, error: "Admins only" },
    );
    expect(
      (await adjustCred(ctx.admin, target.user.id, -600, "clawback")).ok,
    ).toBe(false);
    expect(await balanceOf(target.user.id)).toBe(INHOUSE_BETS.START_BALANCE);

    expect((await adjustCred(ctx.admin, target.user.id, -100, "clawback")).ok).toBe(
      true,
    );
    expect(await balanceOf(target.user.id)).toBe(400);
    const log = await prisma.adminAction.findMany({
      where: { action: "adjustCred" },
    });
    expect(log).toHaveLength(1);
    expect(log[0].summary).toContain("clawback");
    await expectLedgerClosed();
  });
});

// ---------------------------------------------------------------------------

describe("inhouse betting — the account and its opening receipt", () => {
  it("never leaves a funded account without its GRANT", async () => {
    // `InhouseCredit.balance` opens at START_BALANCE by COLUMN DEFAULT, so the
    // account row is funded the instant it is created and the GRANT row is
    // only its receipt. Two statements, and the identity every money test in
    // this file leans on — `balance === Σ ledger deltas` — depends on both
    // landing. The fast `if (existing) return` at the top means there is no
    // second attempt: a half-written pair is permanent, silent, and wrong for
    // that user forever.
    //
    // A pre-existing GRANT row is the deterministic way to make the SECOND
    // write of the pair fail (`@@unique([reason, refId])`, refId = userId). It
    // stands in for the process death the fix is about; the question either
    // way is what the database is left holding.
    const orphan = await makeUser("Orphan");
    await prisma.inhouseCreditEntry.create({
      data: {
        userId: orphan.id,
        // NOT START_BALANCE, on purpose. A receipt of 500 would make a funded
        // account look correctly opened and the identity assertion below would
        // wave the broken state through — which is precisely the failure mode
        // this whole file exists to catch.
        delta: 0,
        reason: INHOUSE_CRED_REASON.GRANT,
        refId: orphan.id,
      },
    });

    // The documented fallback: the caller is told START_BALANCE because the
    // creation race's winner would normally have written it. Harmless — no
    // account row means `placeInhouseBet`'s debit matches nothing and refuses.
    await expect(ensureCredAccount(orphan.id)).resolves.toBe(
      INHOUSE_BETS.START_BALANCE,
    );
    // THE ASSERTION: the account rolled back with its receipt. Written as two
    // statements the row survives, funded with 500, against a ledger summing
    // to 0 — money from nowhere, with nothing anywhere to notice.
    expect(
      await prisma.inhouseCredit.count({ where: { userId: orphan.id } }),
    ).toBe(0);
    await expectLedgerClosed();
  });

  it("opens exactly one account under concurrent first calls", async () => {
    // The catch branch's re-read, which exists because two tabs opening
    // /inhouse in the same instant both reach the create. Sequential on SQLite
    // (`raceAll`), genuinely concurrent under `npm run test:pg`.
    const fresh = await makeUser("FirstLook");
    const balances = await raceN(3, () => ensureCredAccount(fresh.id));
    expect(balances).toEqual([
      INHOUSE_BETS.START_BALANCE,
      INHOUSE_BETS.START_BALANCE,
      INHOUSE_BETS.START_BALANCE,
    ]);
    expect(
      await prisma.inhouseCredit.count({ where: { userId: fresh.id } }),
    ).toBe(1);
    await expectLedgerClosed();
  });
});

// ---------------------------------------------------------------------------

describe("inhouse betting — randomised sequences", () => {
  /** Deterministic PRNG: a fuzz that can't be re-run is a fuzz you can't fix. */
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("place / settle / cancel / abandon / void in any order keeps every ledger closed", async () => {
    const rand = mulberry32(20260729);

    for (let round = 0; round < 6; round++) {
      const ctx = await readyLobby();
      for (const p of [...ctx.t1, ...ctx.t2]) {
        if (rand() < 0.6) {
          const stake = (1 + Math.floor(rand() * 10)) * INHOUSE_BETS.STEP;
          await placeInhouseBet(p.session, stake);
        }
      }

      const roll = rand();
      if (roll < 0.2) {
        // Cancelled before anyone hosted.
        expect((await cancelLobby(ctx.admin)).ok).toBe(true);
      } else if (roll < 0.4) {
        // Hosted, then abandoned — the stake sat locked for six hours.
        expect((await startGame(ctx.t1[0].session)).ok).toBe(true);
        await prisma.inhouseLobby.update({
          where: { id: ctx.lobbyId },
          data: {
            startedAt: new Date(
              Date.now() - (INHOUSE.ABANDON_IN_PROGRESS_HOURS + 1) * 3_600_000,
            ),
          },
        });
        expect(await resolveAbandonedLobby()).toBe(true);
      } else if (roll < 0.8) {
        await playAndRecord(ctx, { winner: rand() < 0.5 ? 1 : 2 });
      } else {
        await playAndRecord(ctx, { winner: rand() < 0.5 ? 1 : 2 });
        expect((await voidLastResult(ctx.admin)).ok).toBe(true);
      }

      // Drain the sweeper — several rounds leave work, and it does one lobby
      // per call by design (one indexed probe per resolver run).
      for (let n = 0; n < 4 && (await resolveUnsettledBets()); n++);
      // cancelLobby re-queues its ten with a backdated heartbeat; leaving them
      // there would let the next round's lobby form around a stale cohort.
      await prisma.inhouseQueueEntry.deleteMany();

      await expectLedgerClosed();
      await expectZeroSum();
    }

    // Every lobby that ever held a bet reached a terminal settlement state —
    // no round left a stake debited with no outcome.
    const stuck = await prisma.inhouseLobby.count({
      where: { betSettlement: INHOUSE_BET_STATUS.PENDING },
    });
    expect(stuck).toBe(0);
    const unsettled = await prisma.inhouseBet.count({
      where: { confirmedAt: { not: null }, settledAt: null },
    });
    expect(unsettled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FAULT-INJECTED. This needs one exact interleaving — the caller READS the open
// window, a rival CANCELS, the caller WRITES — which `Promise.all` cannot
// steer: racing produced the losing ordering so rarely that the test passed
// against a service with no window re-assertion at all. Postgres only, because
// the rival runs on a second connection and SQLite pins one.
// ---------------------------------------------------------------------------

describe.skipIf(!ON_POSTGRES)("inhouse betting — claims that need a staged interleaving", () => {
  it("an admin cancel landing between the gate and the debit charges nobody", async () => {
    const ctx = await readyLobby();
    const me = ctx.t1[0];

    let fired = false;
    setRaceHook(
      onceAt("inhouseBet.placeBet.beforeDebit", async () => {
        fired = true;
        // A different connection, and a row the open transaction has not
        // written — otherwise this blocks on a lock the transaction is waiting
        // on us to release, which is a hang, not a failure.
        await prisma.inhouseLobby.update({
          where: { id: ctx.lobbyId },
          data: { status: INHOUSE_STATUS.CANCELLED },
        });
      }),
    );

    const res = await placeInhouseBet(me.session, 100);
    expect(fired).toBe(true); // the seam was reached — not a vacuous pass
    expect(res.ok).toBe(false);
    // The confirmation claim lost, so the whole transaction rolled back: no
    // debit, no bet row, no receipt. A `return` there instead of a throw would
    // have COMMITTED the debit for a bet on a lobby that no longer exists.
    expect(await balanceOf(me.user.id)).toBe(INHOUSE_BETS.START_BALANCE);
    expect(await prisma.inhouseBet.count()).toBe(0);
    expect(
      await prisma.inhouseCreditEntry.count({
        where: { reason: INHOUSE_CRED_REASON.STAKE },
      }),
    ).toBe(0);
    await expectLedgerClosed();
  });

  it("an admin deduction landing between the gate and the debit cannot overdraw", async () => {
    // THE deterministic pin for `balance: { gte: stake }` in the debit.
    //
    // A RACED version of this exists above (adjustCred vs placeInhouseBet via
    // raceAll) and it is NOT a reliable killer. The mutation ratchet caught
    // that, which is the whole reason this test exists. With the predicate
    // deleted, the raced version only goes red in ONE of the two orderings:
    //
    //   adjustCred first → balance 0 → blind debit → −100                → RED
    //   the bet first    → balance 0 → adjustCred's own guard refuses    → GREEN
    //
    // On SQLite `raceAll` runs sequentially, so it always took the first path
    // and looked like solid coverage. On Postgres — where the ratchet actually
    // runs — the two are genuinely concurrent, so the mutant survived about
    // half the time and the claim graded [unprotected]. A guard caught on a
    // coin flip is not caught.
    //
    // The seam removes the coin flip by committing the rival at exactly the
    // point between the gate's read and the debit. Safe on locks: at
    // `beforeDebit` the open transaction has written NOTHING, so the
    // InhouseCredit row is unlocked and the rival commits instead of blocking
    // (rule 1 in race-hook.ts — a rival that touches an already-written row is
    // a hang, not a failure).
    const ctx = await readyLobby();
    const me = ctx.t1[0];
    await drainTo(ctx.admin, me.user.id, 100);

    let fired = false;
    setRaceHook(
      onceAt("inhouseBet.placeBet.beforeDebit", async () => {
        fired = true;
        // Takes the exact Cred this bet is about to stake, on another
        // connection, after the gate has already read an affordable balance.
        const res = await adjustCred(
          ctx.admin,
          me.user.id,
          -100,
          "clawback in the gap",
        );
        expect(res.ok).toBe(true);
      }),
    );

    const res = await placeInhouseBet(me.session, 100);
    expect(fired).toBe(true); // not a vacuous pass
    // The debit re-asserts affordability at the WRITE, finds 0, matches no rows
    // and refuses — rather than charging money that is no longer there.
    expect(res.ok).toBe(false);
    // The assertion that kills the mutant: blind, this lands at −100.
    expect(await balanceOf(me.user.id)).toBe(0);
    expect(await prisma.inhouseBet.count()).toBe(0);
    await expectLedgerClosed();
  });
});
