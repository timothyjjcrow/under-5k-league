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

/**
 * An inhouse preference ORDER ("2,3,1": Mid first, then Offlane, then Carry):
 * the valid keys in the order given, first occurrence kept, junk dropped.
 * League signup roles are an unordered set (parseRoles sorts them); the
 * inhouse choice is the order a player wants to play them in.
 */
export function parseRoleOrder(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const key = raw.trim();
    if (VALID.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/** The stored form of a preference order (parseRoleOrder's inverse). */
export function serializeRoleOrder(keys: readonly string[]): string {
  return parseRoleOrder(keys.join(",")).join(",");
}

/**
 * Strictly read a role choice sent by a client: an array of distinct position
 * keys ("1".."5"), at most five, most wanted first. Returns the stored string,
 * order kept ("" for an empty choice), or null for anything else — junk is
 * refused, never quietly dropped, so a player is never told their choice
 * saved when part of it didn't.
 */
export function parseRoleKeys(input: unknown): string | null {
  if (!Array.isArray(input) || input.length > DOTA_ROLES.length) return null;
  if (!input.every((k) => typeof k === "string" && VALID.has(k))) return null;
  if (new Set(input).size !== input.length) return null;
  return (input as string[]).join(",");
}

export type InhouseRolesSource = "inhouse" | "signup" | "none";

/**
 * The positions an inhouse player plays: their own inhouse choice when they
 * have made one (even "none"), in their order of preference; else their
 * latest league signup's roles (an unordered set); else nothing. Unlike MMR
 * (where the league-approved signup wins), both are the player's own word and
 * the inhouse one is newer and specific to inhouses. Only the inhouse choice
 * is ranked: `source` says which it is.
 */
export function effectiveInhouseRoles(
  own: string | null | undefined,
  signup: string | null | undefined,
): { roles: string; source: InhouseRolesSource } {
  if (own != null)
    return {
      roles: serializeRoleOrder(parseRoleOrder(own)),
      source: "inhouse",
    };
  const fromSignup = serializeRoles(parseRoles(signup));
  return fromSignup
    ? { roles: fromSignup, source: "signup" }
    : { roles: "", source: "none" };
}

/**
 * One spoken name for a roles string, e.g. "Plays Pos 1 Carry, Pos 3
 * Offlane", or, for a ranked inhouse choice, "Plays Pos 2 Mid first, then
 * Pos 3 Offlane"; null when none are set. RoleBadges' accessible name, and the
 * description a row's own control carries when its label can't hold it.
 */
export function rolesAccessibleName(
  value: string | null | undefined,
  { ranked = false }: { ranked?: boolean } = {},
): string | null {
  const keys = ranked ? parseRoleOrder(value) : parseRoles(value);
  const names = keys.map((k) => {
    const role = DOTA_ROLES.find((r) => r.key === k)!;
    return `${role.short} ${role.label}`;
  });
  if (names.length === 0) return null;
  if (!ranked || names.length === 1) return `Plays ${names.join(", ")}`;
  return `Plays ${names[0]} first, then ${names.slice(1).join(", then ")}`;
}

/**
 * The words for a preference order, e.g. "Mid first, then Offlane, then
 * Carry" ("Any position, Mid first" when all five), for the picker's echo
 * line. Empty when none.
 */
export function rolePreferenceLine(value: string | null | undefined): string {
  const keys = parseRoleOrder(value);
  const labels = keys.map((k) => DOTA_ROLES.find((r) => r.key === k)!.label);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  const order = `${labels[0]} first, then ${labels.slice(1).join(", then ")}`;
  return labels.length === DOTA_ROLES.length ? `Any position: ${order}` : order;
}
