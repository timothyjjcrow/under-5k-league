import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revision: "before-archive",
  findFirst: vi.fn(),
  entries: new Map<string, unknown>(),
}));
vi.mock("./prisma", () => ({ prisma: { season: { findFirst: mocks.findFirst } } }));
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
