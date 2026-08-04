export const BASELINE_MIGRATION: "20260804000000_baseline";
export const MIGRATION_SHA256: Readonly<Record<string, string>>;
export const BASELINE_SCHEMA_SHA256: string;

export function splitSqlStatements(sql: string): string[];
export function validateMigrationSql(
  name: string,
  sql: string,
  options?: { baseline?: boolean },
): string[];
export function validateMigrations(migrationsDir?: URL | string): string[];
