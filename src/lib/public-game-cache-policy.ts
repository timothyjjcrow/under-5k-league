// Next's fetch-cache envelope is limited to 2 MiB. Leave room for framework
// metadata; measure the nested JSON string too, since players already is JSON.
export const PUBLIC_GAME_CACHE_MAX_BYTES = 1_900_000;

export type PublicCacheEntry<T> =
  | { kind: "data"; value: T }
  | { kind: "oversize"; serializedBytes: number };

export function publicGameCacheEntry<T>(value: T, limit = PUBLIC_GAME_CACHE_MAX_BYTES) {
  const entry = { kind: "data" as const, value };
  const serializedBytes = Buffer.byteLength(JSON.stringify({
    kind: "FETCH",
    data: { headers: {}, body: JSON.stringify(entry), status: 200, url: "" },
    revalidate: 60,
  }), "utf8");
  return {
    serializedBytes,
    entry: serializedBytes <= limit
      ? entry
      : { kind: "oversize" as const, serializedBytes },
  };
}
