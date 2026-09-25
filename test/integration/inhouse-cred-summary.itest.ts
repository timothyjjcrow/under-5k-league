import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  INHOUSE_BETS,
  INHOUSE_CRED_REASON,
  INHOUSE_STATUS,
} from "@/lib/constants";
import { loadCredSnapshot } from "@/lib/inhouse-cred-summary";
import { makeUser } from "./factories";

async function lobbyAt(opts: {
  createdAt: Date;
  startedAt?: Date;
  matchStartTime?: Date;
}) {
  return prisma.inhouseLobby.create({
    data: { status: INHOUSE_STATUS.COMPLETED, ...opts },
  });
}

describe("loadCredSnapshot", () => {
  it("shows the opening balance without creating an account", async () => {
    const user = await makeUser("Newcomer");
    const snap = await loadCredSnapshot(user.id);
    expect(snap).toEqual({
      balance: INHOUSE_BETS.START_BALANCE,
      net: null,
      bets: [],
    });
    // A page view must never become a second place accounts are born.
    expect(await prisma.inhouseCredit.count()).toBe(0);
    expect(await prisma.inhouseCreditEntry.count()).toBe(0);
  });

  it("reads the balance column and nets only betting legs", async () => {
    const user = await makeUser("Bettor");
    await prisma.inhouseCredit.create({
      data: { userId: user.id, balance: 620 },
    });
    const legs: Array<[string, number]> = [
      [INHOUSE_CRED_REASON.GRANT, 500],
      [INHOUSE_CRED_REASON.STAKE, -100],
      [INHOUSE_CRED_REASON.RETURN, 100],
      [INHOUSE_CRED_REASON.WIN, 80],
      [INHOUSE_CRED_REASON.FLOOR, 50],
      [INHOUSE_CRED_REASON.ADJUST, -10],
    ];
    for (const [reason, delta] of legs) {
      await prisma.inhouseCreditEntry.create({
        data: { userId: user.id, reason, delta, refId: `${user.id}:${reason}` },
      });
    }
    const snap = await loadCredSnapshot(user.id);
    expect(snap.balance).toBe(620);
    // GRANT, FLOOR and ADJUST are not profit: the Cred ladder's own rule.
    expect(snap.net).toBe(80);
  });

  it("reports breaking even as 0, not as never having bet", async () => {
    const user = await makeUser("Even");
    for (const [reason, delta] of [
      [INHOUSE_CRED_REASON.STAKE, -50],
      [INHOUSE_CRED_REASON.RETURN, 50],
    ] as const) {
      await prisma.inhouseCreditEntry.create({
        data: { userId: user.id, reason, delta, refId: `${user.id}:${reason}` },
      });
    }
    expect((await loadCredSnapshot(user.id)).net).toBe(0);
  });

  it("lists confirmed bets newest first with the played time, up to the limit", async () => {
    const user = await makeUser("Regular");
    const day = 864e5;
    const base = Date.UTC(2026, 8, 1, 18);
    const played = await lobbyAt({
      createdAt: new Date(base),
      startedAt: new Date(base + 60_000),
      matchStartTime: new Date(base + 120_000),
    });
    const started = await lobbyAt({
      createdAt: new Date(base + day),
      startedAt: new Date(base + day + 60_000),
    });
    const formed = await lobbyAt({ createdAt: new Date(base + 2 * day) });
    const unconfirmed = await lobbyAt({ createdAt: new Date(base + 3 * day) });

    await prisma.inhouseBet.create({
      data: {
        lobbyId: played.id,
        userId: user.id,
        team: 1,
        stake: 100,
        placedAt: new Date(base),
        confirmedAt: new Date(base),
        outcome: "WON",
        payout: 60,
      },
    });
    await prisma.inhouseBet.create({
      data: {
        lobbyId: started.id,
        userId: user.id,
        team: 2,
        stake: 40,
        placedAt: new Date(base + day),
        confirmedAt: new Date(base + day),
        outcome: "LOST",
        payout: -40,
      },
    });
    await prisma.inhouseBet.create({
      data: {
        lobbyId: formed.id,
        userId: user.id,
        team: 1,
        stake: 20,
        placedAt: new Date(base + 2 * day),
        confirmedAt: new Date(base + 2 * day),
      },
    });
    // Never cleared the betting window, so it never moved any Cred.
    await prisma.inhouseBet.create({
      data: {
        lobbyId: unconfirmed.id,
        userId: user.id,
        team: 1,
        stake: 30,
        placedAt: new Date(base + 3 * day),
      },
    });

    const snap = await loadCredSnapshot(user.id);
    expect(
      snap.bets.map((b) => [b.lobbyId, b.stake, b.outcome, b.payout]),
    ).toEqual([
      [formed.id, 20, null, null],
      [started.id, 40, "LOST", -40],
      [played.id, 100, "WON", 60],
    ]);
    expect(snap.bets.map((b) => b.playedAt.getTime())).toEqual([
      base + 2 * day,
      base + day + 60_000,
      base + 120_000,
    ]);

    const limited = await loadCredSnapshot(user.id, 2);
    expect(limited.bets.map((b) => b.lobbyId)).toEqual([formed.id, started.id]);
  });
});
