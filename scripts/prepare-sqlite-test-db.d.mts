export type SqliteTestDatabase =
  | "integration"
  | "signupE2e"
  | "midseasonE2e"
  | "postseasonE2e"
  | "ciBuild"
  | "helperTest";

export const SQLITE_TEST_DATABASE_PATHS: Readonly<
  Record<SqliteTestDatabase, string>
>;
export function sqliteTestDatabaseUrl(database: SqliteTestDatabase): string;
export function assertSqliteTestDatabaseUrl(
  database: SqliteTestDatabase,
  rawUrl: string | undefined,
): string;
export function prepareSqliteTestDatabase(
  database: SqliteTestDatabase,
  rawUrl: string | undefined,
): string;
