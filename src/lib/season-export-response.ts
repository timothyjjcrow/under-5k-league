/**
 * Vercel Functions reject request or response bodies above 4.5 MB. Keep the
 * season archive below a decimal 4 MB body ceiling so platform framing and a
 * future small metadata addition cannot turn a successful application response
 * into an opaque host-level failure.
 */
export const SEASON_EXPORT_MAX_RESPONSE_BYTES = 4_000_000;

export type SerializedSeasonExport =
  | { ok: true; body: string; byteLength: number }
  | { ok: false; byteLength: number };

/** Serialize once, then enforce the hosted limit in UTF-8 bytes, not JS chars. */
export function serializeSeasonExport(
  payload: unknown,
  maxBytes = SEASON_EXPORT_MAX_RESPONSE_BYTES,
): SerializedSeasonExport {
  const body = JSON.stringify(payload, null, 2);
  const byteLength = Buffer.byteLength(body, "utf8");

  if (byteLength > maxBytes) return { ok: false, byteLength };
  return { ok: true, body, byteLength };
}
