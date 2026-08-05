import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyBackupReceipt } from "./backup-receipt.mjs";

// Exercise both database branches without touching a real database. PostgreSQL
// uses a tiny fake pg_dump executable so the test can inspect argv/environment
// and force a mid-dump failure while the production script remains unchanged.
const BACKUP_SCRIPT = path.resolve(process.cwd(), "scripts/backup-db.mjs");
const VERIFY_SCRIPT = path.resolve(process.cwd(), "scripts/verify-backup.mjs");

function envWithoutDatabaseUrls(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "DATABASE_URL" && key !== "DIRECT_URL",
    ),
  ) as NodeJS.ProcessEnv;
}

function backupFiles(directory: string, extension: ".db" | ".sql") {
  return readdirSync(directory)
    .filter((file) => file.endsWith(extension))
    .map((file) => path.join(directory, file));
}

function createSqliteBackup() {
  const directory = mkdtempSync(path.join(tmpdir(), "ld2l-backup-"));
  const database = path.join(directory, "source.db");
  const output = path.join(directory, "out");
  execFileSync("sqlite3", [
    database,
    "PRAGMA journal_mode=WAL; CREATE TABLE fixture(value TEXT NOT NULL); INSERT INTO fixture VALUES ('sqlite-row-fixture');",
  ]);

  const stdout = execFileSync("node", [BACKUP_SCRIPT], {
    env: {
      ...envWithoutDatabaseUrls(),
      DATABASE_URL: `file:${database}`,
      BACKUP_DIR: output,
    },
    encoding: "utf8",
  });

  const [backup] = backupFiles(output, ".db");
  return { backup, database, directory, output, stdout };
}

function installFakePgDump(directory: string) {
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const executable = path.join(bin, "pg_dump");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
const outputArg = argv.find((value) => value.startsWith("--file="));
writeFileSync(process.env.PG_DUMP_CAPTURE, JSON.stringify({
  argv,
  pgdatabase: process.env.PGDATABASE,
  pghost: process.env.PGHOST,
  pgport: process.env.PGPORT,
  pguser: process.env.PGUSER,
  pgpassword: process.env.PGPASSWORD,
  pgsslmode: process.env.PGSSLMODE,
  hasDatabaseUrl: Object.hasOwn(process.env, "DATABASE_URL"),
  hasDirectUrl: Object.hasOwn(process.env, "DIRECT_URL"),
}));
if (!outputArg) process.exit(8);
writeFileSync(outputArg.slice("--file=".length), "postgres-dump-fixture");
if (process.env.PG_DUMP_FAIL === "1") process.exit(9);
`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  return bin;
}

describe("db backup script", () => {
  it("publishes a private SQLite backup with a valid checksum", () => {
    const { backup, database, output, stdout } = createSqliteBackup();

    expect(stdout).toContain("SQLite backup written");
    expect(
      execFileSync("sqlite3", [backup, "PRAGMA integrity_check;"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("ok");
    expect(
      execFileSync("sqlite3", [backup, "SELECT value FROM fixture;"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("sqlite-row-fixture");
    expect(existsSync(database)).toBe(true);
    expect(statSync(output).mode & 0o777).toBe(0o700);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(statSync(`${backup}.sha256`).mode & 0o777).toBe(0o600);
    expect(statSync(`${backup}.metadata.json`).mode & 0o777).toBe(0o600);

    const expected = createHash("sha256")
      .update(readFileSync(backup))
      .digest("hex");
    expect(readFileSync(`${backup}.sha256`, "utf8")).toBe(
      `${expected}  ${path.basename(backup)}\n`,
    );
    expect(
      execFileSync("node", [VERIFY_SCRIPT, backup], { encoding: "utf8" }),
    ).toContain("Verified backup");
  });

  it("repairs legacy backup permissions before publishing another backup", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ld2l-backup-legacy-"));
    const database = path.join(directory, "source.db");
    const output = path.join(directory, "out");
    mkdirSync(output, { mode: 0o755 });
    const legacy = path.join(output, "backup-legacy.db");
    const sidecar = `${legacy}.sha256`;
    const metadata = `${legacy}.metadata.json`;
    execFileSync("sqlite3", [database, "CREATE TABLE fixture(value);"]);
    writeFileSync(legacy, "legacy", { mode: 0o644 });
    writeFileSync(sidecar, "legacy-checksum", { mode: 0o644 });
    writeFileSync(metadata, "{}", { mode: 0o644 });

    execFileSync("node", [BACKUP_SCRIPT], {
      env: {
        ...envWithoutDatabaseUrls(),
        DATABASE_URL: `file:${database}`,
        BACKUP_DIR: output,
      },
    });

    expect(statSync(output).mode & 0o777).toBe(0o700);
    expect(statSync(legacy).mode & 0o777).toBe(0o600);
    expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    expect(statSync(metadata).mode & 0o777).toBe(0o600);
  });

  it("falls back to .env in the cwd when the process has no database URL", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ld2l-backup-env-"));
    const database = path.join(directory, "envdb.db");
    const output = path.join(directory, "out");
    execFileSync("sqlite3", [database, "CREATE TABLE fixture(value);"]);
    writeFileSync(
      path.join(directory, ".env"),
      `# comment\nDATABASE_URL="file:${database}"\nOTHER=x\n`,
    );

    const stdout = execFileSync("node", [BACKUP_SCRIPT], {
      cwd: directory,
      env: {
        ...envWithoutDatabaseUrls(),
        NODE_ENV: "test",
        BACKUP_DIR: output,
      },
      encoding: "utf8",
    });

    expect(stdout).toContain("SQLite backup written");
    expect(readdirSync(output)).toHaveLength(3);
    expect(backupFiles(output, ".db")).toHaveLength(1);
  });

  it("fails loudly when no database URL is configured anywhere", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ld2l-backup-bare-"));
    const result = spawnSync("node", [BACKUP_SCRIPT], {
      cwd: directory,
      env: { ...envWithoutDatabaseUrls(), NODE_ENV: "test" },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set DATABASE_URL (or DIRECT_URL)");
  });

  it("detects a backup changed after publication", () => {
    const { backup } = createSqliteBackup();
    writeFileSync(backup, "tampered");

    const result = spawnSync("node", [VERIFY_SCRIPT, backup], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match its SHA-256 checksum");
  });

  it("passes parsed PostgreSQL fields through libpq env rather than argv", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ld2l-pgdump-"));
    const bin = installFakePgDump(directory);
    const capture = path.join(directory, "capture.json");
    const output = path.join(directory, "out");
    const databaseUrl =
      "postgresql://league:very-secret-pass@db.example.com:5432/league?sslmode=require";

    const stdout = execFileSync("node", [BACKUP_SCRIPT], {
      env: {
        ...envWithoutDatabaseUrls(),
        DATABASE_URL: databaseUrl,
        BACKUP_DIR: output,
        PG_DUMP_CAPTURE: capture,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    const captured = JSON.parse(readFileSync(capture, "utf8")) as {
      argv: string[];
      pgdatabase: string;
      pghost: string;
      pgport: string;
      pguser: string;
      pgpassword: string;
      pgsslmode: string;
      hasDatabaseUrl: boolean;
      hasDirectUrl: boolean;
    };
    const [backup] = backupFiles(output, ".sql");

    expect(stdout).toContain("Postgres backup written");
    expect(captured.pgdatabase).toBe("league");
    expect(captured.pghost).toBe("db.example.com");
    expect(captured.pgport).toBe("5432");
    expect(captured.pguser).toBe("league");
    expect(captured.pgpassword).toBe("very-secret-pass");
    expect(captured.pgsslmode).toBe("require");
    expect(captured.argv.join(" ")).not.toContain(databaseUrl);
    expect(captured.argv.join(" ")).not.toContain("very-secret-pass");
    expect(captured.hasDatabaseUrl).toBe(false);
    expect(captured.hasDirectUrl).toBe(false);
    expect(readFileSync(backup, "utf8")).toBe("postgres-dump-fixture");
    expect(
      execFileSync("node", [VERIFY_SCRIPT, backup], { encoding: "utf8" }),
    ).toContain("Verified backup");
    const metadata = JSON.parse(
      readFileSync(`${backup}.metadata.json`, "utf8"),
    ) as {
      artifactType: string;
      databaseIdentity: string;
    };
    expect(metadata.artifactType).toBe("postgres-full-database");
    expect(metadata.databaseIdentity).not.toContain("very-secret-pass");
  });

  it("emits a signed, database-bound receipt after full-backup verification", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ld2l-pgreceipt-"));
    const bin = installFakePgDump(directory);
    const capture = path.join(directory, "capture.json");
    const output = path.join(directory, "out");
    const databaseUrl =
      "postgresql://league:secret@ep-league.us-west-2.aws.neon.tech/league";
    const secret = "receipt-signing-secret-with-32-characters-minimum";

    execFileSync("node", [BACKUP_SCRIPT], {
      env: {
        ...envWithoutDatabaseUrls(),
        DATABASE_URL: databaseUrl,
        BACKUP_DIR: output,
        PG_DUMP_CAPTURE: capture,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    const [backup] = backupFiles(output, ".sql");
    const stdout = execFileSync("node", [VERIFY_SCRIPT, backup], {
      env: {
        ...process.env,
        BACKUP_RECEIPT_SECRET: secret,
      },
      encoding: "utf8",
    });
    const receipt = stdout.match(/Production delete receipt: (\S+)/)?.[1];
    expect(receipt).toBeTruthy();
    const checked = verifyBackupReceipt(receipt, {
      databaseUrl,
      secret,
    });
    expect(checked.ok).toBe(true);
  });

  it("removes partial files when pg_dump fails", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ld2l-pgdump-fail-"));
    const bin = installFakePgDump(directory);
    const output = path.join(directory, "out");
    const secret = "failure-path-secret";
    const result = spawnSync("node", [BACKUP_SCRIPT], {
      env: {
        ...envWithoutDatabaseUrls(),
        DATABASE_URL: `postgresql://league:${secret}@db.example.com/league`,
        BACKUP_DIR: output,
        PG_DUMP_CAPTURE: path.join(directory, "capture.json"),
        PG_DUMP_FAIL: "1",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Backup failed");
    expect(result.stderr).not.toContain(secret);
    expect(readdirSync(output)).toEqual([]);
  });
});
