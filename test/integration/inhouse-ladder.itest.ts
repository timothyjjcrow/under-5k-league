import { describe, it, expect, beforeEach, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { INHOUSE_STATUS } from "@/lib/constants";
import {
  loadInhouseLadder,
  loadInhouseLadderSummary,
  loadInhouseMonthLadder,
  resetInhouseLadderCache,
} from "@/lib/inhouse-ladder";
import {
  MONTH_MIN_GAMES,
  PROVISIONAL_GAMES,
  rankInhouse,
  summarizeInhouse,
  toFinishedLobby,
} from "@/lib/inhouse-stats";
import { makeUser } from "./factories";
import { loadBoardStats, resetBoardStatsCache } from "@/lib/inhouse-board-service";
import { SETTING_KEYS, setSetting } from "@/lib/settings";

// Ten users, teams 1/2 by index parity; winnerTeam decides each lobby.
async function seedLobby(
  userIds: string[],
  winnerTeam: 1 | 2,
  createdAt: Date,
) {
  return prisma.inhouseLobby.create({
    data: {
      status: INHOUSE_STATUS.COMPLETED,
      winnerTeam,
      createdAt,
      players: {
        create: userIds.map((userId, i) => ({
          userId,
          team: i % 2 === 0 ? 1 : 2,
          mmr: 3000,
        })),
      },
    },
  });
}

describe("loadInhouseLadder — the memoised full-history ladder", () => {
  beforeEach(async () => {
    resetInhouseLadderCache();
    resetBoardStatsCache();
    await prisma.inhouseLobbyPlayer.deleteMany({});
    await prisma.inhouseLobby.deleteMany({});
  });

  it("matches a direct rankInhouse(summarizeInhouse(…)) over the same rows", async () => {
    const users = [];
    for (let i = 0; i < 10; i++) users.push(await makeUser(`Ladder P${i}`));
    const ids = users.map((u) => u.id);
    const base = Date.UTC(2026, 6, 1);
    // Enough lobbies that the even-index five clear PROVISIONAL_GAMES while a
    // late joiner stays provisional.
    for (let g = 0; g < PROVISIONAL_GAMES; g++) {
      await seedLobby(ids, g % 3 === 0 ? 2 : 1, new Date(base + g * 3_600_000));
    }
    const late = await makeUser("Late Joiner");
    await seedLobby(
      [...ids.slice(0, 9), late.id],
      1,
      new Date(base + 10 * 3_600_000),
    );

    const ladder = await loadInhouseLadder(Date.UTC(2026, 7, 1));

    const rows = await prisma.inhouseLobby.findMany({
      where: { status: INHOUSE_STATUS.COMPLETED },
      select: {
        id: true,
        winnerTeam: true,
        createdAt: true,
        players: {
          select: {
            userId: true,
            team: true,
            user: { select: { name: true, avatar: true } },
          },
        },
      },
    });
    const direct = rankInhouse(summarizeInhouse(rows.map(toFinishedLobby)));
    expect(ladder).toEqual(direct);

    // The split respects the games floor in both directions.
    expect(ladder.ranked.length).toBeGreaterThan(0);
    expect(
      ladder.ranked.every((r) => r.games >= PROVISIONAL_GAMES),
    ).toBe(true);
    const lateRow = ladder.provisional.find((r) => r.userId === late.id);
    expect(lateRow?.games).toBe(1);
  });

  it("serves the memo inside the TTL and recomputes after it", async () => {
    const users = [];
    for (let i = 0; i < 10; i++) users.push(await makeUser(`Memo P${i}`));
    const ids = users.map((u) => u.id);
    const t0 = Date.UTC(2026, 7, 1);
    await seedLobby(ids, 1, new Date(t0 - 3_600_000));

    const first = await loadInhouseLadder(t0);
    const totalRows = (l: typeof first) =>
      l.ranked.length + l.provisional.length;
    expect(totalRows(first)).toBe(10);

    // A second lobby lands; a read inside the TTL still serves the memo…
    await seedLobby(ids, 2, new Date(t0 - 1_800_000));
    const cached = await loadInhouseLadder(t0 + 30_000);
    expect(cached).toEqual(first);

    // …and a read past the TTL sees the new game.
    const fresh = await loadInhouseLadder(t0 + 61_000);
    const anyRow = fresh.ranked[0] ?? fresh.provisional[0];
    expect(anyRow.games).toBe(2);

    // The reset seam drops the memo immediately (what beforeEach relies on).
    resetInhouseLadderCache();
    const reread = await loadInhouseLadder(t0 + 61_500);
    expect(reread).toEqual(fresh);
  });

  it("shares one full-history scan between page, board and player-list readers", async () => {
    const scan = vi.spyOn(prisma.inhouseLobby, "findMany");
    try {
      const [summary, board, ladder] = await Promise.all([
        loadInhouseLadderSummary(),
        loadBoardStats(),
        loadInhouseLadder(),
      ]);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(board.lobbiesPlayed).toBe(summary.completedCount);
      expect(ladder).toBe(summary.ladder);
    } finally {
      scan.mockRestore();
    }
  });

  it("invalidates both the page ladder and board immediately on result and void cursors", async () => {
    const one = await makeUser("Cursor One");
    const two = await makeUser("Cursor Two");
    const now = Date.now();
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, "before-result");
    const empty = await loadInhouseLadderSummary(now);
    await loadBoardStats(now);
    expect(empty.completedCount).toBe(0);

    const completed = await seedLobby([one.id, two.id], 1, new Date(now - 60_000));
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, "after-result");
    const result = await loadInhouseLadderSummary(now + 1_000);
    expect(result.completedCount).toBe(1);
    expect(result.records).toHaveLength(2);
    await expect(loadBoardStats(now + 1_000)).resolves.toMatchObject({ lobbiesPlayed: 1 });

    await prisma.inhouseLobby.update({
      where: { id: completed.id },
      data: { status: INHOUSE_STATUS.CANCELLED },
    });
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, "after-void");
    const voided = await loadInhouseLadderSummary(now + 2_000);
    expect(voided.completedCount).toBe(0);
    expect(voided.records).toHaveLength(0);
    await expect(loadBoardStats(now + 2_000)).resolves.toMatchObject({ lobbiesPlayed: 0 });
  });
});

describe("loadInhouseMonthLadder — this month's board", () => {
  const ZONE = "America/Los_Angeles";
  // Sept 20 2026, noon UTC: the Pacific month is Sept 1 07:00Z → Oct 1 07:00Z.
  const NOW = Date.parse("2026-09-20T12:00:00Z");

  async function seedMonthLobby(
    sides: [string, 1 | 2][],
    winnerTeam: 1 | 2,
    completedAt: Date | null,
    opts: {
      status?: string;
      createdAt?: Date;
      eloDeltas?: Record<string, number>;
    } = {},
  ) {
    return prisma.inhouseLobby.create({
      data: {
        status: opts.status ?? INHOUSE_STATUS.COMPLETED,
        winnerTeam,
        completedAt,
        createdAt: opts.createdAt ?? completedAt ?? new Date(NOW),
        eloDeltas: JSON.stringify(
          opts.eloDeltas ??
            Object.fromEntries(
              sides.map(([id, team]) => [id, team === winnerTeam ? 16 : -16]),
            ),
        ),
        players: {
          create: sides.map(([userId, team]) => ({ userId, team, mmr: 3000 })),
        },
      },
    });
  }

  beforeEach(() => {
    resetInhouseLadderCache();
  });

  it("counts only results that completed this month on the league clock", async () => {
    const a = await makeUser("Month A");
    const b = await makeUser("Month B");
    const c = await makeUser("Month C");
    // Formed in August, finished on the first instant of September: counts,
    // because the month is keyed on completedAt, never createdAt.
    await seedMonthLobby([[a.id, 1], [b.id, 2]], 1, new Date("2026-09-01T07:00:00Z"), {
      createdAt: new Date("2026-08-31T23:00:00Z"),
      eloDeltas: { [a.id]: 16, [b.id]: -16 },
    });
    await seedMonthLobby([[a.id, 1], [b.id, 2]], 2, new Date("2026-09-10T03:00:00Z"), {
      eloDeltas: { [a.id]: -15, [b.id]: 15 },
    });
    await seedMonthLobby([[a.id, 1], [c.id, 2]], 1, new Date("2026-09-15T03:00:00Z"), {
      eloDeltas: { [a.id]: 14, [c.id]: -14 },
    });
    // September in UTC but still August 31st in Los Angeles.
    await seedMonthLobby([[a.id, 1], [b.id, 2]], 1, new Date("2026-09-01T03:00:00Z"));
    // Voided, pre-completedAt history, and the first instant of October.
    await seedMonthLobby([[a.id, 1], [b.id, 2]], 1, new Date("2026-09-12T03:00:00Z"), {
      status: INHOUSE_STATUS.CANCELLED,
    });
    await seedMonthLobby([[a.id, 1], [b.id, 2]], 1, null, {
      createdAt: new Date("2026-09-12T03:00:00Z"),
    });
    await seedMonthLobby([[a.id, 1], [b.id, 2]], 1, new Date("2026-10-01T07:00:00Z"));

    const scan = vi.spyOn(prisma.inhouseLobby, "findMany");
    try {
      // Two concurrent cold reads share one windowed query, and neither is
      // the career ladder's full-history scan.
      const [month, again] = await Promise.all([
        loadInhouseMonthLadder(NOW, ZONE),
        loadInhouseMonthLadder(NOW, ZONE),
      ]);
      expect(again).toBe(month);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(scan.mock.calls[0][0]?.where).toMatchObject({
        status: INHOUSE_STATUS.COMPLETED,
        completedAt: {
          gte: new Date("2026-09-01T07:00:00Z"),
          lt: new Date("2026-10-01T07:00:00Z"),
        },
      });

      expect(month.label).toBe("September 2026");
      expect(month.games).toBe(3);
      expect(MONTH_MIN_GAMES).toBe(3);
      expect(month.ranked.map((r) => r.userId)).toEqual([a.id]);
      expect(month.ranked[0]).toMatchObject({
        games: 3,
        wins: 2,
        losses: 1,
        eloNet: 15,
      });
      expect(month.unranked).toEqual([
        expect.objectContaining({ userId: b.id, games: 2, wins: 1, eloNet: -1 }),
        expect.objectContaining({ userId: c.id, games: 1, wins: 0, eloNet: -14 }),
      ]);
    } finally {
      scan.mockRestore();
    }
  });

  it("serves the memo until the cursor moves, and rolls over on the 1st", async () => {
    const a = await makeUser("Memo A");
    const b = await makeUser("Memo B");
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, "one");
    await seedMonthLobby([[a.id, 1], [b.id, 2]], 1, new Date("2026-09-05T03:00:00Z"));
    expect((await loadInhouseMonthLadder(NOW, ZONE)).games).toBe(1);

    // A result lands without its cursor stamp: the memo still answers…
    await seedMonthLobby([[a.id, 1], [b.id, 2]], 2, new Date("2026-09-06T03:00:00Z"));
    expect((await loadInhouseMonthLadder(NOW + 30_000, ZONE)).games).toBe(1);
    // …until the result cursor moves, which invalidates at once.
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, "two");
    expect((await loadInhouseMonthLadder(NOW + 31_000, ZONE)).games).toBe(2);

    // Ten seconds before local midnight on Oct 1, then twenty after: well
    // inside the TTL, but a new month is a new board.
    const lastOfMonth = Date.parse("2026-10-01T06:59:50Z");
    expect((await loadInhouseMonthLadder(lastOfMonth, ZONE)).games).toBe(2);
    const october = await loadInhouseMonthLadder(lastOfMonth + 20_000, ZONE);
    expect(october.label).toBe("October 2026");
    expect(october.games).toBe(0);
    expect(october.ranked).toEqual([]);
    expect(october.unranked).toEqual([]);

    // The shared reset seam drops the month memo too.
    await seedMonthLobby([[a.id, 1], [b.id, 2]], 1, new Date("2026-10-02T03:00:00Z"));
    expect((await loadInhouseMonthLadder(lastOfMonth + 25_000, ZONE)).games).toBe(0);
    resetInhouseLadderCache();
    expect((await loadInhouseMonthLadder(lastOfMonth + 26_000, ZONE)).games).toBe(1);
  });
});
