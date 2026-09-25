import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revision: "v1",
  findMany: vi.fn(),
  entries: new Map<string, unknown>(),
  refresh: vi.fn(),
  snapshotSize: vi.fn(),
}));
vi.mock("./prisma", () => ({ prisma: { game: { findMany: mocks.findMany } } }));
vi.mock("./public-read-signals", () => ({
  getPublicReadSignals: async () => ({ publicGameRevision: mocks.revision }),
}));
vi.mock("./db-observability", () => ({ databaseDiagnostics: {
  refresh: mocks.refresh, snapshotSize: mocks.snapshotSize,
} }));
// Model persistent keys and serialization, deliberately without coalescing:
// Next's cold callback branch also invokes every concurrent cache miss.
vi.mock("next/cache", () => ({
  unstable_cache: (load: (...args: unknown[]) => Promise<unknown>, keys: string[]) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify([keys, args]);
      if (mocks.entries.has(key)) return mocks.entries.get(key);
      const value = JSON.parse(JSON.stringify(await load(...args)));
      mocks.entries.set(key, value);
      return value;
    },
}));

const row = (id = "game-1", players = "[]") => ({
  id, matchId: "match-1", startTime: 123, fetchedAt: new Date(456),
  radiantWin: true, durationSecs: 1800, radiantScore: 20, direScore: 12, players,
  match: { seasonId: "season-1", week: 1, phase: "REGULAR",
    homeTeam: { name: "Home" }, awayTeam: { name: "Away" } },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  mocks.revision = "v1";
  mocks.entries.clear();
  mocks.findMany.mockReset();
  mocks.refresh.mockReset();
  mocks.snapshotSize.mockReset();
});

describe("public game snapshot refreshes", () => {
  it("coalesces twenty cold readers and gives cache hits identical scalar types", async () => {
    const load = deferred<ReturnType<typeof row>[]>();
    mocks.findMany.mockReturnValue(load.promise);
    const { getPublicGameSnapshot } = await import("./public-game-snapshot");
    const reads = Array.from({ length: 20 }, () => getPublicGameSnapshot(null));
    await vi.waitFor(() => expect(mocks.findMany).toHaveBeenCalledTimes(1));
    load.resolve([row()]);
    const results = await Promise.all(reads);
    expect(results.every((result) => result[0].fetchedAtMs === 456)).toBe(true);
    expect(mocks.refresh.mock.calls.filter(([shared]) => shared)).toHaveLength(19);
    expect(await getPublicGameSnapshot(null)).toEqual(results[0]);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });

  it("keeps season scopes in SQL and in the pending/cache key", async () => {
    mocks.findMany.mockImplementation(async (args) => [row(args.where?.match.seasonId ?? "all")]);
    const { getPublicGameSnapshot } = await import("./public-game-snapshot");
    const [all, seasonA, seasonB] = await Promise.all([
      getPublicGameSnapshot(null), getPublicGameSnapshot("a"), getPublicGameSnapshot("b"),
    ]);
    expect([all[0].id, seasonA[0].id, seasonB[0].id]).toEqual(["all", "a", "b"]);
    expect(mocks.findMany).toHaveBeenCalledTimes(3);
    expect(mocks.findMany.mock.calls[1][0].where).toEqual({ match: { seasonId: "a" } });
    expect(mocks.findMany.mock.calls[2][0].where).toEqual({ match: { seasonId: "b" } });
  });

  it("isolates old work across two loader instances sharing the persistent cache", async () => {
    const oldLoad = deferred<ReturnType<typeof row>[]>();
    mocks.findMany.mockReturnValueOnce(oldLoad.promise).mockResolvedValue([row("corrected")]);
    const oldInstance = await import("./public-game-snapshot");
    const oldRead = oldInstance.getPublicGameSnapshot(null);
    await vi.waitFor(() => expect(mocks.findMany).toHaveBeenCalledTimes(1));
    // A second process observes the mutation's UUID even when Date is unchanged.
    mocks.revision = "v2";
    vi.resetModules();
    const newInstance = await import("./public-game-snapshot");
    expect((await newInstance.getPublicGameSnapshot(null))[0].id).toBe("corrected");
    oldLoad.resolve([row("old")]);
    expect((await oldRead)[0].id).toBe("old");
    expect((await newInstance.getPublicGameSnapshot(null))[0].id).toBe("corrected");
    expect((await oldInstance.getPublicGameSnapshot(null))[0].id).toBe("corrected");
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
  });

  it("does not join a pending old revision in the same process", async () => {
    const oldLoad = deferred<ReturnType<typeof row>[]>();
    mocks.findMany.mockReturnValueOnce(oldLoad.promise).mockResolvedValue([row("new")]);
    const { getPublicGameSnapshot } = await import("./public-game-snapshot");
    const oldRead = getPublicGameSnapshot(null);
    await vi.waitFor(() => expect(mocks.findMany).toHaveBeenCalledTimes(1));
    mocks.revision = "v2";
    expect((await getPublicGameSnapshot(null))[0].id).toBe("new");
    oldLoad.resolve([row("old")]);
    await oldRead;
    expect((await getPublicGameSnapshot(null))[0].id).toBe("new");
  });

  it("drops a rejected pending load so the next reader can recover", async () => {
    mocks.findMany.mockRejectedValueOnce(new Error("temporary database failure"))
      .mockResolvedValue([row()]);
    const { getPublicGameSnapshot } = await import("./public-game-snapshot");
    await expect(getPublicGameSnapshot(null)).rejects.toThrow("temporary database failure");
    expect(await getPublicGameSnapshot(null)).toHaveLength(1);
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
  });

  it("returns every oversized row without placing its payload in the persistent cache", async () => {
    const rows = [row("large", "x".repeat(2_000_000)), row("last-row")];
    mocks.findMany.mockResolvedValue(rows);
    const { getPublicGameSnapshot } = await import("./public-game-snapshot");
    expect((await getPublicGameSnapshot(null)).map((game) => game.id)).toEqual(["large", "last-row"]);
    expect([...mocks.entries.values()]).toEqual([
      { kind: "oversize", serializedBytes: expect.any(Number) },
    ]);
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
    expect((await getPublicGameSnapshot(null)).at(-1)?.id).toBe("last-row");
    expect(mocks.findMany).toHaveBeenCalledTimes(3);
    expect(mocks.snapshotSize).toHaveBeenCalledWith(expect.any(Number));
  });
});
