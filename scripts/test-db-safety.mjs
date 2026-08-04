const TEST_DATABASE_NAMES = new Set(["ld2l_test", "ld2l_pgtest"]);
const RESTORE_DATABASE_NAME = "ld2l_restore_test";

/**
 * Test setup truncates every league table, so a merely PostgreSQL-shaped URL
 * is not enough. Require one of this repository's deliberately named scratch
 * databases before any Postgres integration or mutation run can start.
 */
export function assertPostgresTestUrl(raw) {
  if (!raw) {
    throw new Error("PG_TEST_URL must point to the disposable ld2l_test or ld2l_pgtest database.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PG_TEST_URL must be a valid PostgreSQL URL for a disposable test database.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("PG_TEST_URL must use the postgres or postgresql scheme.");
  }
  let database = "";
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("PG_TEST_URL contains an invalid encoded database name.");
  }
  if (!TEST_DATABASE_NAMES.has(database)) {
    throw new Error(
      "Refusing destructive tests: PG_TEST_URL database name must be exactly ld2l_test or ld2l_pgtest.",
    );
  }
  return parsed;
}

/** The convenience pg:up/pg:down commands are allowed to manage localhost only. */
export function assertLocalManagedPostgresUrl(raw) {
  const parsed = assertPostgresTestUrl(raw);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error(
      "Refusing database management: pg:up and pg:down only manage a localhost test database.",
    );
  }
  return parsed;
}

/** Backup rehearsals may recreate only one explicit localhost scratch DB. */
export function assertLocalRestorePostgresUrl(raw) {
  if (!raw) {
    throw new Error("PG_RESTORE_TEST_URL must point to local ld2l_restore_test.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PG_RESTORE_TEST_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("PG_RESTORE_TEST_URL must use postgres or postgresql.");
  }
  let database = "";
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("PG_RESTORE_TEST_URL contains an invalid database name.");
  }
  if (database !== RESTORE_DATABASE_NAME) {
    throw new Error("Refusing restore rehearsal: database must be exactly ld2l_restore_test.");
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Refusing restore rehearsal: target must be localhost.");
  }
  if (!parsed.username) {
    throw new Error("PG_RESTORE_TEST_URL must include a PostgreSQL user.");
  }
  return parsed;
}
