import { prisma } from "./prisma";
import { INHOUSE_BETS, INHOUSE_CRED_PROFIT_REASONS } from "./constants";
import { inhousePlayedAt } from "./inhouse-history";

export type CredBetLine = {
  id: string;
  lobbyId: string;
  stake: number;
  outcome: string | null;
  payout: number | null;
  /** When the game was played (or formed, for a game that never started). */
  playedAt: Date;
};

export type CredSnapshot = {
  /** The spendable balance. A player who has never opened a bet sees the
   *  opening balance their account will be funded with. */
  balance: number;
  /** Net betting profit, the figure the Cred ladder ranks (GRANT, FLOOR and
   *  ADJUST excluded, exactly as `credProfitBoard` sums it). null = never
   *  bet, which is a different fact from breaking even. */
  net: number | null;
  bets: CredBetLine[];
};

/**
 * A player's Cred balance and their latest confirmed bets, for display only.
 *
 * READ-ONLY on purpose: it never creates the account. `ensureCredAccount` is
 * the one place an account (and its GRANT receipt) is born, and a page view
 * must not become a second one. Before that first bet the balance is simply
 * the column default the account will open with.
 *
 * Unconfirmed rows are skipped: a bet that never cleared the window never
 * moved any Cred, so listing it would show the player a wager that did not
 * happen.
 */
export async function loadCredSnapshot(
  userId: string,
  recent = 5,
): Promise<CredSnapshot> {
  const [account, profit, bets] = await Promise.all([
    prisma.inhouseCredit.findUnique({
      where: { userId },
      select: { balance: true },
    }),
    prisma.inhouseCreditEntry.aggregate({
      where: { userId, reason: { in: INHOUSE_CRED_PROFIT_REASONS } },
      _sum: { delta: true },
      _count: { _all: true },
    }),
    prisma.inhouseBet.findMany({
      where: { userId, confirmedAt: { not: null } },
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      take: recent,
      select: {
        id: true,
        lobbyId: true,
        stake: true,
        outcome: true,
        payout: true,
        lobby: {
          select: { matchStartTime: true, startedAt: true, createdAt: true },
        },
      },
    }),
  ]);
  return {
    balance: account?.balance ?? INHOUSE_BETS.START_BALANCE,
    net: profit._count._all > 0 ? (profit._sum.delta ?? 0) : null,
    bets: bets.map((b) => ({
      id: b.id,
      lobbyId: b.lobbyId,
      stake: b.stake,
      outcome: b.outcome,
      payout: b.payout,
      playedAt: inhousePlayedAt(b.lobby),
    })),
  };
}
