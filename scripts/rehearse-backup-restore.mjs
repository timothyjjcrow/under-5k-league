// Restore one verified plain-text pg_dump into an exact localhost scratch DB.
// The destructive target is deliberately non-configurable beyond the guarded
// URL: this is a release rehearsal, never a production restore command.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { postgresCliEnv } from "../src/lib/postgres-cli-env.mjs";
import { inspectPostflightDatabase } from "./migration-postflight.mjs";
import { assertLocalRestorePostgresUrl } from "./test-db-safety.mjs";

const verifyScript = fileURLToPath(new URL("./verify-backup.mjs", import.meta.url));

export function postgresUrlForSchema(raw, schema) {
  const parsed = new URL(raw);
  parsed.searchParams.set("schema", schema);
  return parsed.toString();
}

export async function rehearseBackupRestore({
  backupArgument = process.argv[2],
  restoreUrl = process.env.PG_RESTORE_TEST_URL,
  env = process.env,
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

  const schemaOutput = execFileSync(
    "psql",
    [
      "-X",
      "--set=ON_ERROR_STOP=on",
      "--tuples-only",
      "--no-align",
      "--command",
      `SELECT namespace.nspname
       FROM pg_catalog.pg_class AS relation
       INNER JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       WHERE relation.relname = '_prisma_migrations'
         AND relation.relkind IN ('r', 'p')
         AND namespace.nspname <> 'information_schema'
         AND namespace.nspname !~ '^pg_'
       ORDER BY namespace.nspname`,
    ],
    { encoding: "utf8", env: restoreEnv },
  ).trim();
  const applicationSchemas = schemaOutput
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (applicationSchemas.length !== 1) {
    throw new Error(
      `Restored database must contain exactly one non-system schema with _prisma_migrations; found ${applicationSchemas.length}.`,
    );
  }
  const [applicationSchema] = applicationSchemas;

  // Feed this query on stdin so psql safely quotes the discovered value as
  // both an identifier and a string. `--command` does not expand psql
  // variables, and interpolating an arbitrary PostgreSQL identifier in JS
  // would turn a restore check into an injection surface.
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
      input: `SELECT
        (SELECT COUNT(*) FROM :"league_schema"."_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
        (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_schema = :'league_schema'
            AND table_name IN ('User', 'Season', 'Setting'));
`,
    },
  ).trim();
  const [migrationCount, coreTableCount] = smoke
    .split("|")
    .map((value) => Number(value));
  if (migrationCount < 2 || coreTableCount !== 3) {
    throw new Error(
      "Restored database is missing completed release migrations or core league tables.",
    );
  }

  // The smoke query gives an immediate restore-format diagnostic. The full
  // postflight then verifies every Prisma-supported object and every reviewed
  // PostgreSQL-native object in the schema actually discovered from the dump.
  const scopedUrl = postgresUrlForSchema(restoreUrl, applicationSchema);
  const attestation = await postflight({
    env: { ...env, DATABASE_URL: scopedUrl, DIRECT_URL: scopedUrl },
  });
  console.log(
    `Restore rehearsal passed: ${migrationCount} migrations, ${coreTableCount} core tables, and the full schema were verified in schema ${applicationSchema} of ld2l_restore_test.`,
  );
  return {
    applicationSchema,
    migrationCount,
    coreTableCount,
    attestation,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  rehearseBackupRestore().catch((error) => {
    console.error(
      `Restore rehearsal failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
