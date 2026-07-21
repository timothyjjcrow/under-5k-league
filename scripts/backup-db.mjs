// Back up the league database — the entire multi-season history (games, box
// scores, Elo, seasons) lives in one database with no other copy, so run this
// before schema changes and on a habit cadence. Postgres URLs (production /
// Neon) go through pg_dump; file: URLs (local SQLite) are copied. Output is a
// timestamped file under backups/ (gitignored).
//
//   npm run db:backup                          # backs up DATABASE_URL from .env
//   DATABASE_URL="postgres://…" npm run db:backup   # back up production
//
// For production, paste the Neon DIRECT_URL (not the pooled URL) — pg_dump
// needs a direct connection. Restore: psql "$URL" < backups/<file>.sql, or for
// SQLite just copy the .db file back.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Plain `node` doesn't read .env (prisma does its own loading) — parse the two
// URL keys out ourselves so the documented `npm run db:backup` works from a
// bare checkout. Explicit env vars always win. (--env-file would be cleaner,
// but on Node 20 it hard-fails when .env doesn't exist.)
if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) {
  try {
    const env = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(
        /^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*"?([^"#]+?)"?\s*$/,
      );
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    // no .env — the explicit-env error path below explains what to do
  }
}

const raw = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!raw) {
  console.error("Set DATABASE_URL (or DIRECT_URL) to the database to back up.");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = process.env.BACKUP_DIR || path.resolve(process.cwd(), "backups");
mkdirSync(outDir, { recursive: true });

if (raw.startsWith("file:")) {
  // SQLite: the database IS a file — copy it (plus nothing else; WAL is
  // checkpointed on clean close, and a dev backup doesn't need to be atomic).
  const dbPath = path.resolve(
    process.cwd(),
    "prisma",
    raw.replace(/^file:/, "").replace(/^\.\//, ""),
  );
  const src = existsSync(dbPath)
    ? dbPath
    : path.resolve(process.cwd(), raw.replace(/^file:/, ""));
  if (!existsSync(src)) {
    console.error(`SQLite file not found: ${src}`);
    process.exit(1);
  }
  const out = path.join(outDir, `backup-${stamp}.db`);
  copyFileSync(src, out);
  console.log(`SQLite backup written: ${out}`);
} else {
  const out = path.join(outDir, `backup-${stamp}.sql`);
  try {
    execFileSync("pg_dump", ["--no-owner", "--no-privileges", `--file=${out}`, raw], {
      stdio: "inherit",
    });
  } catch (e) {
    if (e.code === "ENOENT") {
      console.error(
        "pg_dump not found — install postgresql (brew install postgresql) and retry.",
      );
      process.exit(1);
    }
    throw e;
  }
  console.log(`Postgres backup written: ${out}`);
}
