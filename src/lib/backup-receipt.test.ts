import { describe, expect, it } from "vitest";
import {
  BACKUP_RECEIPT_MAX_AGE_MS,
  createBackupReceipt,
  productionDeleteBackupError,
  verifyBackupReceipt,
  type BackupReceiptPayload,
} from "./backup-receipt.mjs";
import { postgresDatabaseIdentity } from "./postgres-identity.mjs";

const SECRET = "fresh-backup-receipt-secret-with-32-plus-characters";
const NOW = Date.parse("2026-08-03T18:00:00.000Z");
const DATABASE_URL =
  "postgresql://league:password@ep-league-pooler.us-west-2.aws.neon.tech:6543/ld2l";

function payload(
  overrides: Partial<BackupReceiptPayload> = {},
): BackupReceiptPayload {
  return {
    formatVersion: 1,
    artifactType: "postgres-full-database",
    artifactSha256: "a".repeat(64),
    databaseIdentity: postgresDatabaseIdentity(DATABASE_URL)!,
    createdAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
    verifiedAt: new Date(NOW - 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("production full-backup receipts", () => {
  it("accepts a recent signed full dump for the current logical database", () => {
    const receipt = createBackupReceipt(payload(), SECRET);
    expect(
      verifyBackupReceipt(receipt, {
        databaseUrl:
          "postgresql://league:other@ep-league.us-west-2.aws.neon.tech:5432/ld2l",
        nowMs: NOW,
        secret: SECRET,
      }),
    ).toMatchObject({ ok: true });
  });

  it("does not authorize an unknown-provider database on a different port", () => {
    const sourceUrl =
      "postgresql://league:backup@database.internal:5432/ld2l";
    const receipt = createBackupReceipt(
      payload({ databaseIdentity: postgresDatabaseIdentity(sourceUrl)! }),
      SECRET,
    );
    expect(
      verifyBackupReceipt(receipt, {
        databaseUrl:
          "postgresql://league:runtime@database.internal:6432/ld2l",
        nowMs: NOW,
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/different/i) });
  });

  it("rejects tampering, another database, SQLite snapshots and stale artifacts", () => {
    const valid = createBackupReceipt(payload(), SECRET);
    expect(
      verifyBackupReceipt(`${valid.slice(0, -1)}x`, {
        databaseUrl: DATABASE_URL,
        nowMs: NOW,
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/invalid/i) });
    expect(
      verifyBackupReceipt(valid, {
        databaseUrl:
          "postgresql://league:password@ep-other.us-west-2.aws.neon.tech/ld2l",
        nowMs: NOW,
        secret: SECRET,
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/different/i) });
    expect(
      verifyBackupReceipt(
        createBackupReceipt(
          payload({ artifactType: "sqlite-full-database" }),
          SECRET,
        ),
        { databaseUrl: DATABASE_URL, nowMs: NOW, secret: SECRET },
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/PostgreSQL/i) });
    expect(
      verifyBackupReceipt(
        createBackupReceipt(
          payload({
            createdAt: new Date(
              NOW - BACKUP_RECEIPT_MAX_AGE_MS - 1,
            ).toISOString(),
          }),
          SECRET,
        ),
        { databaseUrl: DATABASE_URL, nowMs: NOW, secret: SECRET },
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/older than/i) });
  });

  it("gates only production and fails closed on missing configuration", () => {
    expect(
      productionDeleteBackupError("", { NODE_ENV: "test" }, NOW),
    ).toBeNull();
    expect(
      productionDeleteBackupError(
        "",
        {
          NODE_ENV: "production",
          DATABASE_URL,
          BACKUP_RECEIPT_SECRET: SECRET,
        },
        NOW,
      ),
    ).toMatch(/required/i);
    expect(
      productionDeleteBackupError(
        createBackupReceipt(payload(), SECRET),
        {
          NODE_ENV: "production",
          DATABASE_URL,
        },
        NOW,
      ),
    ).toMatch(/not configured/i);
  });
});
