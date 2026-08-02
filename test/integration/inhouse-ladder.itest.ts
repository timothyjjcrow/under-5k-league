import { describe, it, expect, beforeEach } from "vitest";

import { prisma } from "@/lib/prisma";
import { INHOUSE_STATUS } from "@/lib/constants";
import {
  loadInhouseLadder,
  resetInhouseLadderCache,
} from "@/lib/inhouse-ladder";
import {
  PROVISIONAL_GAMES,
  rankInhouse,
  summarizeInhouse,
  toFinishedLobby,
} from "@/lib/inhouse-stats";
import { makeUser } from "./factories";

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
});
