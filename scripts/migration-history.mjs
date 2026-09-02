import { MIGRATION_SHA256 } from "./migration-safety.mjs";

/**
 * Validate Prisma's migration ledger. The full production build attestation
 * composes this check with Prisma schema comparison and native-catalog checks
 * in migration-postflight.mjs.
 */
export function validateMigrationHistory(migrations) {
  const unresolved = migrations.filter(
    (row) => !row.finished && !row.rolledBack,
  );
  if (unresolved.length > 0) {
    throw new Error(
      `Unfinished migration history attempts: ${unresolved
        .map((row) => row.name)
        .join(", ")}`,
    );
  }

  const completed = migrations.filter((row) => row.finished && !row.rolledBack);
  const completedNames = completed.map((row) => row.name).sort();
  const expectedNames = Object.keys(MIGRATION_SHA256).sort();
  if (JSON.stringify(completedNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Completed migration inventory drift (expected ${expectedNames.join(", ")}; received ${completedNames.join(", ") || "none"})`,
    );
  }

  for (const row of completed) {
    if (row.checksum !== MIGRATION_SHA256[row.name]) {
      throw new Error(`Migration checksum drift: ${row.name}`);
    }
  }

  return { migrationCount: completed.length };
}
