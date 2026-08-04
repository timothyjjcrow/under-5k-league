// Verify one or more backup files against the sidecar emitted by backup-db.mjs.
// Usage: npm run db:backup:verify -- backups/backup-....sql
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createBackupReceipt } from "../src/lib/backup-receipt.mjs";

if (!process.env.BACKUP_RECEIPT_SECRET) {
  try {
    const env = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const match = env.match(
      /^\s*BACKUP_RECEIPT_SECRET\s*=\s*"?([^"#]+?)"?\s*$/m,
    );
    if (match) process.env.BACKUP_RECEIPT_SECRET = match[1];
  } catch {
    // Checksum-only verification remains useful without a signing secret.
  }
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Pass at least one .db or .sql backup file to verify.");
  process.exitCode = 1;
} else {
  try {
    for (const file of files) await verify(file);
  } catch (error) {
    console.error(
      `Backup verification failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}

async function verify(input) {
  const file = path.resolve(input);
  const info = statSync(file);
  if (!info.isFile() || info.size === 0) throw new Error(`${file} is not a non-empty file`);
  assertPrivateMode(file, info.mode);

  const checksumFile = `${file}.sha256`;
  const checksumInfo = statSync(checksumFile);
  if (!checksumInfo.isFile()) throw new Error(`${checksumFile} is not a file`);
  assertPrivateMode(checksumFile, checksumInfo.mode);

  const sidecar = readFileSync(checksumFile, "utf8").trim();
  const match = sidecar.match(/^([a-f0-9]{64})\s{2}(.+)$/);
  if (!match) throw new Error(`${checksumFile} has an invalid SHA-256 record`);
  if (match[2] !== path.basename(file)) {
    throw new Error(`${checksumFile} names a different backup file`);
  }

  const actual = await sha256File(file);
  const expectedBytes = Buffer.from(match[1], "hex");
  const actualBytes = Buffer.from(actual, "hex");
  if (!timingSafeEqual(expectedBytes, actualBytes)) {
    throw new Error(`${file} does not match its SHA-256 checksum`);
  }
  console.log(`Verified backup: ${file}`);

  const secret = process.env.BACKUP_RECEIPT_SECRET;
  if (!secret) {
    console.log(
      "No production-delete receipt emitted (BACKUP_RECEIPT_SECRET is unset).",
    );
    return;
  }
  const metadataFile = `${file}.metadata.json`;
  const metadataInfo = statSync(metadataFile);
  if (!metadataInfo.isFile()) throw new Error(`${metadataFile} is not a file`);
  assertPrivateMode(metadataFile, metadataInfo.mode);
  const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  if (
    metadata?.formatVersion !== 1 ||
    metadata.artifact !== path.basename(file) ||
    metadata.artifactSha256 !== actual ||
    !["postgres-full-database", "sqlite-full-database"].includes(
      metadata.artifactType,
    ) ||
    typeof metadata.databaseIdentity !== "string" ||
    !metadata.databaseIdentity ||
    typeof metadata.createdAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.createdAt))
  ) {
    throw new Error(`${metadataFile} has invalid or mismatched backup metadata`);
  }
  const receipt = createBackupReceipt(
    {
      formatVersion: 1,
      artifactType: metadata.artifactType,
      artifactSha256: actual,
      databaseIdentity: metadata.databaseIdentity,
      createdAt: metadata.createdAt,
      verifiedAt: new Date().toISOString(),
    },
    secret,
  );
  console.log(`Production delete receipt: ${receipt}`);
}

function assertPrivateMode(file, mode) {
  if ((mode & 0o077) !== 0) {
    throw new Error(`${file} is readable or writable by group/other users`);
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
