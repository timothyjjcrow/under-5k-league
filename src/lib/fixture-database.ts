import { fileURLToPath } from "node:url";

export const FIXTURE_DATABASE_PATHS = {
  midseason: fileURLToPath(
    new URL("../../prisma/e2e-fixture.db", import.meta.url),
  ),
  postseason: fileURLToPath(
    new URL("../../prisma/postseason-e2e-fixture.db", import.meta.url),
  ),
} as const;

export type FixtureDatabase = keyof typeof FIXTURE_DATABASE_PATHS;

function sqlitePath(databaseUrl: string): string | null {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "file:") return null;
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

/**
 * Fixture writers are destructive by design. Accept only the exact SQLite
 * files owned by the browser suites, never a database whose name merely
 * happens to contain "fixture".
 */
export function isExpectedFixtureDatabase(
  databaseUrl: string,
  allowed: readonly FixtureDatabase[],
): boolean {
  const actualPath = sqlitePath(databaseUrl);
  return (
    actualPath !== null &&
    allowed.some((fixture) => actualPath === FIXTURE_DATABASE_PATHS[fixture])
  );
}

export function assertExpectedFixtureDatabase(
  databaseUrl: string,
  allowed: readonly FixtureDatabase[],
  action: string,
): void {
  if (isExpectedFixtureDatabase(databaseUrl, allowed)) return;
  const expected = allowed
    .map((fixture) => FIXTURE_DATABASE_PATHS[fixture])
    .join(" or ");
  throw new Error(
    `Refusing to ${action}: DATABASE_URL (${databaseUrl || "unset"}) is not an expected SQLite fixture database. Expected ${expected}.`,
  );
}
