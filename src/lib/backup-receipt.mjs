import { createHmac, timingSafeEqual } from "node:crypto";
import { postgresDatabaseIdentity } from "./postgres-identity.mjs";

export const BACKUP_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECEIPT_PREFIX = "ld2l-backup-v1";

export function productionDeleteBackupRequired(env) {
  return env.VERCEL_ENV
    ? env.VERCEL_ENV === "production"
    : env.NODE_ENV === "production";
}

export function productionDeleteBackupError(receipt, env, nowMs = Date.now()) {
  if (!productionDeleteBackupRequired(env)) return null;
  const result = verifyBackupReceipt(receipt, {
    databaseUrl: env.DIRECT_URL || env.DATABASE_URL,
    nowMs,
    secret: env.BACKUP_RECEIPT_SECRET,
  });
  return result.ok ? null : result.error;
}

/** Sign the result of verifying one complete database artifact. */
export function createBackupReceipt(payload, secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("BACKUP_RECEIPT_SECRET must contain at least 32 characters");
  }
  assertPayload(payload);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signed = `${RECEIPT_PREFIX}.${encoded}`;
  const signature = createHmac("sha256", secret)
    .update(signed)
    .digest("base64url");
  return `${signed}.${signature}`;
}

/**
 * Verify a portable receipt before a production hard delete. The receipt is
 * useful evidence only when it is recent, signed, for a full PostgreSQL dump,
 * and names the exact logical database currently serving the application.
 */
export function verifyBackupReceipt(
  receipt,
  { databaseUrl, nowMs = Date.now(), secret, maxAgeMs = BACKUP_RECEIPT_MAX_AGE_MS },
) {
  if (!receipt?.trim()) return { ok: false, error: "A backup verification receipt is required." };
  if (typeof secret !== "string" || secret.length < 32) {
    return {
      ok: false,
      error: "Production backup receipt verification is not configured.",
    };
  }
  const identity = postgresDatabaseIdentity(databaseUrl);
  if (!identity) {
    return { ok: false, error: "The production database identity is invalid." };
  }
  if (receipt.length > 4096) {
    return { ok: false, error: "The backup verification receipt is invalid." };
  }

  const parts = receipt.trim().split(".");
  if (parts.length !== 3 || parts[0] !== RECEIPT_PREFIX) {
    return { ok: false, error: "The backup verification receipt is invalid." };
  }
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", secret).update(signed).digest();
  let supplied;
  try {
    supplied = Buffer.from(parts[2], "base64url");
  } catch {
    return { ok: false, error: "The backup verification receipt is invalid." };
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, error: "The backup verification receipt is invalid." };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    assertPayload(payload);
  } catch {
    return { ok: false, error: "The backup verification receipt is invalid." };
  }
  if (payload.artifactType !== "postgres-full-database") {
    return {
      ok: false,
      error: "The receipt is not for a complete PostgreSQL database backup.",
    };
  }
  if (payload.databaseIdentity !== identity) {
    return {
      ok: false,
      error: "The receipt belongs to a different database.",
    };
  }

  const createdAt = Date.parse(payload.createdAt);
  const verifiedAt = Date.parse(payload.verifiedAt);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(verifiedAt) ||
    createdAt > verifiedAt + 5 * 60 * 1000 ||
    verifiedAt > nowMs + 5 * 60 * 1000 ||
    nowMs - createdAt > maxAgeMs ||
    nowMs - verifiedAt > maxAgeMs
  ) {
    return {
      ok: false,
      error: "The backup receipt is older than 24 hours; create and verify a fresh full backup.",
    };
  }
  return { ok: true, payload };
}

function assertPayload(payload) {
  if (
    !payload ||
    payload.formatVersion !== 1 ||
    !["postgres-full-database", "sqlite-full-database"].includes(
      payload.artifactType,
    ) ||
    !/^[a-f0-9]{64}$/.test(payload.artifactSha256) ||
    typeof payload.databaseIdentity !== "string" ||
    !payload.databaseIdentity ||
    typeof payload.createdAt !== "string" ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    typeof payload.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(payload.verifiedAt))
  ) {
    throw new Error("invalid backup receipt payload");
  }
}
