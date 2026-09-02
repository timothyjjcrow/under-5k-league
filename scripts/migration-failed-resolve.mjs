import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoPrismaDotenvFiles } from "./release-migrations.mjs";
import { MIGRATION_SHA256, validateMigrations } from "./migration-safety.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS = fileURLToPath(
  new URL("../prisma/migrations/", import.meta.url),
);
const PRISMA_CLI = fileURLToPath(
  new URL("../node_modules/prisma/build/index.js", import.meta.url),
);
const NODE_MODULES = fileURLToPath(
  new URL("../node_modules/", import.meta.url),
);

export const FAILED_MIGRATION_TARGET =
  "20260831000000_inhouse_queue_idle_timeout";
export const PINNED_PRISMA_VERSION = "5.22.0";
const FULL_SHA = /^[0-9a-f]{40}$/;

function gitOutput(args) {
  return execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function authorizeFailedMigrationResolve({
  argv,
  env,
  headSha,
  status,
}) {
  if (
    argv.length !== 3 ||
    argv[0] !== "--apply" ||
    !FULL_SHA.test(argv[1] ?? "") ||
    argv[2] !== FAILED_MIGRATION_TARGET
  ) {
    throw new Error(
      `Usage: npm run db:migrate:failed-resolve -- --apply <40-character-current-HEAD-sha> ${FAILED_MIGRATION_TARGET}`,
    );
  }
  if (env.VERCEL_ENV !== "production") {
    throw new Error(
      "Failed-migration resolve requires VERCEL_ENV=production; preview, development, and unset environments are read-only",
    );
  }
  if (!FULL_SHA.test(headSha)) {
    throw new Error("Could not resolve the current 40-character Git HEAD SHA");
  }
  if (argv[1] !== headSha) {
    throw new Error(
      `Failed-migration resolve approval SHA does not match current HEAD ${headSha}`,
    );
  }
  if (status.trim()) {
    throw new Error(
      "Failed-migration resolve requires a clean checkout with no staged, unstaged, or untracked files",
    );
  }
  return { approvedSha: headSha, migrationName: FAILED_MIGRATION_TARGET };
}

export function directMigrationUrl(env) {
  const raw = env.DIRECT_URL;
  if (!raw) {
    throw new Error(
      "DIRECT_URL is required for failed-migration recovery; pooled DATABASE_URL fallback is forbidden",
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Failed-migration recovery DIRECT_URL is invalid");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(
      "Failed-migration recovery only supports a direct PostgreSQL URL",
    );
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const firstLabel = hostname.split(".")[0];
  if (
    parsed.searchParams.get("pgbouncer")?.toLowerCase() === "true" ||
    firstLabel.endsWith("-pooler") ||
    hostname.endsWith(".pooler.supabase.com")
  ) {
    throw new Error(
      "Failed-migration recovery DIRECT_URL must use a direct PostgreSQL endpoint, not a pooler",
    );
  }
  return raw;
}

export function assertPinnedPrismaVersion(version) {
  if (version !== PINNED_PRISMA_VERSION) {
    throw new Error(
      `Failed-migration recovery requires pinned Prisma ${PINNED_PRISMA_VERSION}`,
    );
  }
}

function safeMessage(value, url) {
  let message = String(value ?? "unknown failed-migration recovery error");
  message = message.split(url).join("[database URL]");
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      const passwords = new Set([parsed.password]);
      try {
        passwords.add(decodeURIComponent(parsed.password));
      } catch {
        // The encoded form is still redacted below.
      }
      for (const password of passwords) {
        message = message.split(password).join("[password]");
      }
    }
  } catch {
    // directMigrationUrl already validates this URL; this is defense in depth.
  }
  return message;
}

function unresolved(row) {
  return !row.finished && !row.rolledBack;
}

function completed(row) {
  return row.finished && !row.rolledBack;
}

function validateReviewedLedger(rows) {
  const reviewedNames = Object.keys(MIGRATION_SHA256);
  for (const row of rows) {
    const expectedChecksum = MIGRATION_SHA256[row.name];
    if (!expectedChecksum) {
      throw new Error(
        `Failed-migration recovery found unknown migration ${row.name}`,
      );
    }
    if (row.checksum !== expectedChecksum) {
      throw new Error(`Failed-migration recovery checksum drift: ${row.name}`);
    }
    if (row.finished && row.rolledBack) {
      throw new Error(
        `Failed-migration recovery found an invalid finished-and-rolled-back row: ${row.name}`,
      );
    }
  }

  for (const name of reviewedNames) {
    if (name === FAILED_MIGRATION_TARGET) continue;
    const finishedRows = rows.filter(
      (row) => row.name === name && completed(row),
    );
    if (finishedRows.length !== 1) {
      throw new Error(
        `Failed-migration recovery requires exactly one completed ${name} migration row`,
      );
    }
  }
}

function assertCatalogRolledBack(catalog) {
  if (!catalog.queueTableExists) {
    throw new Error(
      "Failed-migration recovery could not find InhouseQueueEntry in the current schema",
    );
  }
  const present = [];
  if (catalog.idleExpiresAtCount !== 0) present.push("idleExpiresAt column");
  if (catalog.refreshFunctionCount !== 0) present.push("refresh function");
  if (catalog.insertTriggerCount !== 0) present.push("insert trigger");
  if (catalog.deleteTriggerCount !== 0) present.push("delete trigger");
  if (present.length > 0) {
    throw new Error(
      `Failed-migration recovery refuses partially applied catalog objects: ${present.join(", ")}`,
    );
  }
  if (
    !catalog.canOwnQueueTable ||
    !catalog.canCreateInSchema ||
    !catalog.canTriggerQueueTable
  ) {
    throw new Error(
      "Failed-migration recovery requires the direct migration role to own the queue table (or inherit its owner) and have schema CREATE and table TRIGGER privileges",
    );
  }
}

export function validateFailedMigrationSnapshot(snapshot) {
  validateReviewedLedger(snapshot.migrations);
  const targetRows = snapshot.migrations.filter(
    (row) => row.name === FAILED_MIGRATION_TARGET,
  );
  if (targetRows.some((row) => row.finished)) {
    throw new Error(
      "Failed-migration recovery refuses a target with any finished migration row",
    );
  }
  const unresolvedRows = snapshot.migrations.filter(unresolved);
  if (
    unresolvedRows.length !== 1 ||
    unresolvedRows[0].name !== FAILED_MIGRATION_TARGET
  ) {
    throw new Error(
      `Failed-migration recovery requires exactly one unresolved ${FAILED_MIGRATION_TARGET} attempt and no other unfinished migration`,
    );
  }
  const [failed] = unresolvedRows;
  if (failed.checksum !== MIGRATION_SHA256[FAILED_MIGRATION_TARGET]) {
    throw new Error("Failed-migration recovery target checksum does not match");
  }
  if (failed.appliedSteps !== 0) {
    throw new Error(
      "Failed-migration recovery requires zero recorded applied steps",
    );
  }
  assertCatalogRolledBack(snapshot.catalog);
  return failed.id;
}

function stableRow(row) {
  return {
    id: row.id,
    name: row.name,
    checksum: row.checksum,
    finished: row.finished,
    rolledBack: row.rolledBack,
    appliedSteps: row.appliedSteps,
  };
}

export function validateResolvedMigrationSnapshot(before, after, failedId) {
  validateReviewedLedger(after.migrations);
  assertCatalogRolledBack(after.catalog);

  if (JSON.stringify(before.catalog) !== JSON.stringify(after.catalog)) {
    throw new Error(
      "Failed-migration recovery unexpectedly changed the application catalog",
    );
  }
  if (before.migrations.length !== after.migrations.length) {
    throw new Error(
      "Failed-migration recovery unexpectedly changed the migration-row count",
    );
  }

  const beforeById = new Map(
    before.migrations.map((row) => [row.id, stableRow(row)]),
  );
  for (const row of after.migrations) {
    const prior = beforeById.get(row.id);
    if (!prior) {
      throw new Error(
        "Failed-migration recovery unexpectedly inserted a migration row",
      );
    }
    const expected =
      row.id === failedId ? { ...prior, rolledBack: true } : prior;
    if (JSON.stringify(stableRow(row)) !== JSON.stringify(expected)) {
      throw new Error(
        `Failed-migration recovery changed unexpected ledger fields for ${row.name}`,
      );
    }
  }

  const targetRows = after.migrations.filter(
    (row) => row.name === FAILED_MIGRATION_TARGET,
  );
  const resolved = targetRows.filter(
    (row) => row.id === failedId && !row.finished && row.rolledBack,
  );
  if (
    resolved.length !== 1 ||
    targetRows.some(unresolved) ||
    targetRows.some((row) => row.finished)
  ) {
    throw new Error(
      "Failed-migration recovery did not resolve exactly the approved failed attempt as rolled back",
    );
  }
}

function postgresInspectorSchema() {
  return `generator client {
  provider = "prisma-client-js"
  output   = "./client"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

model InspectorBootstrap {
  id Int @id

  @@map("__ld2l_failed_resolve_bootstrap_never_created")
}
`;
}

async function readSnapshot(client) {
  const migrations = await client.$queryRawUnsafe(`
    SELECT
      "id"::text AS "id",
      "migration_name"::text AS "name",
      "checksum"::text AS "checksum",
      "finished_at" IS NOT NULL AS "finished",
      "rolled_back_at" IS NOT NULL AS "rolledBack",
      "applied_steps_count"::integer AS "appliedSteps"
    FROM "_prisma_migrations"
    ORDER BY "started_at", "id"
  `);
  const [catalog] = await client.$queryRawUnsafe(`
    SELECT
      to_regclass(format('%I.%I', current_schema(), 'InhouseQueueEntry'))
        IS NOT NULL AS "queueTableExists",
      (SELECT COUNT(*)::integer
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'InhouseQueueEntry'
         AND column_name = 'idleExpiresAt') AS "idleExpiresAtCount",
      (SELECT COUNT(*)::integer
       FROM pg_catalog.pg_proc AS procedure
       INNER JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = current_schema()
         AND procedure.proname = 'ld2l_refresh_inhouse_queue_idle_deadline')
        AS "refreshFunctionCount",
      (SELECT COUNT(*)::integer
       FROM pg_catalog.pg_trigger AS trigger
       INNER JOIN pg_catalog.pg_class AS relation
         ON relation.oid = trigger.tgrelid
       INNER JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = current_schema()
         AND trigger.tgname =
           'ld2l_refresh_inhouse_queue_idle_deadline_insert_trigger'
         AND NOT trigger.tgisinternal) AS "insertTriggerCount",
      (SELECT COUNT(*)::integer
       FROM pg_catalog.pg_trigger AS trigger
       INNER JOIN pg_catalog.pg_class AS relation
         ON relation.oid = trigger.tgrelid
       INNER JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = current_schema()
         AND trigger.tgname =
           'ld2l_refresh_inhouse_queue_idle_deadline_delete_trigger'
         AND NOT trigger.tgisinternal) AS "deleteTriggerCount",
      COALESCE((
        SELECT pg_has_role(current_user, relation.relowner, 'USAGE')
        FROM pg_catalog.pg_class AS relation
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = current_schema()
          AND relation.relname = 'InhouseQueueEntry'
          AND relation.relkind IN ('r', 'p')
      ), FALSE) AS "canOwnQueueTable",
      has_schema_privilege(current_user, current_schema(), 'CREATE')
        AS "canCreateInSchema",
      COALESCE((
        SELECT has_table_privilege(current_user, relation.oid, 'TRIGGER')
        FROM pg_catalog.pg_class AS relation
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = current_schema()
          AND relation.relname = 'InhouseQueueEntry'
          AND relation.relkind IN ('r', 'p')
      ), FALSE) AS "canTriggerQueueTable"
  `);
  return { migrations, catalog };
}

function runPrisma(args, { env, schemaPath }) {
  return spawnSync(
    process.execPath,
    [PRISMA_CLI, ...args, "--schema", schemaPath],
    {
      cwd: ROOT,
      env,
      encoding: "utf8",
    },
  );
}

function generatedPrismaDiagnostics(result, url) {
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  return safeMessage(output, url);
}

function createInspectorWorkspace({ env, url }) {
  const temporary = mkdtempSync(path.join(tmpdir(), "ld2l-failed-resolve-"));
  const schemaPath = path.join(temporary, "schema.prisma");
  const childEnv = { ...env, DATABASE_URL: url, DIRECT_URL: url };
  try {
    // Prisma 5.22 resolves @prisma/client relative to the temporary schema.
    // Expose the already-installed, pinned dependencies without installing or
    // generating anything in the clean release checkout.
    symlinkSync(
      NODE_MODULES,
      path.join(temporary, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeFileSync(schemaPath, postgresInspectorSchema(), {
      encoding: "utf8",
      mode: 0o600,
    });
    cpSync(MIGRATIONS, path.join(temporary, "migrations"), {
      recursive: true,
    });
    const generated = runPrisma(["generate"], { env: childEnv, schemaPath });
    if (generated.status !== 0) {
      const diagnostics = generatedPrismaDiagnostics(generated, url);
      throw new Error(
        `Could not generate the isolated failed-migration inspector${
          diagnostics ? `:\n${diagnostics}` : "."
        }`,
      );
    }
    return { temporary, schemaPath, childEnv };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function verifyFailedMigrationInspectorGeneration({
  env = process.env,
  url = directMigrationUrl(env),
} = {}) {
  const workspace = createInspectorWorkspace({ env, url });
  try {
    if (!existsSync(path.join(workspace.temporary, "client", "index.js"))) {
      throw new Error(
        "The isolated failed-migration inspector generated no client entry point",
      );
    }
  } finally {
    rmSync(workspace.temporary, { recursive: true, force: true });
  }
}

async function withInspector({ env, url }, work) {
  const workspace = createInspectorWorkspace({ env, url });
  try {
    const { PrismaClient } = await import(
      pathToFileURL(path.join(workspace.temporary, "client", "index.js")).href
    );
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      return await work({
        inspect: () => readSnapshot(client),
        resolve: () => {
          const result = runPrisma(
            ["migrate", "resolve", "--rolled-back", FAILED_MIGRATION_TARGET],
            {
              env: workspace.childEnv,
              schemaPath: workspace.schemaPath,
            },
          );
          if (result.status !== 0) {
            throw new Error(
              "Prisma failed to record the approved migration attempt as rolled back",
            );
          }
        },
      });
    } finally {
      await client.$disconnect();
    }
  } finally {
    rmSync(workspace.temporary, { recursive: true, force: true });
  }
}

export async function runFailedMigrationResolve({
  argv = process.argv.slice(2),
  env = process.env,
  headSha,
  status,
  fileExists = existsSync,
  migrationValidator = validateMigrations,
  prismaVersion,
  inspect,
  resolve,
} = {}) {
  let resolvedHead = headSha;
  let resolvedStatus = status;
  if (resolvedHead === undefined || resolvedStatus === undefined) {
    try {
      resolvedHead ??= gitOutput(["rev-parse", "HEAD"]);
      resolvedStatus ??= gitOutput([
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
    } catch {
      throw new Error(
        "Failed-migration recovery must run from a valid Git checkout",
      );
    }
  }
  const authorization = authorizeFailedMigrationResolve({
    argv,
    env,
    headSha: resolvedHead,
    status: resolvedStatus,
  });
  assertNoPrismaDotenvFiles(fileExists);
  migrationValidator();
  const installedPrismaVersion =
    prismaVersion ??
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../node_modules/prisma/package.json", import.meta.url),
        ),
        "utf8",
      ),
    ).version;
  assertPinnedPrismaVersion(installedPrismaVersion);
  const url = directMigrationUrl(env);

  const recover = async (database) => {
    const before = await database.inspect();
    const failedId = validateFailedMigrationSnapshot(before);
    await database.resolve();
    const after = await database.inspect();
    validateResolvedMigrationSnapshot(before, after, failedId);
    return authorization;
  };

  try {
    if (inspect && resolve) {
      return await recover({ inspect, resolve });
    }
    if (inspect || resolve) {
      throw new Error(
        "Failed-migration recovery test hooks must provide both inspect and resolve",
      );
    }
    return await withInspector({ env, url }, recover);
  } catch (error) {
    throw new Error(
      safeMessage(
        error instanceof Error
          ? error.message
          : "unknown failed-migration recovery error",
        url,
      ),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runFailedMigrationResolve()
    .then(({ approvedSha, migrationName }) => {
      console.log(
        `Failed migration ${migrationName} was verified fully rolled back and its failed attempt was resolved for ${approvedSha}.`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
