import { describe, expect, it } from "vitest";
import {
  validateMigrationHistory,
  type MigrationHistoryRow,
} from "../../scripts/migration-history.mjs";
import { MIGRATION_SHA256 } from "../../scripts/migration-safety.mjs";

function validHistory(): MigrationHistoryRow[] {
  return Object.entries(MIGRATION_SHA256).map(([name, checksum]) => ({
    name,
    checksum,
    finished: true,
    rolledBack: false,
  }));
}

describe("migration-history validation", () => {
  it("accepts exactly the reviewed completed migration names and checksums", () => {
    expect(validateMigrationHistory(validHistory())).toEqual({
      migrationCount: Object.keys(MIGRATION_SHA256).length,
    });
  });

  it("rejects missing, extra, unfinished, and checksum-drifted history", () => {
    const missing = validHistory();
    missing.pop();
    expect(() => validateMigrationHistory(missing)).toThrow(
      /completed migration inventory drift/i,
    );

    const extra = validHistory();
    extra.push({
      name: "20990101000000_unknown",
      checksum: "unknown",
      finished: true,
      rolledBack: false,
    });
    expect(() => validateMigrationHistory(extra)).toThrow(
      /completed migration inventory drift/i,
    );

    const unfinished = validHistory();
    unfinished.push({
      name: "20990101000000_pending",
      checksum: "pending",
      finished: false,
      rolledBack: false,
    });
    expect(() => validateMigrationHistory(unfinished)).toThrow(
      /unfinished migration history/i,
    );

    const changed = validHistory();
    changed[0].checksum = "changed";
    expect(() => validateMigrationHistory(changed)).toThrow(
      /migration checksum drift/i,
    );
  });

  it("allows resolved failed attempts alongside exact completed history", () => {
    const rows = validHistory();
    rows.push({
      name: rows[0].name,
      checksum: rows[0].checksum,
      finished: false,
      rolledBack: true,
    });

    expect(validateMigrationHistory(rows).migrationCount).toBe(
      Object.keys(MIGRATION_SHA256).length,
    );
  });
});
