export const BACKUP_RECEIPT_MAX_AGE_MS: number;
export function productionDeleteBackupRequired(env: NodeJS.ProcessEnv): boolean;
export function productionDeleteBackupError(
  receipt: string | null | undefined,
  env: NodeJS.ProcessEnv,
  nowMs?: number,
): string | null;

export type BackupReceiptPayload = {
  formatVersion: 1;
  artifactType: "postgres-full-database" | "sqlite-full-database";
  artifactSha256: string;
  databaseIdentity: string;
  createdAt: string;
  verifiedAt: string;
};

export function createBackupReceipt(
  payload: BackupReceiptPayload,
  secret: string,
): string;

export function verifyBackupReceipt(
  receipt: string | null | undefined,
  options: {
    databaseUrl: string | null | undefined;
    nowMs?: number;
    secret: string | null | undefined;
    maxAgeMs?: number;
  },
):
  | { ok: true; payload: BackupReceiptPayload }
  | { ok: false; error: string };
