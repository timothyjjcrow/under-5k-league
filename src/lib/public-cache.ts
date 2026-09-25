import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getPublicReadSignals } from "./public-read-signals";
import { createSingleFlight } from "./single-flight";
import { publicGameCacheEntry, type PublicCacheEntry } from "./public-game-cache-policy";
import { databaseDiagnostics } from "./db-observability";

/** Public, JSON-safe data only. Scope and the database's UUID revision identify
 * both persistent entries and pending process-local work. */
export function createPublicSnapshot<T>(key: string, fetchRows: (seasonId: string | null) => Promise<T>) {
  const readOnce = createSingleFlight<T>((shared) => databaseDiagnostics.refresh(shared));
  const readRows = (seasonId: string | null, revision: string) =>
    readOnce(JSON.stringify([seasonId, revision]), () => fetchRows(seasonId));
  const cachedSnapshot = unstable_cache(
    async (seasonId: string | null, revision: string): Promise<PublicCacheEntry<T>> => {
      const { entry, serializedBytes } = publicGameCacheEntry(await readRows(seasonId, revision));
      databaseDiagnostics.snapshotSize(serializedBytes);
      // A small marker makes capacity explicit without truncating history or
      // relying on Next's different dev/prod handling of oversized entries.
      return entry;
    },
    [key],
    { revalidate: 60, tags: ["games"] },
  );
  return cache(async (seasonId: string | null): Promise<T> => {
    const { publicGameRevision } = await getPublicReadSignals();
    const entry = await cachedSnapshot(seasonId, publicGameRevision);
    if (entry.kind === "data") return entry.value;
    // Initial oversize detection may read twice. Later requests read all data
    // once, sharing concurrent work without retaining a second result cache.
    return readRows(seasonId, publicGameRevision);
  });
}
