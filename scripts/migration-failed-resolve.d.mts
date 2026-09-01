export interface FailedMigrationLedgerRow {
  id: string;
  name: string;
  checksum: string;
  finished: boolean;
  rolledBack: boolean;
  appliedSteps: number;
}

export interface FailedMigrationCatalogSnapshot {
  queueTableExists: boolean;
  idleExpiresAtCount: number;
  refreshFunctionCount: number;
  insertTriggerCount: number;
  deleteTriggerCount: number;
  canOwnQueueTable: boolean;
  canCreateInSchema: boolean;
  canTriggerQueueTable: boolean;
}

export interface FailedMigrationSnapshot {
  migrations: FailedMigrationLedgerRow[];
  catalog: FailedMigrationCatalogSnapshot;
}

export const FAILED_MIGRATION_TARGET: string;
export const PINNED_PRISMA_VERSION: string;

export function authorizeFailedMigrationResolve(options: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  headSha: string;
  status: string;
}): { approvedSha: string; migrationName: string };

export function directMigrationUrl(env: NodeJS.ProcessEnv): string;

export function assertPinnedPrismaVersion(version: string): void;

export function validateFailedMigrationSnapshot(
  snapshot: FailedMigrationSnapshot,
): string;

export function validateResolvedMigrationSnapshot(
  before: FailedMigrationSnapshot,
  after: FailedMigrationSnapshot,
  failedId: string,
): void;

export function runFailedMigrationResolve(options?: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  headSha?: string;
  status?: string;
  fileExists?: (path: string) => boolean;
  migrationValidator?: () => unknown;
  prismaVersion?: string;
  inspect?: () => Promise<FailedMigrationSnapshot>;
  resolve?: () => Promise<void> | void;
}): Promise<{ approvedSha: string; migrationName: string }>;
