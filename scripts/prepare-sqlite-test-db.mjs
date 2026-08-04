import { closeSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PRISMA_DIRECTORY = fileURLToPath(new URL("../prisma/", import.meta.url));

export const SQLITE_TEST_DATABASE_PATHS = Object.freeze({
  integration: path.join(PRISMA_DIRECTORY, "test.db"),
  signupE2e: path.join(PRISMA_DIRECTORY, "e2e.db"),
  midseasonE2e: path.join(PRISMA_DIRECTORY, "e2e-fixture.db"),
  postseasonE2e: path.join(PRISMA_DIRECTORY, "postseason-e2e-fixture.db"),
  ciBuild: path.join(PRISMA_DIRECTORY, "ci.db"),
  helperTest: path.join(PRISMA_DIRECTORY, "prepare-sqlite-helper-test.db"),
});

export function sqliteTestDatabaseUrl(database) {
  const databasePath = SQLITE_TEST_DATABASE_PATHS[database];
  if (!databasePath) {
    throw new Error(`Unknown SQLite test database key: ${database || "(unset)"}.`);
  }
  return pathToFileURL(databasePath).href;
}

export function assertSqliteTestDatabaseUrl(database, rawUrl) {
  const expectedPath = SQLITE_TEST_DATABASE_PATHS[database];
  if (!expectedPath) {
    throw new Error(`Unknown SQLite test database key: ${database || "(unset)"}.`);
  }

  let parsed;
  try {
    parsed = new URL(rawUrl ?? "");
  } catch {
    throw new Error("DATABASE_URL must be an absolute file: URL for a dedicated test database.");
  }
  if (parsed.protocol !== "file:" || parsed.search || parsed.hash) {
    throw new Error("DATABASE_URL must be an unmodified file: URL for a dedicated test database.");
  }

  let actualPath;
  try {
    actualPath = fileURLToPath(parsed);
  } catch {
    throw new Error("DATABASE_URL must be a valid local file: URL for a dedicated test database.");
  }
  if (actualPath !== expectedPath) {
    throw new Error(`Refusing test database setup: expected the dedicated ${database} SQLite file.`);
  }
  return actualPath;
}

/**
 * Prisma 5's darwin-arm64 schema engine can fail before `db push` when the
 * target SQLite file does not exist. Creating the empty, exact test-owned file
 * first avoids that engine bootstrap defect; Prisma still creates the schema.
 * Opening with `a` deliberately preserves an existing fixture for the reset
 * command that follows.
 */
export function prepareSqliteTestDatabase(database, rawUrl) {
  const databasePath = assertSqliteTestDatabaseUrl(database, rawUrl);
  closeSync(openSync(databasePath, "a", 0o600));
  return databasePath;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  try {
    prepareSqliteTestDatabase(process.argv[2], process.env.DATABASE_URL);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "SQLite test database setup failed.");
    process.exitCode = 1;
  }
}
