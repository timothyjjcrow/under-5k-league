import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revision: "before-archive",
  findFirst: vi.fn(),
  matchFindFirst: vi.fn(),
  entries: new Map<string, unknown>(),
}));
vi.mock("./prisma", () => ({ prisma: {
  season: { findFirst: mocks.findFirst },
  match: { findFirst: mocks.matchFindFirst },
} }));
vi.mock("./public-read-signals", () => ({
  getPublicReadSignals: async () => ({ publicGameRevision: mocks.revision }),
}));
vi.mock("./db-observability", () => ({ databaseDiagnostics: {
  refresh: vi.fn(), snapshotSize: vi.fn(),
} }));
vi.mock("next/cache", () => ({
  unstable_cache: (load: (...args: unknown[]) => Promise<unknown>, keys: string[]) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify([keys, args]);
      if (!mocks.entries.has(key)) mocks.entries.set(key, await load(...args));
      return mocks.entries.get(key);
    },
}));

it("caches only public history existence and follows false → true → false revisions", async () => {
  mocks.findFirst.mockResolvedValue(null);
  const { getPublicHasHistory } = await import("./public-navigation");
  expect(await getPublicHasHistory(null)).toBe(false);
  expect(await getPublicHasHistory(null)).toBe(false);
  expect(mocks.findFirst).toHaveBeenCalledTimes(1);
  expect(mocks.findFirst).toHaveBeenCalledWith({
    where: { isActive: false }, select: { id: true },
  });

  mocks.findFirst.mockResolvedValue({ id: "archived-season" });
  mocks.revision = "after-archive";
  expect(await getPublicHasHistory(null)).toBe(true);
  expect(await getPublicHasHistory(null)).toBe(true);
  expect(mocks.findFirst).toHaveBeenCalledTimes(2);

  mocks.findFirst.mockResolvedValue(null);
  mocks.revision = "after-reactivation-or-delete";
  expect(await getPublicHasHistory(null)).toBe(false);
  expect(await getPublicHasHistory(null)).toBe(false);
  expect(mocks.findFirst).toHaveBeenCalledTimes(3);
});

it("reads one LIVE match per season and revision for the header's chip", async () => {
  const { getPublicHasLiveMatch } = await import("./public-navigation");
  mocks.revision = "before-game-one";
  mocks.matchFindFirst.mockResolvedValue(null);
  expect(await getPublicHasLiveMatch("season-1")).toBe(false);
  expect(await getPublicHasLiveMatch("season-1")).toBe(false);
  expect(mocks.matchFindFirst).toHaveBeenCalledTimes(1);
  expect(mocks.matchFindFirst).toHaveBeenCalledWith({
    where: { seasonId: "season-1", status: "LIVE" }, select: { id: true },
  });

  // Game one imports: the revision moves in the same transaction.
  mocks.matchFindFirst.mockResolvedValue({ id: "match-1" });
  mocks.revision = "after-game-one";
  expect(await getPublicHasLiveMatch("season-1")).toBe(true);
  expect(mocks.matchFindFirst).toHaveBeenCalledTimes(2);

  // No active season, no query.
  expect(await getPublicHasLiveMatch(null)).toBe(false);
  expect(mocks.matchFindFirst).toHaveBeenCalledTimes(2);
});
