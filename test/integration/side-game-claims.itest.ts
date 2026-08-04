import type { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadSqliteFallback() {
  vi.stubEnv("DATABASE_URL", "file:./mutation-fallback-contract.db");
  vi.resetModules();
  return import("@/lib/side-game-claims");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("side-game claims — SQLite fallback query contracts", () => {
  it("re-asserts active season, phase, and fantasy lock state", async () => {
    const { claimSideGameSeason } = await loadSqliteFallback();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      season: { updateMany },
    } as unknown as Prisma.TransactionClient;

    await expect(
      claimSideGameSeason(
        tx,
        { id: "season-1", status: "REGULAR_SEASON" },
        { fantasyUnlocked: true },
      ),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "season-1",
        isActive: true,
        status: "REGULAR_SEASON",
        fantasyLockedAt: null,
      },
      data: { status: "REGULAR_SEASON" },
    });
  });

  it("re-asserts the auction phase on the no-op Draft claim", async () => {
    const { claimSideGameDraft } = await loadSqliteFallback();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      draft: { updateMany },
    } as unknown as Prisma.TransactionClient;

    await expect(
      claimSideGameDraft(tx, { id: "draft-1", status: "COMPLETE" }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "draft-1", status: "COMPLETE" },
      data: { status: "COMPLETE" },
    });
  });

  it("pins the exact kickoff alongside the open-prediction predicate", async () => {
    const { claimOpenPredictionMatch } = await loadSqliteFallback();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      match: { updateMany },
    } as unknown as Prisma.TransactionClient;
    const scheduledAt = new Date("2026-08-10T03:00:00.000Z");
    const now = new Date("2026-08-10T02:00:00.000Z");

    await expect(
      claimOpenPredictionMatch(
        tx,
        { id: "match-1", seasonId: "season-1", scheduledAt },
        now,
      ),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "match-1",
        seasonId: "season-1",
        scheduledAt,
        status: { notIn: ["COMPLETED", "LIVE"] },
        OR: [{ scheduledAt: null }, { scheduledAt: { gt: now } }],
      },
      data: { scheduledAt },
    });
  });
});
