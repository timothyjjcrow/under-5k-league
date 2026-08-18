import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  source: undefined as undefined | (() => Promise<unknown>),
  stored: undefined as undefined | Promise<unknown>,
  registration: undefined as
    | undefined
    | {
        keyParts: string[];
        options: { tags: string[]; revalidate: number | false };
      },
  cached: vi.fn<() => Promise<unknown>>(),
  unstableCache: vi.fn(),
  revalidateTag: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => ({
  season: { findMany: vi.fn() },
  match: { findFirst: vi.fn() },
  inhouseLobby: { findFirst: vi.fn() },
  inhouseQueueEntry: { findFirst: vi.fn() },
  inhouseAnnouncement: { findFirst: vi.fn() },
  leagueAnnouncement: { findFirst: vi.fn() },
  setting: { findUnique: vi.fn() },
}));

vi.mock("next/cache", () => ({
  unstable_cache: cacheMocks.unstableCache.mockImplementation(
    (
      source: () => Promise<unknown>,
      keyParts: string[],
      options: { tags: string[]; revalidate: number | false },
    ) => {
      cacheMocks.source = source;
      cacheMocks.registration = { keyParts, options };
      return cacheMocks.cached;
    },
  ),
  revalidateTag: cacheMocks.revalidateTag.mockImplementation(() => {
    cacheMocks.stored = undefined;
  }),
}));

vi.mock("./prisma", () => ({ prisma: prismaMocks }));

import { AUTOMATION_GATE_TAG } from "./automation-gate-constants";
import { invalidateAutomationGateBestEffort } from "./automation-gate-invalidation";
import { SEASON_STATUS } from "./constants";
import {
  getResultSyncSnapshot,
  loadResultSyncSnapshot,
  RESULT_SYNC_STATUS_CACHE_KEY,
} from "./result-sync-status";

const NOW = Date.parse("2026-08-17T20:00:00.000Z");

function mockQuietLeague() {
  prismaMocks.season.findMany.mockResolvedValue([
    {
      id: "season-1",
      status: SEASON_STATUS.REGULAR_SEASON,
      draft: null,
    },
  ]);
  prismaMocks.match.findFirst.mockResolvedValue(null);
  prismaMocks.inhouseLobby.findFirst.mockResolvedValue(null);
  prismaMocks.inhouseQueueEntry.findFirst.mockResolvedValue(null);
  prismaMocks.inhouseAnnouncement.findFirst.mockResolvedValue(null);
  prismaMocks.leagueAnnouncement.findFirst.mockResolvedValue(null);
  prismaMocks.setting.findUnique.mockResolvedValue({
    value: "2026-08-17T19:00:00.000Z",
  });
}

function totalPrismaReads(): number {
  return Object.values(prismaMocks).reduce(
    (sum, model) =>
      sum +
      Object.values(model).reduce(
        (modelSum, read) => modelSum + read.mock.calls.length,
        0,
      ),
    0,
  );
}

describe("result sync status cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheMocks.stored = undefined;
    mockQuietLeague();
    cacheMocks.cached.mockImplementation(
      () => (cacheMocks.stored ??= cacheMocks.source!()),
    );
  });

  it("uses one stable key and the automation invalidation signal without a TTL", () => {
    expect(cacheMocks.registration).toEqual({
      keyParts: [RESULT_SYNC_STATUS_CACHE_KEY],
      options: {
        tags: [AUTOMATION_GATE_TAG],
        revalidate: false,
      },
    });
  });

  it("loads the complete read-only snapshot on a cache miss", async () => {
    await expect(loadResultSyncSnapshot(NOW)).resolves.toEqual({
      watch: false,
      cursor: "2026-08-17T19:00:00.000Z",
    });

    expect(prismaMocks.season.findMany).toHaveBeenCalledOnce();
    expect(prismaMocks.match.findFirst).toHaveBeenCalledOnce();
    expect(prismaMocks.inhouseLobby.findFirst).toHaveBeenCalledOnce();
    expect(prismaMocks.inhouseQueueEntry.findFirst).toHaveBeenCalledOnce();
    expect(prismaMocks.inhouseAnnouncement.findFirst).toHaveBeenCalledOnce();
    expect(prismaMocks.leagueAnnouncement.findFirst).toHaveBeenCalledOnce();
    expect(prismaMocks.setting.findUnique).toHaveBeenCalledOnce();
  });

  it("serves repeated idle heartbeats without another Prisma read", async () => {
    await expect(getResultSyncSnapshot()).resolves.toEqual({
      watch: false,
      cursor: "2026-08-17T19:00:00.000Z",
    });
    const readsAfterFill = totalPrismaReads();

    await expect(getResultSyncSnapshot()).resolves.toEqual({
      watch: false,
      cursor: "2026-08-17T19:00:00.000Z",
    });
    const readsAfterHit = totalPrismaReads();

    expect(readsAfterFill).toBe(7);
    expect(readsAfterHit).toBe(readsAfterFill);
    expect(cacheMocks.cached).toHaveBeenCalledTimes(2);
    expect(cacheMocks.cached).toHaveBeenCalledWith();
  });

  it("reveals fresh state after the shared mutation signal, then caches it again", async () => {
    await expect(getResultSyncSnapshot()).resolves.toEqual({
      watch: false,
      cursor: "2026-08-17T19:00:00.000Z",
    });
    expect(totalPrismaReads()).toBe(7);

    prismaMocks.inhouseLobby.findFirst.mockResolvedValue({ id: "lobby-1" });
    prismaMocks.setting.findUnique.mockResolvedValue({
      value: "2026-08-17T20:05:00.000Z",
    });

    // Database changes do not make an idle reader query Neon by themselves.
    await expect(getResultSyncSnapshot()).resolves.toEqual({
      watch: false,
      cursor: "2026-08-17T19:00:00.000Z",
    });
    expect(totalPrismaReads()).toBe(7);

    invalidateAutomationGateBestEffort();
    expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(AUTOMATION_GATE_TAG, {
      expire: 0,
    });

    await expect(getResultSyncSnapshot()).resolves.toEqual({
      watch: true,
      cursor: "2026-08-17T20:05:00.000Z",
    });
    expect(totalPrismaReads()).toBe(14);

    await expect(getResultSyncSnapshot()).resolves.toEqual({
      watch: true,
      cursor: "2026-08-17T20:05:00.000Z",
    });
    expect(totalPrismaReads()).toBe(14);
  });
});
