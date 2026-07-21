import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The backup script is the league's only defense against data loss — pin the
// SQLite path (copy) end-to-end with a throwaway db file. The Postgres path
// shells out to pg_dump, which a unit test can't exercise hermetically; its
// URL-vs-file dispatch is covered here via the failure mode (no URL).
const SCRIPT = path.resolve(process.cwd(), "scripts/backup-db.mjs");

describe("db backup script", () => {
  it("copies a SQLite database into a timestamped backup file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ld2l-backup-"));
    const dbFile = path.join(dir, "source.db");
    writeFileSync(dbFile, "sqlite-bytes-fixture");
    const backupDir = path.join(dir, "out");

    const out = execFileSync("node", [SCRIPT], {
      env: {
        ...process.env,
        DATABASE_URL: `file:${dbFile}`,
        DIRECT_URL: "",
        BACKUP_DIR: backupDir,
      },
      encoding: "utf8",
    });

    expect(out).toContain("SQLite backup written");
    const files = readdirSync(backupDir).filter((f) => f.endsWith(".db"));
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(backupDir, files[0]), "utf8")).toBe(
      "sqlite-bytes-fixture",
    );
    expect(existsSync(dbFile)).toBe(true); // source untouched
  });

  it("falls back to .env in the cwd — `npm run db:backup` works bare", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ld2l-backup-env-"));
    const dbFile = path.join(dir, "envdb.db");
    writeFileSync(dbFile, "from-dotenv");
    writeFileSync(
      path.join(dir, ".env"),
      `# comment\nDATABASE_URL="file:${dbFile}"\nOTHER=x\n`,
    );
    const backupDir = path.join(dir, "out");

    const out = execFileSync("node", [SCRIPT], {
      cwd: dir, // .env lives here; no URL in the process env
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => k !== "DATABASE_URL" && k !== "DIRECT_URL",
          ),
        ),
        NODE_ENV: "test",
        BACKUP_DIR: backupDir,
      },
      encoding: "utf8",
    });
    expect(out).toContain("SQLite backup written");
    expect(readdirSync(backupDir)).toHaveLength(1);
  });

  it("fails loudly when no database URL is configured anywhere", () => {
    const bare = mkdtempSync(path.join(tmpdir(), "ld2l-backup-bare-")); // no .env
    expect(() =>
      execFileSync("node", [SCRIPT], {
        cwd: bare,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([k]) => k !== "DATABASE_URL" && k !== "DIRECT_URL",
            ),
          ),
          NODE_ENV: "test",
        },
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
