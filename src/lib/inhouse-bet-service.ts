import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import {
  INHOUSE_BET_OUTCOME,
  INHOUSE_BET_STATUS,
  INHOUSE_BETS,
  INHOUSE_CRED_PROFIT_REASONS,
  INHOUSE_CRED_REASON,
  INHOUSE_STATUS,
} from "./constants";
import { betGateError, settleBets, type Settlement } from "./inhouse-bets";
import { logAdminAction } from "./admin-log";
import { raceHook } from "./race-hook";
import type { SessionUser } from "./auth";
import type { ActionResult } from "./inhouse-service";

/**
 * The DB half of inhouse betting. The pure math lives in `inhouse-bets.ts`;
 * everything here is money movement, and money movement in this repo means the
 * two rules from CLAUDE.md apply at their strictest:
 *
 *   1. A read-time precondition is NOT a guard. `balance >= stake` read at the
 *      top of a request is a fact about the past — two tabs, two devices and
 *      the Discord `?join=1` deep link all reach `placeInhouseBet`, and there
 *      is no upstream single-winner claim on an account row. The affordability
 *      test therefore lives in the WHERE of the decrement itself.
 *   2. Past the first write, failure THROWS. A resolved Prisma
 *      interactive-transaction callback COMMITS, so every `return { ok: false }`
 *      after the debit would persist exactly the charge it was refusing.
 *
 * THE LEDGER IS THE PROVENANCE, THE BALANCE IS THE CLAIM. Every path below
 * writes both, and the invariant the integration suite asserts is
 * `balance === Σ ledger deltas` per user. If you add a movement, add its
 * receipt in the same transaction or that invariant is the thing that breaks.
 */

// The transaction-scoped Prisma client type (also satisfied by `prisma`).
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const isUniqueViolation = (e: unknown) =>
  (e as { code?: string }).code === "P2002";

/**
 * Thrown once `placeInhouseBet` has already debited the account but can no
 * longer prove the wager is legal. It MUST be a throw: returning here resolves
 * the interactive transaction, which commits it, so the player would be
 * charged for a bet on a lobby that had just been cancelled or whose window
 * had just closed. Caught OUTSIDE the callback (catching inside re-resolves it,
 * and on Postgres a query error poisons the transaction anyway).
 * Same shape as draft-service's `UndoRaceError` and inhouse's `PickRaceError`.
 */
class BetWindowError extends Error {}

/** Thrown after `settleInhouseBets` has won its claim but cannot settle. */
class BetSettleError extends Error {}

/**
 * Make sure a player has a Cred account, and return its balance.
 *
 * Runs OUTSIDE `placeInhouseBet`'s transaction on purpose, so that
 * transaction's FIRST write is the debit — an account create sitting in front
 * of it would make every "nothing has been written yet" claim in there false,
 * and the last-legal-return line would move to somewhere it can't be reasoned
 * about.
 *
 * The opening balance is a COLUMN DEFAULT (`InhouseCredit.balance`), so the
 * schema push funds every existing account with no backfill script; the GRANT
 * row here is only its receipt, and `@@unique([reason, refId])` with
 * `refId = userId` is what makes it once-ever under two tabs opening /inhouse
 * in the same instant.
 */
export async function ensureCredAccount(userId: string): Promise<number> {
  const existing = await prisma.inhouseCredit.findUnique({ where: { userId } });
  if (existing) return existing.balance;

  // The account and its opening receipt are ONE transaction.
  //
  // They used to be two statements with a "the unique makes the retry free"
  // comment, which was wrong about its own function: the `if (existing)
  // return` above means there IS no retry. A process dying between the two
  // writes left a funded account with no GRANT row, every later call took the
  // early return, and `balance === START + Σ ledger deltas` — the identity
  // every money test in this feature leans on — was broken for that user
  // forever, with nothing anywhere to notice.
  //
  // Atomic, so the orphan state cannot exist, which is what makes the fast
  // path above safe rather than merely fast.
  try {
    return await prisma.$transaction(async (tx) => {
      const acct = await tx.inhouseCredit.create({ data: { userId } });
      await tx.inhouseCreditEntry.create({
        data: {
          userId,
          delta: INHOUSE_BETS.START_BALANCE,
          reason: INHOUSE_CRED_REASON.GRANT,
          refId: userId,
        },
      });
      return acct.balance;
    });
  } catch (e) {
    // Lost the creation race. The winner's transaction wrote BOTH rows, so
    // there is nothing to repair — just re-read, rather than assume
    // START_BALANCE: by the time a second request lands here the winner may
    // already have staked out of it.
    if (!isUniqueViolation(e)) throw e;
    const row = await prisma.inhouseCredit.findUnique({ where: { userId } });
    return row?.balance ?? INHOUSE_BETS.START_BALANCE;
  }
}

/**
 * Place a wager on your OWN team, once, immutably.
 *
 * Eligibility is derived from `InhouseLobbyPlayer` and re-derived in the WHERE
 * of the confirmation write — never from "has a session". `/api/inhouse`
 * answers `state` before its 401 gate, so being signed in is no gate at all,
 * and a spectator or an alt must not be able to buy a position in someone
 * else's game.
 */
export async function placeInhouseBet(
  viewer: SessionUser,
  stake: number,
): Promise<ActionResult> {
  const balance = await ensureCredAccount(viewer.id);

  try {
    return await prisma.$transaction(async (tx) => {
      // READY *and* IN_PROGRESS: the window closes on `betsCloseAt` alone.
      // Pressing Start deliberately does not close it, so nobody is ever the
      // person who cut the betting short, and Start stays instant.
      const lobby = await tx.inhouseLobby.findFirst({
        where: {
          status: {
            in: [INHOUSE_STATUS.READY, INHOUSE_STATUS.IN_PROGRESS],
          },
        },
        include: { players: true },
      });
      const acct = await tx.inhouseCredit.findUnique({
        where: { userId: viewer.id },
      });
      const mine = lobby?.players.find((p) => p.userId === viewer.id) ?? null;
      const alreadyBet = lobby
        ? (await tx.inhouseBet.count({
            where: { lobbyId: lobby.id, userId: viewer.id },
          })) > 0
        : false;

      const gate = betGateError({
        balance: acct?.balance ?? balance,
        stake,
        myTeam: mine?.team ?? null,
        lobbyStatus: lobby?.status ?? "",
        betsCloseAtMs: lobby?.betsCloseAt?.getTime() ?? null,
        nowMs: Date.now(),
        alreadyBet,
      });
      if (gate) return { ok: false as const, error: gate };

      // Reaching here proves both of these — `betGateError` answers "You're not
      // in this game" for a null lobby or a null team — but TypeScript can't
      // see through a pure helper, and a bare `!` would silently become an
      // unhandled crash if that check order ever moved. Still a legal return:
      // nothing has been written.
      if (!lobby || mine?.team == null) {
        return { ok: false as const, error: "You're not in this game" };
      }
      const team = mine.team;

      // Seam: everything above is a READ, so a rival on another connection can
      // commit here without blocking. The interleaving that matters — an admin
      // cancel, or the 45s window expiring, landing between the gate and the
      // writes — is the one no amount of racing reliably produces.
      await raceHook("inhouseBet.placeBet.beforeDebit");

      // WRITE 1 — the money claim. `balance: { gte: stake }` IS the guard.
      // There is no upstream single-winner claim on this row, so an
      // `if (balance < stake) return` above a blind decrement is a documented
      // overdraft on Postgres READ COMMITTED: two tabs both read 100, both
      // stake 100, and the account ends at -100 with two live positions.
      const debit = await tx.inhouseCredit.updateMany({
        where: { userId: viewer.id, balance: { gte: stake } },
        data: { balance: { decrement: stake } },
      });
      // THE LAST LEGAL RETURN in this callback: nothing is written yet.
      if (debit.count === 0) {
        return { ok: false as const, error: "You don't have that much Cred." };
      }

      // WRITE 2 — the wager itself. `@@unique([lobbyId, userId])` is what makes
      // a double-click one bet rather than two debits; the P2002 is caught
      // OUTSIDE the callback, where the rollback has already undone WRITE 1.
      const bet = await tx.inhouseBet.create({
        data: { lobbyId: lobby.id, userId: viewer.id, team, stake },
      });

      // WRITE 3 — re-assert the WINDOW and OWN-TEAM MEMBERSHIP at the write,
      // through relation filters (the `acceptMatch` pattern). Every predicate
      // checked by the gate above can be false by the time this lands, and the
      // two that commit in exactly that gap are an admin cancel and the window
      // expiring. `confirmedAt` doubles as the marker settlement reads: an
      // unconfirmed row can never pay out.
      const confirmed = await tx.inhouseBet.updateMany({
        where: {
          id: bet.id,
          lobby: {
            status: {
              in: [INHOUSE_STATUS.READY, INHOUSE_STATUS.IN_PROGRESS],
            },
            betsCloseAt: { gt: new Date() },
            players: { some: { userId: viewer.id, team } },
          },
        },
        data: { confirmedAt: new Date() },
      });
      if (confirmed.count === 0) {
        // Past the first write: THROW. See BetWindowError — a return here
        // commits the debit this branch exists to undo, and the player is
        // charged for a bet that never existed.
        throw new BetWindowError("Betting just closed on this game.");
      }

      // WRITE 4 — arm the sweeper. `betSettlement: null` means "this lobby has
      // no bets and will never be swept", so the FIRST bet is what turns the
      // lobby into work for `resolveUnsettledBets`. Idempotent, and the count
      // is deliberately ignored: the second bettor matches nothing because the
      // first already flipped it, which is success, not a race.
      await tx.inhouseLobby.updateMany({
        where: { id: lobby.id, betSettlement: null },
        data: { betSettlement: INHOUSE_BET_STATUS.PENDING },
      });

      // WRITE 5 — the receipt.
      await tx.inhouseCreditEntry.create({
        data: {
          userId: viewer.id,
          delta: -stake,
          reason: INHOUSE_CRED_REASON.STAKE,
          refId: bet.id,
          lobbyId: lobby.id,
        },
      });
      return { ok: true as const };
    });
  } catch (e) {
    // OUTSIDE the callback on purpose — catching inside resolves the
    // transaction, which commits the very writes the throw exists to roll back.
    if (e instanceof BetWindowError) {
      return { ok: false as const, error: e.message };
    }
    if (isUniqueViolation(e)) {
      // The @@unique caught a second tab. Bets are single-shot and immutable,
      // so this is a refusal, not a retry — and the debit rolled back with it.
      return { ok: false as const, error: "You already bet on this game." };
    }
    throw e;
  }
}

/** One settlement leg: a balance move and the receipt that explains it. */
type CreditLeg = { reason: string; delta: number };

/**
 * Pay out a completed lobby's pot. Returns the settlement, or null when this
 * caller did not win the claim (already settled, no bets, or not completed).
 *
 * THE CLAIM AND EVERY WRITE SHARE ONE TRANSACTION. That is affordable — at
 * most ten bets, ten balance rows, ~thirty ledger rows, and NO external calls —
 * and it is what makes a mid-settlement death harmless: everything rolls back,
 * the lobby stays PENDING, and `resolveUnsettledBets` retries it cleanly on the
 * next page view anywhere on the site.
 */
export async function settleInhouseBets(
  lobbyId: string,
): Promise<Settlement | null> {
  return prisma.$transaction(async (tx) => {
    // WRITE 1 — the settlement claim. It elects exactly one winner across all
    // three result paths (button, pasted match id, background scan) AND the
    // lazy sweeper, under concurrent unauthenticated /api/sync pings. Without
    // it a pot pays twice, which is the one bug in a money feature nobody
    // forgives.
    const claim = await tx.inhouseLobby.updateMany({
      where: {
        id: lobbyId,
        status: INHOUSE_STATUS.COMPLETED,
        betSettlement: INHOUSE_BET_STATUS.PENDING,
      },
      data: { betSettlement: INHOUSE_BET_STATUS.SETTLED },
    });
    // THE LAST LEGAL RETURN: nothing else has been written.
    if (claim.count === 0) return null;

    const lobby = await tx.inhouseLobby.findUniqueOrThrow({
      where: { id: lobbyId },
      // `confirmedAt` is the marker WRITE 3 of placeInhouseBet stamps. A row
      // without it never survived its window claim, so it must never pay.
      include: { players: true, bets: { where: { confirmedAt: { not: null } } } },
    });
    if (lobby.winnerTeam == null) {
      // applyResult writes winnerTeam in the same claim that writes COMPLETED,
      // so this is a corruption tripwire rather than a race. Throwing rolls the
      // claim back — settling a pot with no winner would have to invent one.
      throw new BetSettleError(`Lobby ${lobbyId} completed with no winner`);
    }

    const settlement = settleBets({
      bets: lobby.bets.map((b) => ({
        userId: b.userId,
        team: b.team,
        stake: b.stake,
        placedAtMs: b.placedAt.getTime(),
      })),
      // POST-teamFixes: applyResult has already moved anyone who played the
      // opposite side onto the side they actually played, and this map is what
      // the VOID_LINEUP rule compares each frozen bet against. Settling before
      // that loop would price a slot swap as a live two-man arbitrage.
      rosterTeam: new Map(lobby.players.map((p) => [p.userId, p.team])),
      winnerTeam: lobby.winnerTeam,
      // A COLUMN, not a value carried from the request that fetched the match:
      // the request holding the BuiltResult is allowed to die, and the recovery
      // path has to reach the same verdict on the late-bet void as the fast one.
      matchStartMs: lobby.matchStartTime?.getTime() ?? null,
    });

    // Every wager leg keys its receipt on the BET ID (the schema's stated
    // idempotence key), so `@@unique([reason, refId])` makes each of a bet's
    // legs write-once. settleBets returns rows keyed by user, so the id has to
    // come back off the fetched bets.
    const betIdOf = new Map(lobby.bets.map((b) => [b.userId, b.id]));

    const now = new Date();
    for (const b of settlement.bets) {
      const betId = betIdOf.get(b.userId);
      // settleBets only ever returns rows it was given, so this is
      // unreachable — but past the claim the only safe way to be wrong about
      // money is loudly. A `continue` here would silently skip one player's
      // payout inside a settlement that then reports success.
      if (!betId) throw new BetSettleError(`Settled an unknown bet in ${lobbyId}`);
      await tx.inhouseBet.update({
        where: { lobbyId_userId: { lobbyId, userId: b.userId } },
        data: {
          outcome: b.outcome,
          matched: b.matched,
          payout: b.delta,
          settledAt: now,
        },
      });

      // A BLIND `{ increment }`, DELIBERATELY. It is correct BECAUSE the claim
      // above already elected exactly one settler, so this row has no rival —
      // the same reasoning as the draft's budget credit. DO NOT "fix" this into
      // a conditional write: a guarded version would silently pay nothing when
      // its predicate drifted, and a settlement that quietly skips a player is
      // far worse than one that fails loudly and gets retried.
      await tx.inhouseCredit.update({
        where: { userId: b.userId },
        data: { balance: { increment: b.stake + b.delta } },
      });

      // The receipts. RETURN carries the WHOLE stake back off the table — the
      // unmatched part that was never live plus the matched part the WIN/LOSS
      // leg is about to settle — so STAKE and RETURN cancel exactly and
      // `credProfitBoard`'s sum over the profit reasons reduces to WIN + LOSS
      // (+ REVERSAL). Split it any other way and the profit board stops being
      // net profit, which is the one number the whole feature is scored on.
      const legs: CreditLeg[] = [];
      if (
        b.outcome === INHOUSE_BET_OUTCOME.VOID_LINEUP ||
        b.outcome === INHOUSE_BET_OUTCOME.VOID_LATE
      ) {
        legs.push({ reason: INHOUSE_CRED_REASON.REFUND, delta: b.stake });
      } else {
        legs.push({ reason: INHOUSE_CRED_REASON.RETURN, delta: b.stake });
        // Skipped at zero: an unopposed side is matched for nothing, and a
        // receipt reading "you won 0" is noise in an audit trail.
        if (b.matched > 0) {
          legs.push({
            reason:
              b.outcome === INHOUSE_BET_OUTCOME.WON
                ? INHOUSE_CRED_REASON.WIN
                : INHOUSE_CRED_REASON.LOSS,
            delta: b.delta,
          });
        }
      }
      for (const leg of legs) {
        await tx.inhouseCreditEntry.create({
          data: {
            userId: b.userId,
            delta: leg.delta,
            reason: leg.reason,
            refId: betId,
            lobbyId,
          },
        });
      }
    }

    // ALL TEN, not just the bettors: the floor is a participation net, and a
    // player who sat out one pot is no less broke for it.
    await applyFloor(
      tx,
      lobbyId,
      lobby.durationSecs,
      lobby.players.map((p) => p.userId),
    );

    // The eloDeltas contract exactly: stamped once, read by the room's
    // post-game banner, never re-derived on a poll.
    await tx.inhouseLobby.update({
      where: { id: lobbyId },
      data: { betDeltas: JSON.stringify(settlement.deltas) },
    });
    return settlement;
  });
}

/**
 * The bankruptcy net: a participant left under FLOOR is topped up TO it.
 *
 * Three cuts keep it from being a money printer, and all three are load-bearing
 * (see the designated-donor row in the design doc's anti-abuse table):
 * the profit board ranks net BETTING profit, so FLOOR is liquidity and never
 * score; the game has to have lasted `REAL_GAME_SECONDS`, which kills
 * four-minute feed-fest faucet farming; and it pays at most once per UTC day
 * per player, enforced by the ledger's `@@unique([reason, refId])`.
 */
async function applyFloor(
  tx: Tx,
  lobbyId: string,
  durationSecs: number | null,
  participantIds: string[],
): Promise<void> {
  if ((durationSecs ?? 0) < INHOUSE_BETS.REAL_GAME_SECONDS) return;
  const day = new Date().toISOString().slice(0, 10); // UTC yyyy-mm-dd

  // Re-read AFTER the payout loop: the balances it wrote are visible to this
  // same transaction, and topping up off pre-payout figures would hand money
  // to a player whose winnings had just cleared the floor.
  const accounts = await tx.inhouseCredit.findMany({
    where: { userId: { in: participantIds }, balance: { lt: INHOUSE_BETS.FLOOR } },
  });
  for (const acct of accounts) {
    const refId = `${acct.userId}:${day}`;
    // Checked, not caught. A P2002 inside an open interactive transaction
    // POISONS it on Postgres — every later statement fails with "current
    // transaction is aborted" — so the catch-and-continue that works outside a
    // transaction is not available here. The unique is still the real guard:
    // if a genuine collision slips past this read the create throws, the WHOLE
    // settlement rolls back, and the sweeper's retry sees the row and skips it.
    const paid = await tx.inhouseCreditEntry.findUnique({
      where: {
        reason_refId: { reason: INHOUSE_CRED_REASON.FLOOR, refId },
      },
    });
    if (paid) continue;

    // MOVEMENT FIRST, and as a compare-and-swap on the exact balance read
    // above. This is the ONE absolute assignment in the whole money layer —
    // everything else is a relative { increment } — and `acct` was read
    // without a lock on a row this transaction has not written. Under
    // Postgres READ COMMITTED a concurrent write (an admin `adjustCred`, now
    // that it has a UI) would be silently overwritten by `balance: FLOOR`,
    // which is a lost update: the receipt says one thing and the column says
    // another, and `balance === START + Σ deltas` stops holding.
    const moved = await tx.inhouseCredit.updateMany({
      where: { userId: acct.userId, balance: acct.balance },
      data: { balance: INHOUSE_BETS.FLOOR },
    });
    // Someone moved the balance under us. SKIP rather than retry: the floor
    // is a safety net, not a guarantee, it is once-a-day anyway, and the
    // settlement this runs inside is already correct and complete — losing a
    // top-up costs a player 100 play-money Cred on one night, where a lost
    // update costs the books their integrity. Not a failure, so not a throw.
    if (moved.count === 0) continue;

    // Receipt AFTER the movement, and only if it landed. Written first, it
    // would record a top-up that the CAS then declined to make.
    await tx.inhouseCreditEntry.create({
      data: {
        userId: acct.userId,
        delta: INHOUSE_BETS.FLOOR - acct.balance,
        reason: INHOUSE_CRED_REASON.FLOOR,
        refId,
        lobbyId,
      },
    });
  }
}

/**
 * The lazy sweeper — the ONE refund rule, instead of a refund leg bolted into
 * each of the four already-hardened paths that can kill a lobby.
 * `cancelLobby`, `resolveAbandonedLobby`, `failReadyCheck` and `voidLastResult`
 * all flip the lobby into a state one of the branches below recognises, so none
 * of them needed a line of betting code. (`failReadyCheck` cannot even produce
 * a pot: the window opens at READY, four phases later.)
 *
 * ONE indexed probe per resolver run — `betSettlement` is indexed and is null
 * on every lobby in a league that never bets, so the cost of the whole feature
 * being switched off is a single index probe.
 *
 * CALLERS MUST WRAP THIS IN try/catch. It runs inside resolver chains that
 * `/api/sync` executes on every page view of the entire site: a bet bug must
 * never be able to stop ten people playing Dota.
 */
export async function resolveUnsettledBets(): Promise<boolean> {
  const lobby = await prisma.inhouseLobby.findFirst({
    where: {
      OR: [
        {
          betSettlement: INHOUSE_BET_STATUS.PENDING,
          status: {
            in: [INHOUSE_STATUS.COMPLETED, INHOUSE_STATUS.CANCELLED],
          },
        },
        // An admin voided a result the pot had already been paid on.
        {
          betSettlement: INHOUSE_BET_STATUS.SETTLED,
          status: INHOUSE_STATUS.CANCELLED,
        },
      ],
    },
    select: { id: true, status: true, betSettlement: true },
  });
  if (!lobby) return false;

  if (lobby.betSettlement === INHOUSE_BET_STATUS.PENDING) {
    if (lobby.status === INHOUSE_STATUS.COMPLETED) {
      return (await settleInhouseBets(lobby.id)) !== null;
    }
    return refundLobbyBets(lobby.id);
  }
  return reverseLobbyBets(lobby.id);
}

/**
 * A lobby died before it produced a result (admin cancel, the abandon sweep,
 * a void of a game that never settled): every confirmed bet comes back in full.
 *
 * Refunds are what make the hostage case EV-neutral — nobody can compel a Dota
 * game, and a player who hates their position can simply refuse to host until
 * the abandon sweep fires hours later. There is nothing to profit from, but the
 * stake IS locked for that long, which is why the room says so at bet time.
 */
async function refundLobbyBets(lobbyId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.inhouseLobby.updateMany({
      where: {
        id: lobbyId,
        betSettlement: INHOUSE_BET_STATUS.PENDING,
        // Re-asserted at the write: two pollers reach this together, and only
        // one may hand the money back.
        status: INHOUSE_STATUS.CANCELLED,
      },
      data: { betSettlement: INHOUSE_BET_STATUS.REFUNDED, betDeltas: "{}" },
    });
    if (claim.count === 0) return false; // THE LAST LEGAL RETURN

    const bets = await tx.inhouseBet.findMany({
      where: { lobbyId, confirmedAt: { not: null } },
    });
    const now = new Date();
    for (const bet of bets) {
      await tx.inhouseBet.update({
        where: { id: bet.id },
        data: {
          outcome: INHOUSE_BET_OUTCOME.REFUNDED,
          matched: 0,
          payout: 0,
          settledAt: now,
        },
      });
      // Blind, for the reason the settlement increment is blind: the claim
      // above elected one refunder.
      await tx.inhouseCredit.update({
        where: { userId: bet.userId },
        data: { balance: { increment: bet.stake } },
      });
      await tx.inhouseCreditEntry.create({
        data: {
          userId: bet.userId,
          delta: bet.stake,
          reason: INHOUSE_CRED_REASON.REFUND,
          refId: bet.id,
          lobbyId,
        },
      });
    }
    return true;
  });
}

/**
 * An admin voided a result whose pot was ALREADY paid: undo the payout so every
 * bettor is exactly where they were before the game.
 *
 * Net zero vs. pre-game, not vs. post-settlement: the stake was debited at bet
 * time and returned whole at settlement, so the only thing left to unwind is
 * the WIN/LOSS leg. Re-debiting the stake here would charge people twice for a
 * game that officially never happened.
 *
 * The FLOOR top-up IS clawed back, and its ledger row DELETED rather than
 * offset — see the loop at the bottom. This docstring used to say the exact
 * opposite ("deliberately NOT clawed back, it is a faucet keyed to a UTC day"),
 * which is how the minting bug survived review: the reasoning read as
 * considered, so nobody checked it against the sentence two paragraphs up. A
 * top-up is part of what the game did to a balance, so leaving it makes
 * "exactly where they were before the game" false by up to FLOOR.
 */
async function reverseLobbyBets(lobbyId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.inhouseLobby.updateMany({
      where: {
        id: lobbyId,
        betSettlement: INHOUSE_BET_STATUS.SETTLED,
        status: INHOUSE_STATUS.CANCELLED,
      },
      data: { betSettlement: INHOUSE_BET_STATUS.REVERSED, betDeltas: "{}" },
    });
    if (claim.count === 0) return false; // THE LAST LEGAL RETURN

    const bets = await tx.inhouseBet.findMany({
      where: { lobbyId, confirmedAt: { not: null }, payout: { not: null } },
    });
    for (const bet of bets) {
      const payout = bet.payout ?? 0;
      if (payout !== 0) {
        await tx.inhouseCredit.update({
          where: { userId: bet.userId },
          data: { balance: { increment: -payout } },
        });
        await tx.inhouseCreditEntry.create({
          data: {
            userId: bet.userId,
            delta: -payout,
            reason: INHOUSE_CRED_REASON.REVERSAL,
            refId: bet.id,
            lobbyId,
          },
        });
      }
      // The row reads as a refund from here on — its net effect on the player
      // IS zero now. What it originally paid stays in the ledger (WIN then
      // REVERSAL), which is the record that has to survive; the bet row is
      // read by career rolls that must not count a voided game.
      await tx.inhouseBet.update({
        where: { id: bet.id },
        data: {
          outcome: INHOUSE_BET_OUTCOME.REFUNDED,
          matched: 0,
          payout: 0,
        },
      });
    }

    // Undo the bankruptcy floor this game paid, too.
    //
    // The top-up is part of what the game did to a balance, so reversing only
    // the wager legs MINTS Cred: a player whose loss dropped them under 100
    // was floored back to 100, and a void that hands their stake back while
    // leaving the top-up in place ends them strictly better off than before a
    // game that officially never happened. It also made this function's own
    // docstring — "exactly where they were before the game" — false.
    const floors = await tx.inhouseCreditEntry.findMany({
      where: { lobbyId, reason: INHOUSE_CRED_REASON.FLOOR },
    });
    for (const f of floors) {
      await tx.inhouseCredit.update({
        where: { userId: f.userId },
        data: { balance: { increment: -f.delta } },
      });
      // DELETED, not offset with a compensating row. `refId` is
      // "<userId>:<utc-day>" and the @@unique([reason, refId]) IS the
      // once-a-day rule, so an offsetting entry would leave the day key burned
      // — the player could not be floored again tonight, punishing them for an
      // admin's void. Deleting releases the key, and the FLOOR reason is
      // excluded from the profit board either way, so no score moves.
      await tx.inhouseCreditEntry.delete({ where: { id: f.id } });
    }
    return true;
  });
}

/**
 * Net Cred profit per player — the second ladder.
 *
 * Sums ONLY the profit reasons, which excludes GRANT, FLOOR and ADJUST: the
 * board ranks what you took off other players, never what the system handed
 * you. That single choice is what makes the bankruptcy floor safe (a player
 * parked at the floor mints liquidity but can never mint SCORE) and what keeps
 * attendance unrankable — betting is zero-sum, so this board is centred on zero
 * forever and #14 in Elo can be #1 here.
 */
export async function credProfitBoard(): Promise<Map<string, number>> {
  const rows = await prisma.inhouseCreditEntry.groupBy({
    by: ["userId"],
    where: { reason: { in: INHOUSE_CRED_PROFIT_REASONS } },
    _sum: { delta: true },
  });
  return new Map(rows.map((r) => [r.userId, r._sum.delta ?? 0]));
}

/**
 * Admin correction — the escape hatch every other admin surface in this repo
 * has, and the only writer of Cred that isn't a bet.
 *
 * Logged through `logAdminAction` because it is the one movement with no
 * mechanical provenance: every other ledger row can be traced to a wager and a
 * result, and this one can only be traced to a person.
 */
export async function adjustCred(
  actor: SessionUser,
  userId: string,
  delta: number,
  note: string,
): Promise<ActionResult> {
  if (actor.role !== "ADMIN") return { ok: false, error: "Admins only" };
  if (!Number.isInteger(delta) || delta === 0) {
    return { ok: false, error: "Enter a whole, non-zero amount of Cred." };
  }
  await ensureCredAccount(userId);

  const applied = await prisma.$transaction(async (tx) => {
    // The no-overdraw floor applies to DEBITS ONLY, and that asymmetry is the
    // whole point of this write.
    //
    // It used to be `gte: Math.max(0, -delta)`, which on a CREDIT evaluates to
    // `gte: 0` — so a negative balance refused the one operation that could
    // repair it. That is not hypothetical: `reverseLobbyBets` claws a payout
    // back with an unfloored decrement, so a player who staked their winnings
    // on the next lobby before an admin voided the previous game lands below
    // zero, and the admin then found the fix locked behind the bug. A credit
    // must always land. A debit still re-asserts affordability in the WHERE,
    // because the balance read a moment ago can have been staked since.
    const moved = await tx.inhouseCredit.updateMany({
      where: delta < 0 ? { userId, balance: { gte: -delta } } : { userId },
      data: { balance: { increment: delta } },
    });
    if (moved.count === 0) return false; // THE LAST LEGAL RETURN
    await tx.inhouseCreditEntry.create({
      data: {
        userId,
        delta,
        reason: INHOUSE_CRED_REASON.ADJUST,
        // No natural key: an adjustment is not idempotent with anything, and
        // two corrections to the same account in the same second are a thing an
        // admin can legitimately do.
        refId: randomUUID(),
        note: note.slice(0, 200) || null,
      },
    });
    return true;
  });
  if (!applied) {
    return {
      ok: false,
      error: "That would take them below zero Cred — they've staked since.",
    };
  }

  await logAdminAction({
    action: "adjustCred",
    summary: `Adjusted ${userId}'s Cred by ${delta > 0 ? "+" : ""}${delta}${
      note ? ` (${note})` : ""
    }`,
  });
  return { ok: true };
}
