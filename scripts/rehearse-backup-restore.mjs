// Restore one verified plain-text pg_dump into an exact localhost scratch DB.
// The destructive target is deliberately non-configurable beyond the guarded
// URL: this is a release rehearsal, never a production restore command.
//
//   node scripts/rehearse-backup-restore.mjs backup.sql
//   node scripts/rehearse-backup-restore.mjs --legacy-baseline backup.sql
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { postgresCliEnv } from "../src/lib/postgres-cli-env.mjs";
import { resolveBaselineDatabase } from "./migration-baseline-resolve.mjs";
import { inspectPostflightDatabase } from "./migration-postflight.mjs";
import { runMigrationPreflight } from "./migration-preflight.mjs";
import { validateMigrations } from "./migration-safety.mjs";
import { assertLocalRestorePostgresUrl } from "./test-db-safety.mjs";

const ROOT = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const MIGRATIONS = new URL("prisma/migrations/", ROOT);
const BASELINE_SCHEMA = new URL(
  "prisma/migrations/20260804000000_baseline/baseline.schema.prisma",
  ROOT,
);
const PRISMA_CLI = new URL("node_modules/prisma/build/index.js", ROOT);
const verifyScript = fileURLToPath(new URL("./verify-backup.mjs", import.meta.url));
const LEGACY_BASELINE_FLAG = "--legacy-baseline";

export function parseRestoreArguments(args) {
  let legacyBaseline = false;
  const positional = [];
  for (const argument of args) {
    if (argument === LEGACY_BASELINE_FLAG) {
      if (legacyBaseline) {
        throw new Error(`${LEGACY_BASELINE_FLAG} may be passed only once.`);
      }
      legacyBaseline = true;
    } else if (argument === "--") {
      continue;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown restore rehearsal option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 1) {
    throw new Error("Pass exactly one verified .sql backup file.");
  }
  return { backupArgument: positional[0], legacyBaseline };
}

export function postgresUrlForSchema(raw, schema) {
  const parsed = new URL(raw);
  parsed.searchParams.set("schema", schema);
  return parsed.toString();
}

function safeCommandOutput(value, url) {
  let output = String(value ?? "");
  output = output.split(url).join("[database URL]");
  try {
    const parsed = new URL(url);
    for (const credential of [parsed.username, parsed.password]) {
      if (!credential) continue;
      output = output.split(credential).join("[credential]");
      try {
        output = output
          .split(decodeURIComponent(credential))
          .join("[credential]");
      } catch {
        // The validated URL may contain an unusual encoding. The raw URL was
        // already removed, and no undecodable value is copied into an error.
      }
    }
  } catch {
    // The scratch-target guard validates this URL before any command runs.
  }
  return output;
}

/** Apply reviewed migrations from an isolated PostgreSQL schema workspace. */
export function deployRestoredMigrations({
  env = process.env,
  runner = spawnSync,
} = {}) {
  const url = env.DIRECT_URL ?? env.DATABASE_URL;
  const parsed = assertLocalRestorePostgresUrl(url);
  if (!parsed.searchParams.get("schema")) {
    throw new Error(
      "Restore migration deploy requires the discovered application schema.",
    );
  }
  validateMigrations();

  // Prisma resolves migrations beside the supplied schema. Copy both into a
  // throwaway directory so this command never changes the committed provider,
  // migrations, generated client, or another schema selected by the operator.
  const temporary = mkdtempSync(path.join(tmpdir(), "ld2l-restore-migrate-"));
  const temporarySchema = path.join(temporary, "schema.prisma");
  try {
    writeFileSync(temporarySchema, readFileSync(BASELINE_SCHEMA));
    cpSync(fileURLToPath(MIGRATIONS), path.join(temporary, "migrations"), {
      recursive: true,
    });
    const result = runner(
      process.execPath,
      [
        fileURLToPath(PRISMA_CLI),
        "migrate",
        "deploy",
        "--schema",
        temporarySchema,
      ],
      {
        cwd: ROOT_PATH,
        env: { ...env, DATABASE_URL: url, DIRECT_URL: url },
        encoding: "utf8",
      },
    );
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (result.status !== 0) {
      throw new Error(
        `Could not apply current migrations to the restored scratch database${
          output ? `:\n${safeCommandOutput(output, url)}` : "."
        }`,
      );
    }
    return safeCommandOutput(output, url);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function rehearseBackupRestore({
  backupArgument = process.argv[2],
  restoreUrl = process.env.PG_RESTORE_TEST_URL,
  env = process.env,
  legacyBaseline = false,
  baselineResolver = resolveBaselineDatabase,
  migrationPreflight = runMigrationPreflight,
  migrateDeploy = deployRestoredMigrations,
  postflight = inspectPostflightDatabase,
} = {}) {
  if (!backupArgument) throw new Error("Pass one verified .sql backup file.");
  assertLocalRestorePostgresUrl(restoreUrl);
  const backup = path.resolve(backupArgument);
  const backupInfo = statSync(backup);
  if (!backupInfo.isFile() || backupInfo.size === 0 || !backup.endsWith(".sql")) {
    throw new Error("Restore rehearsal requires one non-empty .sql backup file.");
  }

  execFileSync(process.execPath, [verifyScript, backup], {
    stdio: "inherit",
    env,
  });

  const maintenanceEnv = postgresCliEnv(restoreUrl, {
    database: "postgres",
    env,
  });
  const restoreEnv = postgresCliEnv(restoreUrl, { env });
  execFileSync(
    "psql",
    [
      "-X",
      "--set=ON_ERROR_STOP=on",
      "--command",
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'ld2l_restore_test' AND pid <> pg_backend_pid()",
    ],
    { stdio: "inherit", env: maintenanceEnv },
  );
  execFileSync("dropdb", ["--if-exists", "ld2l_restore_test"], {
    stdio: "inherit",
    env: maintenanceEnv,
  });
  execFileSync("createdb", ["--template=template0", "ld2l_restore_test"], {
    stdio: "inherit",
    env: maintenanceEnv,
  });
  execFileSync(
    "psql",
    [
      "-X",
      "--set=ON_ERROR_STOP=on",
      "--single-transaction",
      `--file=${backup}`,
    ],
    { stdio: "inherit", env: restoreEnv },
  );

  const schemaDiscovery = legacyBaseline
    ? `SELECT DISTINCT namespace.nspname
       FROM pg_catalog.pg_class AS relation
       INNER JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       WHERE relation.relkind IN ('r', 'p')
         AND namespace.nspname <> 'information_schema'
         AND namespace.nspname !~ '^pg_'
       ORDER BY namespace.nspname`
    : `SELECT namespace.nspname
       FROM pg_catalog.pg_class AS relation
       INNER JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       WHERE relation.relname = '_prisma_migrations'
         AND relation.relkind IN ('r', 'p')
         AND namespace.nspname <> 'information_schema'
         AND namespace.nspname !~ '^pg_'
       ORDER BY namespace.nspname`;
  const schemaOutput = execFileSync(
    "psql",
    [
      "-X",
      "--set=ON_ERROR_STOP=on",
      "--tuples-only",
      "--no-align",
      "--command",
      schemaDiscovery,
    ],
    { encoding: "utf8", env: restoreEnv },
  ).trim();
  const applicationSchemas = schemaOutput
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (applicationSchemas.length !== 1) {
    throw new Error(
      legacyBaseline
        ? `Restored legacy database must contain exactly one non-system schema with application tables; found ${applicationSchemas.length}.`
        : `Restored database must contain exactly one non-system schema with _prisma_migrations; found ${applicationSchemas.length}.`,
    );
  }
  const [applicationSchema] = applicationSchemas;

  // Feed this query on stdin so psql safely quotes the discovered value as
  // both an identifier and a string. `--command` does not expand psql
  // variables, and interpolating an arbitrary PostgreSQL identifier in JS
  // would turn a restore check into an injection surface.
  const smokeSql = legacyBaseline
    ? `SELECT
        (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_schema = :'league_schema'
            AND table_name = '_prisma_migrations'),
        (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_schema = :'league_schema'
            AND table_name IN ('User', 'Season', 'Setting'));
`
    : `SELECT
        (SELECT COUNT(*) FROM :"league_schema"."_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
        (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_schema = :'league_schema'
            AND table_name IN ('User', 'Season', 'Setting'));
`;
  const smoke = execFileSync(
    "psql",
    [
      "-X",
      "--set=ON_ERROR_STOP=on",
      "--tuples-only",
      "--no-align",
      `--set=league_schema=${applicationSchema}`,
    ],
    {
      encoding: "utf8",
      env: restoreEnv,
      input: smokeSql,
    },
  ).trim();
  const smokeValues = smoke.split("|");
  if (
    smokeValues.length !== 2 ||
    smokeValues.some((value) => !/^\d+$/.test(value))
  ) {
    throw new Error("Restore smoke check returned an unexpected result.");
  }
  const [migrationCount, coreTableCount] = smokeValues.map((value) =>
    Number(value),
  );
  if (
    (legacyBaseline ? migrationCount !== 0 : migrationCount < 2) ||
    coreTableCount !== 3
  ) {
    throw new Error(
      legacyBaseline
        ? "Legacy restore must have no _prisma_migrations table and exactly three core league tables."
        : "Restored database is missing completed release migrations or core league tables.",
    );
  }

  // The smoke query gives an immediate restore-format diagnostic. The full
  // postflight then verifies every Prisma-supported object and every reviewed
  // PostgreSQL-native object in the schema actually discovered from the dump.
  const scopedUrl = postgresUrlForSchema(restoreUrl, applicationSchema);
  const scopedEnv = { ...env, DATABASE_URL: scopedUrl, DIRECT_URL: scopedUrl };
  if (legacyBaseline) {
    // resolveBaselineDatabase is deliberately one boundary: it validates the
    // immutable migration inventory, runs unresolved-legacy data preflight,
    // attests an exact baseline with no migration table, and only then writes
    // the baseline metadata. Normal preflight must pass after that write before
    // any reviewed release migration is applied.
    try {
      await baselineResolver({ env: scopedEnv, confirmed: true });
      migrationPreflight(scopedEnv);
      await migrateDeploy({ env: scopedEnv });
    } catch (error) {
      throw new Error(
        safeCommandOutput(
          error instanceof Error ? error.message : "Legacy migration failed.",
          scopedUrl,
        ),
      );
    }
  }
  const attestation = await postflight({
    env: scopedEnv,
  });
  if (legacyBaseline) {
    console.log(
      `Legacy restore rehearsal passed: the immutable baseline, ${attestation.migrationCount} current migrations, ${coreTableCount} core tables, and the full schema were verified in schema ${applicationSchema} of ld2l_restore_test.`,
    );
  } else {
    console.log(
      `Restore rehearsal passed: ${migrationCount} migrations, ${coreTableCount} core tables, and the full schema were verified in schema ${applicationSchema} of ld2l_restore_test.`,
    );
  }
  return {
    applicationSchema,
    migrationCount,
    coreTableCount,
    attestation,
    legacyBaseline,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => parseRestoreArguments(process.argv.slice(2)))
    .then((options) => rehearseBackupRestore(options))
    .catch((error) => {
      console.error(
        `Restore rehearsal failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      process.exitCode = 1;
    });
}
