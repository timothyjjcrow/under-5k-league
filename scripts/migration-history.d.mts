export interface MigrationHistoryRow {
  name: string;
  checksum: string;
  finished: boolean;
  rolledBack: boolean;
}

export interface MigrationHistoryResult {
  migrationCount: number;
}

export function validateMigrationHistory(
  migrations: MigrationHistoryRow[],
): MigrationHistoryResult;
