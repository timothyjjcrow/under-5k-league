// Database verbs (design §2.1, §6 W8): lease, parity, identity, grants-check
// and import. Credentials reach psql through libpq's environment (PGPASSWORD
// and friends), never argv; SQL arrives on stdin or from the installed
// /usr/local/lib/ggd2l/sql/<name>.sql files. Query output is parsed into
// fixed shapes; an error never repeats it.
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { readModeFile } from "./caddy-modes.mjs";
import { loadEnvFile, loadOwnerUrl } from "./context.mjs";
import { AgentError, BIN, DUMP_NAME_RE, SLOTS, UsageError, unitName } from "./layout.mjs";
import { must, pgEnv } from "./runner.mjs";

const IDENTITY_EXPECTED_ROWS = Object.freeze({ us: 2, eu: 1 });
const RELATION_RE = /^[A-Za-z0-9_:.\-"]{1,128}$/;

async function psql(ctx, url, { sql, file, readOnly = false, vars = {}, quiet = true, singleTransaction = false }) {
  const args = ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
  if (quiet) args.push("-q");
  if (singleTransaction) args.push("--single-transaction");
  for (const [name, value] of Object.entries(vars)) args.push("-v", `${name}=${value}`);
  args.push("-f", file ?? "-");
  const result = await ctx.runner.run(BIN.psql, args, {
    env: pgEnv(url, { readOnly }),
    input: sql,
  });
  if (result.code !== 0) throw new AgentError("psql_failed");
  return result.stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
}

function appUrl(ctx, lg) {
  const { env } = loadEnvFile(ctx, ctx.layout.leagueEnv(lg));
  if (!env.DATABASE_URL) throw new AgentError("env_missing");
  return env.DATABASE_URL;
}

/** `lease <lg>`: whether the automation lease is held, as the app role, read-only. */
export async function readLease(ctx, lg) {
  const lines = await psql(ctx, appUrl(ctx, lg), {
    readOnly: true,
    sql:
      `SELECT CASE WHEN "leaseOwner" IS NULL THEN 'null' ELSE 'set' END || '|' ||\n` +
      `       CASE WHEN "leaseExpiresAt" IS NULL THEN 'null' ELSE 'set' END\n` +
      `FROM "AutomationRunState" WHERE key = 'league-maintenance';\n`,
  });
  const [owner, expires] = (lines[0] ?? "null|null").split("|");
  return {
    leaseOwner: owner === "set" ? "set" : null,
    leaseExpiresAt: expires === "set" ? "set" : null,
  };
}

/**
 * `parity <lg>`: sql/db-parity.sql as the owner, read-only. Each output line
 * is one row exactly as `psql -X -q -A -t -v ON_ERROR_STOP=1 -f db-parity.sql`
 * prints it, so the Mac diffs it against the same command run on Neon.
 */
export async function parity(ctx, lg) {
  const rows = await psql(ctx, loadOwnerUrl(ctx, lg), { file: ctx.layout.sql("db-parity"), readOnly: true });
  return { ok: true, rows };
}

/** Sum the INSERT/UPDATE/DELETE command tags psql prints without -q. */
export function changedRows(lines) {
  let changed = 0;
  for (const line of lines) {
    const match = /^(?:INSERT \d+|UPDATE|DELETE) (\d+)$/.exec(line);
    if (match) changed += Number(match[1]);
  }
  return changed;
}

/**
 * `identity <lg>`: the instance markers. US inserts two absent rows; EU moves
 * its origin with a guarded update. The statements are idempotent and keyed on
 * Setting's primary key, so a wrong count cannot have written anything extra.
 */
export async function identity(ctx, lg) {
  const lines = await psql(ctx, loadOwnerUrl(ctx, lg), {
    file: ctx.layout.sql(`identity-${lg}`),
    quiet: false,
    singleTransaction: true,
  });
  const changed = changedRows(lines);
  if (changed !== IDENTITY_EXPECTED_ROWS[lg]) throw new AgentError("identity_unexpected_rows", { changed });
  return { changed };
}

/** `grants-check <lg>`: sql/runtime-grants.sql as the owner; zero rows or it fails. */
export async function grantsCheck(ctx, lg) {
  const lines = await psql(ctx, loadOwnerUrl(ctx, lg), {
    file: ctx.layout.sql("runtime-grants"),
    readOnly: true,
    vars: { app: `ggd2l_${lg}_app` },
  });
  const problems = lines.map((line) => (RELATION_RE.test(line) ? line : "(unprintable relation name)"));
  if (problems.length) throw new AgentError("grant_problems", { problems });
  return { ok: true, problems };
}

/** The dump `import` may read: a .sql basename inside the league's cutover folder. */
export function resolveDump(layout, lg, value) {
  const folder = layout.cutoverDir(lg);
  const name = path.basename(value);
  if (!DUMP_NAME_RE.test(name)) throw new UsageError("bad_file");
  if (value !== name && path.resolve(value) !== path.join(folder, name)) throw new UsageError("bad_file");
  return path.join(folder, name);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** backup-db.mjs writes "<sha256>  <basename>\n" beside the dump. */
export async function verifySidecar(file) {
  let sidecar;
  try {
    sidecar = readFileSync(`${file}.sha256`, "utf8").trim();
  } catch {
    throw new AgentError("checksum_mismatch");
  }
  const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(sidecar);
  if (!match || match[2] !== path.basename(file)) throw new AgentError("checksum_mismatch");
  let actual;
  try {
    actual = await sha256File(file);
  } catch {
    throw new AgentError("checksum_mismatch");
  }
  if (actual !== match[1]) throw new AgentError("checksum_mismatch");
  return actual;
}

async function asPostgres(ctx, code, database, input) {
  const result = await ctx.runner.run(
    BIN.runuser,
    ["-u", "postgres", "--", BIN.psql, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-d", database, "-f", "-"],
    { input, cwd: "/" },
  );
  if (result.code !== 0) throw new AgentError(code);
  return result.stdout.split("\n").filter(Boolean);
}

/**
 * `import <lg> <file>` (design §6 W8): verify the dump, stop both slots,
 * recreate the database, restore it as the owner in one transaction, grant
 * the app role DML only, ANALYZE, then check ownership.
 */
export async function importDump(ctx, lg, value) {
  const file = resolveDump(ctx.layout, lg, value);
  try {
    if (!statSync(file).isFile()) throw new Error();
  } catch {
    throw new UsageError("bad_file");
  }
  // Destroying the live database is only ever done behind the maintenance page.
  if (readModeFile(ctx.layout.modeFile(lg)).mode !== "maintenance") throw new AgentError("not_maintenance");
  const sha256 = await verifySidecar(file);

  for (const slot of SLOTS) await must(ctx.runner, "systemctl_failed", BIN.systemctl, ["stop", unitName(lg, slot)]);
  await must(ctx.runner, "provision_failed", BIN.bash, [ctx.layout.helper("provision-league-db.sh"), lg, "--recreate"]);

  const database = `ggd2l_${lg}`;
  const owner = `ggd2l_${lg}_owner`;
  const app = `ggd2l_${lg}_app`;
  await asPostgres(ctx, "restore_failed", database, Buffer.concat([
    Buffer.from(`SET ROLE ${owner};\n`),
    readFileSync(file),
  ]));
  await asPostgres(ctx, "restore_failed", database, [
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app};`,
    `REVOKE INSERT, UPDATE, DELETE ON "_prisma_migrations" FROM ${app};`,
    "ANALYZE;",
    "",
  ].join("\n"));
  const [counts = ""] = await asPostgres(ctx, "restore_failed", database, [
    "SELECT",
    "  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
    "    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')) || '|' ||",
    "  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
    `    WHERE n.nspname = 'public' AND c.relowner <> '${owner}'::regrole);`,
    "",
  ].join("\n"));
  const [tables, foreign] = counts.split("|").map(Number);
  if (!Number.isInteger(tables) || foreign !== 0) throw new AgentError("ownership");
  return { ok: true, tables, sha256 };
}
