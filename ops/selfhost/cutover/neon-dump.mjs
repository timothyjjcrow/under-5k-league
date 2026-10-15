// Dump one league's Neon database on the Mac for the move to the box (design
// §6.0 P5, §6.1 W8 and §6.2 E5; ops/selfhost/README.md).
//
//   node ops/selfhost/cutover/neon-dump.mjs us|eu [--dry-run] [--out <dir>]
//     [--source neonctl|env-file] [--env-file <file>] [--database <name>]
//     [--pg-bin <dir>]
//
// The owner connection string lives only in this process's memory and in one
// child's environment. US: `npx neonctl@6.2.3 connection-string` for the
// neondb_owner role (Tim's neonctl login). Europe: DIRECT_URL read in-process
// from ~/.config/ggd2l-europe/europe-production.env (0600), falling back to
// neonctl when the file or the key is missing. scripts/backup-db.mjs then runs
// from an empty scratch directory (no .env to load) with DIRECT_URL and
// BACKUP_DIR in its environment only; it hands pg_dump libpq fields, never a
// URL in argv. scripts/verify-backup.mjs checks the checksum with no receipt
// secret. Prints JSON with only file paths, sizes and sha256 values; never the
// URL. --dry-run checks the login, the URL's shape and pg_dump, and writes
// nothing.
//
// pg_dump must be PostgreSQL 18: Neon runs 18, and the box restores into 18,
// which a newer pg_dump's output is not guaranteed to load.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BACKUP_SCRIPT = path.join(REPO_ROOT, "scripts", "backup-db.mjs");
const VERIFY_SCRIPT = path.join(REPO_ROOT, "scripts", "verify-backup.mjs");

export const NEONCTL = "neonctl@6.2.3";
export const OWNER_ROLE = "neondb_owner";
export const PG_MAJOR = 18;
export const DEFAULT_PG_BIN = "/opt/homebrew/opt/postgresql@18/bin";
export const DEFAULT_DATABASE = "neondb";
export const LEAGUES = Object.freeze({
  us: Object.freeze({ projectId: "crimson-heart-25180140", envFile: null }),
  eu: Object.freeze({
    projectId: "jolly-flower-08491639",
    envFile: path.join(homedir(), ".config", "ggd2l-europe", "europe-production.env"),
  }),
});

const USAGE =
  "Usage: node ops/selfhost/cutover/neon-dump.mjs us|eu [--dry-run] [--out <dir>] " +
  "[--source neonctl|env-file] [--env-file <file>] [--database <name>] [--pg-bin <dir>]";
// Only these reach the dump's children; nothing else from the operator's shell
// (another database URL, a receipt secret, PG* overrides) can.
const PASSED_THROUGH = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "TMPDIR", "TZ", "USER"];

export function parseArguments(args) {
  const options = { dryRun: false };
  const positional = [];
  const valueFlags = {
    "--out": "out",
    "--source": "source",
    "--env-file": "envFile",
    "--database": "database",
    "--pg-bin": "pgBin",
  };
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument === "--dry-run" && !options.dryRun) {
      options.dryRun = true;
    } else if (Object.hasOwn(valueFlags, argument)) {
      const key = valueFlags[argument];
      const value = args[i + 1];
      if (options[key] !== undefined || value === undefined || value.startsWith("--")) {
        throw new Error(USAGE);
      }
      options[key] = value;
      i += 1;
    } else if (!argument.startsWith("-")) {
      positional.push(argument);
    } else {
      throw new Error(USAGE);
    }
  }
  if (positional.length !== 1 || !Object.hasOwn(LEAGUES, positional[0])) {
    throw new Error(USAGE);
  }
  const league = positional[0];
  if (options.source !== undefined && !["neonctl", "env-file"].includes(options.source)) {
    throw new Error(USAGE);
  }
  if (options.database !== undefined && !/^[A-Za-z0-9_]+$/.test(options.database)) {
    throw new Error("--database takes a plain database name.");
  }
  const envFile = options.envFile ?? LEAGUES[league].envFile;
  if (options.source === "env-file" && !envFile) {
    throw new Error("--source env-file needs --env-file <file> for the US league.");
  }
  return {
    league,
    dryRun: options.dryRun,
    source: options.source ?? (envFile ? "env-file" : "neonctl"),
    explicitSource: options.source !== undefined,
    envFile: envFile ? path.resolve(envFile) : null,
    database: options.database,
    pgBin: path.resolve(options.pgBin ?? DEFAULT_PG_BIN),
    out: path.resolve(options.out ?? path.join(homedir(), "ggd2l-cutover", league)),
  };
}

/** Remove the URL and its password, and anything else shaped like a URL. */
export function scrub(text, secrets = []) {
  let output = String(text ?? "");
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[redacted]");
  }
  return output.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]");
}

function secretsOf(url) {
  const secrets = [url];
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      secrets.push(parsed.password);
      try {
        secrets.push(decodeURIComponent(parsed.password));
      } catch {
        // The raw form above is already covered.
      }
    }
  } catch {
    // An unparsable value is refused before it is used.
  }
  return secrets.filter((secret) => secret.length >= 4);
}

function outputTail(text, lines = 6) {
  const tail = String(text ?? "").trim().split("\n").slice(-lines).join("\n");
  return tail ? `\n${tail}` : "";
}

function withoutDatabaseKeys(env) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (/^PG/.test(key) || ["DATABASE_URL", "DIRECT_URL", "BACKUP_RECEIPT_SECRET"].includes(key)) {
      delete copy[key];
    }
  }
  return copy;
}

/** The owner connection string from neonctl, captured from its stdout. */
export function neonctlConnectionString({ projectId, database, env, run }) {
  const result = run(
    "npx",
    [
      "--yes", NEONCTL, "connection-string",
      "--project-id", projectId,
      "--role-name", OWNER_ROLE,
      "--database-name", database,
    ],
    {
      env: withoutDatabaseKeys(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `neonctl returned no connection string (exit ${result.status ?? "none"}); ` +
        `check the login with \`npx ${NEONCTL} me\`.${outputTail(scrub(result.stderr), 3)}`,
    );
  }
  const urls = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^postgres(?:ql)?:\/\//i.test(line));
  if (urls.length !== 1) throw new Error("neonctl did not print exactly one connection string.");
  return urls[0];
}

/** DIRECT_URL from a private env file, or null when the file or key is absent. */
export function envFileConnectionString(file) {
  let info;
  try {
    info = statSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot read ${file}.`);
  }
  if (!info.isFile()) throw new Error(`${file} is not a file.`);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${file} is readable by other users; chmod 600 it first.`);
  }
  let values;
  try {
    values = parseEnv(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not a parsable env file.`);
  }
  return values.DIRECT_URL || null;
}

/** The URL must be Neon's direct endpoint for the owner role. */
export function assertNeonOwnerUrl(raw, database) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The connection string is not a valid URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("The connection string is not a PostgreSQL URL.");
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".neon.tech")) {
    throw new Error("The connection string does not point at a Neon endpoint.");
  }
  if (host.split(".")[0].endsWith("-pooler")) {
    throw new Error("The connection string uses Neon's pooler; pg_dump needs the direct endpoint.");
  }
  let role;
  let name;
  try {
    role = decodeURIComponent(url.username);
    name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("The connection string has invalid percent-encoding.");
  }
  if (role !== OWNER_ROLE) throw new Error(`The connection string's role is not ${OWNER_ROLE}.`);
  if (!url.password) throw new Error("The connection string carries no password.");
  if (!name) throw new Error("The connection string names no database.");
  if (database && name !== database) {
    throw new Error(`The connection string names database ${name}, not ${database}.`);
  }
  return { database: name };
}

/** pg_dump in pgBin, exactly major 18. Returns its version. */
export function pgDumpVersion(pgBin, run) {
  const binary = path.join(pgBin, "pg_dump");
  if (!existsSync(binary)) {
    throw new Error(
      `pg_dump ${PG_MAJOR} was not found at ${binary}. Install it with ` +
        "`brew install postgresql@18`, or pass --pg-bin <dir>.",
    );
  }
  const result = run(binary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const match = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(String(result.stdout ?? ""));
  if (result.error || result.status !== 0 || !match) {
    throw new Error(`${binary} --version failed.`);
  }
  if (Number(match[1]) !== PG_MAJOR) {
    throw new Error(
      `${binary} is PostgreSQL ${match[1]}; the cutover needs pg_dump ${PG_MAJOR}, ` +
        `matching Neon and the box.`,
    );
  }
  return `${match[1]}.${match[2] ?? "0"}`;
}

function childEnv(env, extra) {
  const child = {};
  for (const key of PASSED_THROUGH) {
    if (env[key] !== undefined) child[key] = env[key];
  }
  return { ...child, ...extra };
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function assertOutsideRepository(dir) {
  const relative = path.relative(REPO_ROOT, dir);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  const ignored = relative === "backups" || relative.startsWith(`backups${path.sep}`);
  if (inside && !ignored) {
    throw new Error(
      "Refusing to write a production dump inside the repository; use a folder " +
        "outside it (default ~/ggd2l-cutover/<lg>) or under backups/.",
    );
  }
}

export function runNeonDump({
  args,
  env = process.env,
  run = spawnSync,
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  const options = parseArguments(args);
  const league = LEAGUES[options.league];

  let url = null;
  let source = options.source;
  if (source === "env-file") {
    log(`Reading DIRECT_URL from ${options.envFile} (in memory).`);
    url = envFileConnectionString(options.envFile);
    if (!url) {
      if (options.explicitSource) {
        throw new Error(`${options.envFile} is missing or holds no DIRECT_URL.`);
      }
      log(`${options.envFile} is missing or holds no DIRECT_URL; asking neonctl instead.`);
      source = "neonctl";
    }
  }
  if (source === "neonctl") {
    log(`Asking ${NEONCTL} for the ${OWNER_ROLE} connection string (project ${league.projectId}).`);
    url = neonctlConnectionString({
      projectId: league.projectId,
      database: options.database ?? DEFAULT_DATABASE,
      env,
      run,
    });
  }
  const secrets = secretsOf(url);
  const expectedDatabase = source === "neonctl" ? options.database ?? DEFAULT_DATABASE : options.database;
  const { database } = assertNeonOwnerUrl(url, expectedDatabase);
  const pgDump = pgDumpVersion(options.pgBin, run);
  assertOutsideRepository(options.out);

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      league: options.league,
      source,
      role: OWNER_ROLE,
      database,
      endpoint: "direct",
      pgDump,
      outDir: options.out,
    };
  }

  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  chmodSync(options.out, 0o700);
  // An empty working directory: backup-db.mjs and verify-backup.mjs read a .env
  // from their cwd, which could otherwise supply a receipt secret or a URL.
  const scratch = mkdtempSync(path.join(tmpdir(), "ggd2l-neon-dump-"));
  let sql;
  try {
    log(`Dumping the ${options.league} database ${database} with pg_dump ${pgDump}.`);
    const dump = run(process.execPath, [BACKUP_SCRIPT], {
      cwd: scratch,
      env: childEnv(env, {
        PATH: [options.pgBin, env.PATH].filter(Boolean).join(path.delimiter),
        DIRECT_URL: url,
        BACKUP_DIR: options.out,
      }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const dumpOutput = scrub(`${dump.stdout ?? ""}\n${dump.stderr ?? ""}`, secrets);
    if (dump.error || dump.status !== 0) {
      throw new Error(`backup-db.mjs failed (exit ${dump.status ?? "none"}).${outputTail(dumpOutput)}`);
    }
    sql = /^Postgres backup written: (.+)$/m.exec(String(dump.stdout ?? ""))?.[1];
    if (!sql || path.dirname(sql) !== options.out || !sql.endsWith(".sql")) {
      throw new Error("backup-db.mjs did not report a Postgres dump in the output folder.");
    }

    log("Verifying the checksum (no receipt secret).");
    const verify = run(process.execPath, [VERIFY_SCRIPT, sql], {
      cwd: scratch,
      env: childEnv(env, { PATH: env.PATH ?? "" }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60_000,
    });
    const verifyOutput = `${verify.stdout ?? ""}\n${verify.stderr ?? ""}`;
    if (/receipt:/i.test(verifyOutput)) {
      throw new Error("verify-backup.mjs printed a receipt; it was not shown. Check that no receipt secret is set.");
    }
    if (verify.error || verify.status !== 0 || !/^Verified backup: /m.test(verifyOutput)) {
      throw new Error(`verify-backup.mjs did not verify the dump.${outputTail(scrub(verifyOutput, secrets))}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const files = [sql, `${sql}.sha256`, `${sql}.metadata.json`].map((file) => ({
    path: file,
    bytes: statSync(file).size,
    sha256: sha256File(file),
  }));
  return { ok: true, league: options.league, source, database, pgDump, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runNeonDump({ args: process.argv.slice(2) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `neon-dump: ${scrub(error instanceof Error ? error.message : "unknown error")}\n`,
    );
    process.exitCode = 1;
  }
}
