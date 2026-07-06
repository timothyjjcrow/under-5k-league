// Dota 2 position/role helpers. Roles are stored as a comma-separated string of
// position keys ("1".."5"). Pure so they're testable and usable client + server.

export const DOTA_ROLES = [
  { key: "1", label: "Carry", short: "Pos 1" },
  { key: "2", label: "Mid", short: "Pos 2" },
  { key: "3", label: "Offlane", short: "Pos 3" },
  { key: "4", label: "Soft Support", short: "Pos 4" },
  { key: "5", label: "Hard Support", short: "Pos 5" },
] as const;

const VALID = new Set<string>(DOTA_ROLES.map((r) => r.key));

/** Parse a stored role string into ordered, valid position keys. */
export function parseRoles(value: string | null | undefined): string[] {
  if (!value) return [];
  const chosen = new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => VALID.has(s)),
  );
  return DOTA_ROLES.filter((r) => chosen.has(r.key)).map((r) => r.key);
}

/** Serialize selected keys into the canonical stored string (ordered, deduped). */
export function serializeRoles(keys: string[]): string {
  const chosen = new Set(keys.filter((k) => VALID.has(k)));
  return DOTA_ROLES.filter((r) => chosen.has(r.key))
    .map((r) => r.key)
    .join(",");
}

/** Human labels for a stored role string, e.g. "1,3" -> ["Carry", "Offlane"]. */
export function roleLabels(value: string | null | undefined): string[] {
  const keys = new Set(parseRoles(value));
  return DOTA_ROLES.filter((r) => keys.has(r.key)).map((r) => r.label);
}

/** Short labels, e.g. ["Pos 1", "Pos 3"]. */
export function roleShort(value: string | null | undefined): string[] {
  const keys = new Set(parseRoles(value));
  return DOTA_ROLES.filter((r) => keys.has(r.key)).map((r) => r.short);
}
