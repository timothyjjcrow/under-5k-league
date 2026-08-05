import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SQLITE_TEST_DATABASE_PATHS,
  assertSqliteTestDatabaseUrl,
  prepareSqliteTestDatabase,
  sqliteTestDatabaseUrl,
} from "../../scripts/prepare-sqlite-test-db.mjs";

const helperPath = SQLITE_TEST_DATABASE_PATHS.helperTest;

afterEach(() => {
  if (existsSync(helperPath)) unlinkSync(helperPath);
});

describe("fresh SQLite test database preparation", () => {
  it("accepts only the exact, dedicated database selected by the caller", () => {
    expect(
      assertSqliteTestDatabaseUrl(
        "integration",
        sqliteTestDatabaseUrl("integration"),
      ),
    ).toBe(SQLITE_TEST_DATABASE_PATHS.integration);

    expect(() =>
      assertSqliteTestDatabaseUrl(
        "integration",
        pathToFileURL(`${SQLITE_TEST_DATABASE_PATHS.integration}.copy`).href,
      ),
    ).toThrow(/Refusing test database setup/);
    expect(() =>
      assertSqliteTestDatabaseUrl(
        "integration",
        "postgresql://league.example/production",
      ),
    ).toThrow(/file: URL/);
    expect(() =>
      assertSqliteTestDatabaseUrl(
        "integration",
        `${sqliteTestDatabaseUrl("integration")}?fixture=true`,
      ),
    ).toThrow(/unmodified/);
  });

  it("creates a missing file without replacing existing contents", () => {
    const url = sqliteTestDatabaseUrl("helperTest");
    prepareSqliteTestDatabase("helperTest", url);
    expect(existsSync(helperPath)).toBe(true);
    expect(readFileSync(helperPath)).toHaveLength(0);

    writeFileSync(helperPath, "existing fixture", { mode: 0o600 });
    prepareSqliteTestDatabase("helperTest", url);
    expect(readFileSync(helperPath, "utf8")).toBe("existing fixture");
  });
});
