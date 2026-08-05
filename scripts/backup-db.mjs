// Back up the complete league database. A backup is assembled under a private
// temporary name, checksummed, and only then atomically renamed into place, so
// an interrupted copy/dump cannot masquerade as a usable backup.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { postgresCliEnv } from "../src/lib/postgres-cli-env.mjs";
import { postgresDatabaseIdentity } from "../src/lib/postgres-identity.mjs";

// Plain `node` does not load .env. Read only the two connection keys needed by
// this script; explicit process environment variables remain authoritative.
if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) {
  try {
    const env = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    for (const line of env.split("\n")) {
      const match = line.match(
        /^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*"?([^"#]+?)"?\s*$/,
      );
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // The explicit missing-configuration error below is the useful message.
  }
}

const databaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set DATABASE_URL (or DIRECT_URL) to the database to back up.");
  process.exitCode = 1;
} else {
  try {
    await createBackup(databaseUrl);
  } catch (error) {
    if (error?.code === "ENOENT" && databaseUrl.startsWith("file:")) {
      console.error(
        "sqlite3 not found — install the SQLite command-line client to create a consistent online snapshot.",
      );
    } else if (error?.code === "ENOENT") {
      console.error(
        "pg_dump not found — install a PostgreSQL client at least as new as the server and retry.",
      );
    } else {
      console.error(
        `Backup failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    process.exitCode = 1;
  }
}

async function createBackup(raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const outDir = process.env.BACKUP_DIR || path.resolve(process.cwd(), "backups");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  // mkdir's mode is umask-sensitive and does not change an existing directory.
  chmodSync(outDir, 0o700);
  normalizeExistingBackupModes(outDir);

  const sqlite = raw.startsWith("file:");
  const base = `backup-${stamp}-${process.pid}.${sqlite ? "db" : "sql"}`;
  const output = path.join(outDir, base);
  const checksum = `${output}.sha256`;
  const metadata = `${output}.metadata.json`;
  const nonce = randomBytes(6).toString("hex");
  const temporary = path.join(outDir, `.${base}.${nonce}.tmp`);
  const checksumTemporary = `${temporary}.sha256.tmp`;
  const metadataTemporary = `${temporary}.metadata.tmp`;

  try {
    if (sqlite) {
      const source = sqlitePath(raw);
      if (!existsSync(source)) throw new Error(`SQLite file not found: ${source}`);
      // SQLite may be in WAL mode and accepting writes. A byte copy can miss
      // committed WAL pages or capture files from different instants. The
      // online backup API takes one coherent snapshot while the source stays
      // live; then integrity_check validates the artifact, not the source.
      execFileSync(
        "sqlite3",
        ["-cmd", ".timeout 10000", source, `.backup ${JSON.stringify(temporary)}`],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const integrity = execFileSync(
        "sqlite3",
        [temporary, "PRAGMA integrity_check;"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      if (integrity !== "ok") {
        throw new Error("SQLite snapshot failed PRAGMA integrity_check");
      }
    } else {
      // Keep credentials out of argv/process listings. PostgreSQL's command-line
      // clients do not consistently treat a URI stored in PGDATABASE as a
      // connection string, so translate the URI into libpq's dedicated
      // environment variables instead.
      const childEnv = postgresCliEnv(raw);
      execFileSync(
        "pg_dump",
        ["--no-owner", "--no-privileges", `--file=${temporary}`],
        { stdio: "inherit", env: childEnv },
      );
    }

    chmodSync(temporary, 0o600);
    if (statSync(temporary).size === 0) {
      throw new Error("the backup command produced an empty file");
    }

    const digest = await sha256File(temporary);
    writeFileSync(checksumTemporary, `${digest}  ${base}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(checksumTemporary, 0o600);
    const databaseIdentity = sqlite
      ? `sqlite:${createHash("sha256").update(sqlitePath(raw)).digest("hex")}`
      : postgresDatabaseIdentity(raw);
    if (!databaseIdentity) {
      throw new Error("could not identify the database target");
    }
    writeFileSync(
      metadataTemporary,
      `${JSON.stringify(
        {
          formatVersion: 1,
          artifact: base,
          artifactType: sqlite
            ? "sqlite-full-database"
            : "postgres-full-database",
          artifactSha256: digest,
          createdAt: new Date().toISOString(),
          databaseIdentity,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    chmodSync(metadataTemporary, 0o600);

    // Both temporary files live beside their final names, so each rename is an
    // atomic publication on the same filesystem. The catch removes a published
    // first half if the second rename unexpectedly fails.
    renameSync(temporary, output);
    renameSync(checksumTemporary, checksum);
    renameSync(metadataTemporary, metadata);

    console.log(`${sqlite ? "SQLite" : "Postgres"} backup written: ${output}`);
    console.log(`SHA-256 checksum written: ${checksum}`);
    console.log(`Backup metadata written: ${metadata}`);
  } catch (error) {
    for (const file of [
      temporary,
      checksumTemporary,
      metadataTemporary,
      output,
      checksum,
      metadata,
    ]) {
      try {
        unlinkSync(file);
      } catch {
        // Missing is the expected state for whichever publication step did not run.
      }
    }
    throw error;
  }
}

function normalizeExistingBackupModes(outDir) {
  for (const entry of readdirSync(outDir)) {
    if (!/^backup-.+\.(?:db|sql)(?:\.sha256|\.metadata\.json)?$/.test(entry)) {
      continue;
    }
    const file = path.join(outDir, entry);
    const info = lstatSync(file);
    if (!info.isFile()) {
      throw new Error(
        `refusing non-regular backup path ${file}; remove it before retrying`,
      );
    }
    chmodSync(file, 0o600);
  }
}

function sqlitePath(raw) {
  const value = decodeURIComponent(raw.replace(/^file:/, "").split("?")[0]);
  const prismaRelative = path.resolve(
    process.cwd(),
    "prisma",
    value.replace(/^\.\//, ""),
  );
  return existsSync(prismaRelative)
    ? prismaRelative
    : path.resolve(process.cwd(), value);
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
