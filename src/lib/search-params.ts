/**
 * Normalize a query key that is only meaningful once. Next.js represents a
 * repeated key as `string[]`; `null` marks that malformed case so callers can
 * distinguish it from an omitted or blank value (`undefined`).
 */
export function singleSearchParam(
  value: string | string[] | undefined,
): string | undefined | null {
  if (Array.isArray(value)) return null;
  const normalized = value?.trim();
  return normalized || undefined;
}
