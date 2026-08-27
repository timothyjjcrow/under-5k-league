// Read-only production schema attestation. Prisma's migration history answers
// which SQL files ran; it does not prove that a current database still has
// every supported table/index/column, nor can Prisma model PostgreSQL-native
// functions, triggers, partial indexes, or CHECK constraints. This gate checks
// both layers after migrate deploy and after a backup restore.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MIGRATION_SHA256,
  validateMigrations,
} from "./migration-safety.mjs";
import { validateMigrationHistory } from "./migration-history.mjs";

const ROOT = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const APP_SCHEMA = new URL("prisma/schema.prisma", ROOT);
const PRISMA_CLI = new URL("node_modules/prisma/build/index.js", ROOT);
const RELEASE_SQL = Object.keys(MIGRATION_SHA256)
  .filter((name) => name !== "20260804000000_baseline")
  .sort()
  .map((name) =>
    readFileSync(
      new URL(`prisma/migrations/${name}/migration.sql`, ROOT),
      "utf8",
    ),
  )
  .join("\n");

export function normalizeSqlDefinition(value) {
  return value
    .replace(/--[^\n]*(?:\n|$)/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function releaseFunctionBody(name) {
  const functionStart = RELEASE_SQL.indexOf(`CREATE FUNCTION "${name}"()`);
  const bodyMarker = "AS $function$\n";
  const bodyStart = RELEASE_SQL.indexOf(bodyMarker, functionStart);
  const bodyEnd = RELEASE_SQL.indexOf("\n$function$;", bodyStart);
  if (functionStart < 0 || bodyStart < 0 || bodyEnd < 0) {
    throw new Error(`Could not read reviewed definition for ${name}`);
  }
  return normalizeSqlDefinition(
    RELEASE_SQL.slice(bodyStart + bodyMarker.length, bodyEnd),
  );
}

const functionNames = [
  "ld2l_lock_fantasy_after_game",
  "ld2l_preserve_inhouse_queue_time",
  "ld2l_stamp_inhouse_completion",
  "ld2l_stamp_match_completion",
  "ld2l_sync_legacy_dota_account_id",
];

export const EXPECTED_RELEASE_NATIVE = Object.freeze({
  functions: Object.freeze(
    Object.fromEntries(
      functionNames.map((name) => [
        name,
        Object.freeze({
          arguments: "",
          result: "trigger",
          language: "plpgsql",
          kind: "f",
          volatility: "v",
          securityDefiner: false,
          body: releaseFunctionBody(name),
        }),
      ]),
    ),
  ),
  triggers: Object.freeze({
    ld2l_lock_fantasy_after_game_trigger: Object.freeze({
      table: "Game",
      functionName: "ld2l_lock_fantasy_after_game",
      functionSchema: "current",
      timing: "AFTER",
      rowLevel: true,
      onInsert: true,
      onUpdate: false,
      onDelete: false,
      onTruncate: false,
      updateColumns: Object.freeze([]),
      argumentCount: 0,
      whenExpression: null,
      enabled: "O",
    }),
    ld2l_preserve_inhouse_queue_time_trigger: Object.freeze({
      table: "InhouseLobbyPlayer",
      functionName: "ld2l_preserve_inhouse_queue_time",
      functionSchema: "current",
      timing: "BEFORE",
      rowLevel: true,
      onInsert: true,
      onUpdate: false,
      onDelete: false,
      onTruncate: false,
      updateColumns: Object.freeze([]),
      argumentCount: 0,
      whenExpression: null,
      enabled: "O",
    }),
    ld2l_stamp_inhouse_completion_trigger: Object.freeze({
      table: "InhouseLobby",
      functionName: "ld2l_stamp_inhouse_completion",
      functionSchema: "current",
      timing: "BEFORE",
      rowLevel: true,
      onInsert: false,
      onUpdate: true,
      onDelete: false,
      onTruncate: false,
      updateColumns: Object.freeze(["status"]),
      argumentCount: 0,
      whenExpression: null,
      enabled: "O",
    }),
    ld2l_stamp_match_completion_trigger: Object.freeze({
      table: "Match",
      functionName: "ld2l_stamp_match_completion",
      functionSchema: "current",
      timing: "BEFORE",
      rowLevel: true,
      onInsert: true,
      onUpdate: true,
      onDelete: false,
      onTruncate: false,
      updateColumns: Object.freeze([
        "status",
        "homeScore",
        "awayScore",
        "winnerTeamId",
        "forfeit",
      ]),
      argumentCount: 0,
      whenExpression: null,
      enabled: "O",
    }),
    ld2l_sync_legacy_dota_account_id_trigger: Object.freeze({
      table: "User",
      functionName: "ld2l_sync_legacy_dota_account_id",
      functionSchema: "current",
      timing: "BEFORE",
      rowLevel: true,
      onInsert: true,
      onUpdate: true,
      onDelete: false,
      onTruncate: false,
      updateColumns: Object.freeze(["dotaAccountId"]),
      argumentCount: 0,
      whenExpression: null,
      enabled: "O",
    }),
  }),
  partialIndexes: Object.freeze({
    InhouseLobby_one_active_idx: Object.freeze({
      table: "InhouseLobby",
      unique: true,
      valid: true,
      ready: true,
      live: true,
      primary: false,
      accessMethod: "btree",
      expression: "1",
      predicate:
        "(status = ANY (ARRAY['READY_CHECK'::text, 'CAPTAIN_VOTE'::text, 'DRAFTING'::text, 'READY'::text, 'IN_PROGRESS'::text]))",
      keyCount: 1,
      attributeCount: 1,
    }),
    Season_one_active_idx: Object.freeze({
      table: "Season",
      unique: true,
      valid: true,
      ready: true,
      live: true,
      primary: false,
      accessMethod: "btree",
      expression: "1",
      predicate: '("isActive" IS TRUE)',
      keyCount: 1,
      attributeCount: 1,
    }),
  }),
  checks: Object.freeze({
    User_dotaAccountIdV2_uint32_check: Object.freeze({
      table: "User",
      definition:
        'CHECK ("dotaAccountIdV2" IS NULL OR "dotaAccountIdV2" > 0 AND "dotaAccountIdV2" <= 4294967295 AND "dotaAccountIdV2" = trunc("dotaAccountIdV2"))',
      validated: true,
      noInherit: false,
    }),
    User_dotaAccountId_unsigned_check: Object.freeze({
      table: "User",
      definition:
        'CHECK ("dotaAccountId" IS NULL OR "dotaAccountId" > 0)',
      validated: true,
      noInherit: false,
    }),
  }),
});

function canonicalCheckDefinition(value) {
  return normalizeSqlDefinition(value)
    .replace(/0::double precision/g, "0")
    .replace(/'4294967295'::bigint::double precision/g, "4294967295");
}

function exactObject(value) {
  return JSON.stringify(value);
}

function assertNamedObjects(kind, actualRows, expectedByName, shapeFor) {
  const actualNames = actualRows.map((row) => row.name).sort();
  const expectedNames = Object.keys(expectedByName).sort();
  if (exactObject(actualNames) !== exactObject(expectedNames)) {
    const missing = expectedNames.filter((name) => !actualNames.includes(name));
    const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
    throw new Error(
      `Postflight ${kind} inventory drift` +
        `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
        `${unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : ""}`,
    );
  }

  for (const row of actualRows) {
    const actualShape = shapeFor(row);
    const expectedShape = expectedByName[row.name];
    if (exactObject(actualShape) !== exactObject(expectedShape)) {
      throw new Error(`Postflight ${kind} definition drift: ${row.name}`);
    }
  }
}

export function validatePostflightSnapshot(snapshot) {
  const { migrationCount } = validateMigrationHistory(snapshot.migrations);

  assertNamedObjects(
    "function",
    snapshot.functions,
    EXPECTED_RELEASE_NATIVE.functions,
    (row) => ({
      arguments: row.arguments,
      result: row.result,
      language: row.language,
      kind: row.kind,
      volatility: row.volatility,
      securityDefiner: row.securityDefiner,
      body: normalizeSqlDefinition(row.body),
    }),
  );
  assertNamedObjects(
    "trigger",
    snapshot.triggers,
    EXPECTED_RELEASE_NATIVE.triggers,
    (row) => ({
      table: row.table,
      functionName: row.functionName,
      functionSchema:
        row.functionSchema === snapshot.schema ? "current" : row.functionSchema,
      timing: row.timing,
      rowLevel: row.rowLevel,
      onInsert: row.onInsert,
      onUpdate: row.onUpdate,
      onDelete: row.onDelete,
      onTruncate: row.onTruncate,
      updateColumns: row.updateColumns,
      argumentCount: row.argumentCount,
      whenExpression: row.whenExpression,
      enabled: row.enabled,
    }),
  );
  assertNamedObjects(
    "partial index",
    snapshot.partialIndexes,
    EXPECTED_RELEASE_NATIVE.partialIndexes,
    (row) => ({
      table: row.table,
      unique: row.unique,
      valid: row.valid,
      ready: row.ready,
      live: row.live,
      primary: row.primary,
      accessMethod: row.accessMethod,
      expression: normalizeSqlDefinition(row.expression ?? ""),
      predicate: normalizeSqlDefinition(row.predicate ?? ""),
      keyCount: row.keyCount,
      attributeCount: row.attributeCount,
    }),
  );
  assertNamedObjects(
    "CHECK constraint",
    snapshot.checks,
    EXPECTED_RELEASE_NATIVE.checks,
    (row) => ({
      table: row.table,
      definition: canonicalCheckDefinition(row.definition),
      validated: row.validated,
      noInherit: row.noInherit,
    }),
  );

  return {
    schema: snapshot.schema,
    migrationCount,
    nativeObjectCount:
      snapshot.functions.length +
      snapshot.triggers.length +
      snapshot.partialIndexes.length +
      snapshot.checks.length,
  };
}

export function postgresDatamodel(source) {
  const datasource = [
    "datasource db {",
    '  provider  = "postgresql"',
    '  url       = env("DATABASE_URL")',
    '  directUrl = env("DIRECT_URL")',
    "}",
  ].join("\n");
  const next = source.replace(/datasource db \{[\s\S]*?\n\}/, datasource);
  if (next === source && !source.includes(datasource)) {
    throw new Error("Could not isolate the Prisma datasource for postflight");
  }
  return next;
}

function selectedUrl(env) {
  const raw = env.DIRECT_URL ?? env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DIRECT_URL (preferred) or DATABASE_URL is required for migration postflight",
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Migration postflight database URL is invalid");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Migration postflight only supports PostgreSQL URLs");
  }
  if (!env.DIRECT_URL && parsed.searchParams.get("pgbouncer") === "true") {
    throw new Error(
      "DIRECT_URL is required when DATABASE_URL uses PgBouncer transaction pooling",
    );
  }
  return raw;
}

function safeMessage(value, url) {
  let message = String(value ?? "");
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
    // selectedUrl already validates the URL; this is only defense in depth.
  }
  return message;
}

function runPrisma(args, env) {
  return spawnSync(process.execPath, [fileURLToPath(PRISMA_CLI), ...args], {
    cwd: ROOT_PATH,
    env,
    encoding: "utf8",
  });
}

async function readCatalog(url, env, temporary) {
  const inspectorSchema = path.join(temporary, "inspector.schema.prisma");
  writeFileSync(
    inspectorSchema,
    `generator client {
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

  @@map("__ld2l_postflight_bootstrap_never_created")
}
`,
  );
  const generated = runPrisma(["generate", "--schema", inspectorSchema], env);
  if (generated.status !== 0) {
    throw new Error(
      `Could not create isolated PostgreSQL postflight inspector:\n${safeMessage(
        `${generated.stdout ?? ""}${generated.stderr ?? ""}`,
        url,
      )}`,
    );
  }

  const { PrismaClient } = await import(
    pathToFileURL(path.join(temporary, "client", "index.js")).href
  );
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const [{ schema, migrationTableExists }] = await client.$queryRawUnsafe(`
      SELECT
        current_schema()::text AS "schema",
        to_regclass(format('%I.%I', current_schema(), '_prisma_migrations')) IS NOT NULL
          AS "migrationTableExists"
    `);
    if (!migrationTableExists) {
      throw new Error(
        `Postflight found no _prisma_migrations table in application schema ${schema}`,
      );
    }

    const migrations = await client.$queryRawUnsafe(`
      SELECT
        "migration_name"::text AS "name",
        "checksum"::text AS "checksum",
        "finished_at" IS NOT NULL AS "finished",
        "rolled_back_at" IS NOT NULL AS "rolledBack"
      FROM "_prisma_migrations"
      ORDER BY "migration_name", "started_at"
    `);
    const functions = await client.$queryRawUnsafe(`
      SELECT
        procedure.proname::text AS "name",
        pg_get_function_identity_arguments(procedure.oid)::text AS "arguments",
        pg_get_function_result(procedure.oid)::text AS "result",
        language.lanname::text AS "language",
        procedure.prokind::text AS "kind",
        procedure.provolatile::text AS "volatility",
        procedure.prosecdef AS "securityDefiner",
        procedure.prosrc::text AS "body"
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      INNER JOIN pg_catalog.pg_language AS language
        ON language.oid = procedure.prolang
      WHERE namespace.nspname = current_schema()
      ORDER BY procedure.proname, pg_get_function_identity_arguments(procedure.oid)
    `);
    const triggers = await client.$queryRawUnsafe(`
      SELECT
        trigger_row.tgname::text AS "name",
        relation.relname::text AS "table",
        trigger_function.proname::text AS "functionName",
        function_namespace.nspname::text AS "functionSchema",
        CASE
          WHEN (trigger_row.tgtype & 64) <> 0 THEN 'INSTEAD OF'
          WHEN (trigger_row.tgtype & 2) <> 0 THEN 'BEFORE'
          ELSE 'AFTER'
        END::text AS "timing",
        (trigger_row.tgtype & 1) <> 0 AS "rowLevel",
        (trigger_row.tgtype & 4) <> 0 AS "onInsert",
        (trigger_row.tgtype & 16) <> 0 AS "onUpdate",
        (trigger_row.tgtype & 8) <> 0 AS "onDelete",
        (trigger_row.tgtype & 32) <> 0 AS "onTruncate",
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(trigger_row.tgattr::smallint[]) WITH ORDINALITY
            AS update_attribute(attribute_number, ordinal)
          INNER JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = trigger_row.tgrelid
           AND attribute.attnum = update_attribute.attribute_number
          ORDER BY update_attribute.ordinal
        )::text[] AS "updateColumns",
        trigger_row.tgnargs::integer AS "argumentCount",
        pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid)::text
          AS "whenExpression",
        trigger_row.tgenabled::text AS "enabled"
      FROM pg_catalog.pg_trigger AS trigger_row
      INNER JOIN pg_catalog.pg_class AS relation
        ON relation.oid = trigger_row.tgrelid
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      INNER JOIN pg_catalog.pg_proc AS trigger_function
        ON trigger_function.oid = trigger_row.tgfoid
      INNER JOIN pg_catalog.pg_namespace AS function_namespace
        ON function_namespace.oid = trigger_function.pronamespace
      WHERE namespace.nspname = current_schema()
        AND NOT trigger_row.tgisinternal
      ORDER BY trigger_row.tgname
    `);
    const partialIndexes = await client.$queryRawUnsafe(`
      SELECT
        index_relation.relname::text AS "name",
        table_relation.relname::text AS "table",
        index_row.indisunique AS "unique",
        index_row.indisvalid AS "valid",
        index_row.indisready AS "ready",
        index_row.indislive AS "live",
        index_row.indisprimary AS "primary",
        access_method.amname::text AS "accessMethod",
        pg_get_expr(index_row.indexprs, index_row.indrelid)::text AS "expression",
        pg_get_expr(index_row.indpred, index_row.indrelid)::text AS "predicate",
        index_row.indnkeyatts::integer AS "keyCount",
        index_row.indnatts::integer AS "attributeCount"
      FROM pg_catalog.pg_index AS index_row
      INNER JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      INNER JOIN pg_catalog.pg_class AS table_relation
        ON table_relation.oid = index_row.indrelid
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = table_relation.relnamespace
      INNER JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE namespace.nspname = current_schema()
        AND index_row.indpred IS NOT NULL
      ORDER BY index_relation.relname
    `);
    const checks = await client.$queryRawUnsafe(`
      SELECT
        constraint_row.conname::text AS "name",
        relation.relname::text AS "table",
        pg_get_constraintdef(constraint_row.oid, true)::text AS "definition",
        constraint_row.convalidated AS "validated",
        constraint_row.connoinherit AS "noInherit"
      FROM pg_catalog.pg_constraint AS constraint_row
      INNER JOIN pg_catalog.pg_class AS relation
        ON relation.oid = constraint_row.conrelid
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND constraint_row.contype = 'c'
      ORDER BY constraint_row.conname
    `);

    return { schema, migrations, functions, triggers, partialIndexes, checks };
  } finally {
    await client.$disconnect();
  }
}

export async function inspectPostflightDatabase({ env = process.env } = {}) {
  validateMigrations();
  const url = selectedUrl(env);
  const childEnv = { ...env, DATABASE_URL: url, DIRECT_URL: url };
  const temporary = mkdtempSync(path.join(tmpdir(), "ld2l-postflight-"));
  symlinkSync(
    fileURLToPath(new URL("node_modules/", ROOT)),
    path.join(temporary, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const applicationSchema = path.join(temporary, "application.schema.prisma");
  writeFileSync(
    applicationSchema,
    postgresDatamodel(readFileSync(APP_SCHEMA, "utf8")),
  );

  try {
    const diff = runPrisma(
      [
        "migrate",
        "diff",
        "--exit-code",
        "--from-schema-datasource",
        applicationSchema,
        "--to-schema-datamodel",
        applicationSchema,
      ],
      childEnv,
    );
    const diffOutput = safeMessage(
      `${diff.stdout ?? ""}${diff.stderr ?? ""}`.trim(),
      url,
    );
    if (diff.status === 2) {
      throw new Error(
        `Postflight Prisma schema drift detected${diffOutput ? `:\n${diffOutput}` : ""}`,
      );
    }
    if (diff.status !== 0) {
      throw new Error(
        `Postflight could not compare the database schema${diffOutput ? `:\n${diffOutput}` : ""}`,
      );
    }

    const snapshot = await readCatalog(url, childEnv, temporary);
    return validatePostflightSnapshot(snapshot);
  } catch (error) {
    const message = safeMessage(
      error instanceof Error ? error.message : "unknown postflight error",
      url,
    );
    throw new Error(message);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inspectPostflightDatabase()
    .then(({ schema, migrationCount, nativeObjectCount }) => {
      console.log(
        `Migration postflight passed in schema ${schema}: ${migrationCount} migrations and ${nativeObjectCount} native objects verified.`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
