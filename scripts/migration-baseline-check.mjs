import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  BASELINE_SCHEMA_SHA256,
  validateMigrations,
} from "./migration-safety.mjs";

const ROOT = new URL("../", import.meta.url);
const PRISMA_CLI = new URL("node_modules/prisma/build/index.js", ROOT);
const BASELINE_SCHEMA = new URL(
  "prisma/migrations/20260804000000_baseline/baseline.schema.prisma",
  ROOT,
);

// SHA-256 of the immutable pre-release PostgreSQL datamodel. The actual
// database must also produce an empty Prisma semantic diff against this file.
export const EXPECTED_BASELINE_FINGERPRINT = BASELINE_SCHEMA_SHA256;

function selectedUrl(env = process.env) {
  const raw = env.DIRECT_URL ?? env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DIRECT_URL (preferred) or DATABASE_URL is required for the baseline check",
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Baseline check database URL is invalid");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Baseline check only supports PostgreSQL URLs");
  }
  if (!env.DIRECT_URL && parsed.searchParams.get("pgbouncer") === "true") {
    throw new Error(
      "DIRECT_URL is required when DATABASE_URL uses PgBouncer transaction pooling",
    );
  }
  return raw;
}

function runPrisma(args, env) {
  return spawnSync(process.execPath, [fileURLToPath(PRISMA_CLI), ...args], {
    cwd: fileURLToPath(ROOT),
    env,
    encoding: "utf8",
  });
}

async function inspectUnsupportedObjects(url, env) {
  // Prisma 5.22 requires @prisma/client below its inferred project root. Keep
  // generated artifacts outside the worktree and expose the already-installed
  // dependencies through a temporary link, preventing both network installs
  // and untracked files if the process is interrupted.
  const temporary = mkdtempSync(path.join(tmpdir(), "ld2l-baseline-client-"));
  symlinkSync(
    fileURLToPath(new URL("node_modules/", ROOT)),
    path.join(temporary, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const schemaPath = path.join(temporary, "schema.prisma");
  writeFileSync(
    schemaPath,
    `generator client {
  provider = "prisma-client-js"
  output   = "./client"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Prisma 5.22 requires one model before it will generate a raw-query client.
// The baseline inspector never queries or creates this deliberately absent
// table; all reads use $queryRawUnsafe against PostgreSQL catalogs.
model InspectorBootstrap {
  id Int @id

  @@map("__ld2l_inspector_bootstrap_never_created")
}
`,
  );

  try {
    const generated = runPrisma(["generate", "--schema", schemaPath], env);
    if (generated.status !== 0) {
      throw new Error(
        `Could not create isolated PostgreSQL inspector:\n${generated.stdout ?? ""}${generated.stderr ?? ""}`,
      );
    }
    const { PrismaClient } = await import(
      pathToFileURL(path.join(temporary, "client", "index.js")).href
    );
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      const [{ migration_table_exists: migrationTableExists }] =
        await client.$queryRawUnsafe(
          `SELECT to_regclass(format('%I.%I', current_schema(), '_prisma_migrations')) IS NOT NULL
             AS migration_table_exists`,
        );
      if (migrationTableExists) {
        throw new Error(
          "Refusing baseline resolve: _prisma_migrations already exists; investigate migration history before changing it",
        );
      }

      // Prisma Migrate compares all supported relational objects. Explicitly
      // reject unsupported PostgreSQL objects too, so an extra view, sequence,
      // trigger, function, policy, enum or domain cannot slip past the semantic
      // diff. The baseline uses cuid text ids and has none of these objects.
      const unsupported = await client.$queryRawUnsafe(`
        SELECT kind, name
        FROM (
          SELECT
            CASE cls.relkind
              WHEN 'S' THEN 'sequence'
              WHEN 'v' THEN 'view'
              WHEN 'm' THEN 'materialized view'
              WHEN 'f' THEN 'foreign table'
              WHEN 'p' THEN 'partitioned table'
              ELSE 'unsupported relation'
            END AS kind,
            cls.relname::text AS name
          FROM pg_class AS cls
          INNER JOIN pg_namespace AS ns ON ns.oid = cls.relnamespace
          WHERE ns.nspname = current_schema()
            AND cls.relkind IN ('S', 'v', 'm', 'f', 'p')

          UNION ALL

          SELECT 'function'::text, proc.proname::text
          FROM pg_proc AS proc
          INNER JOIN pg_namespace AS ns ON ns.oid = proc.pronamespace
          WHERE ns.nspname = current_schema()

          UNION ALL

          SELECT 'trigger'::text, trigger_row.tgname::text
          FROM pg_trigger AS trigger_row
          INNER JOIN pg_class AS cls ON cls.oid = trigger_row.tgrelid
          INNER JOIN pg_namespace AS ns ON ns.oid = cls.relnamespace
          WHERE ns.nspname = current_schema()
            AND NOT trigger_row.tgisinternal

          UNION ALL

          SELECT
            CASE pg_type.typtype WHEN 'e' THEN 'enum' ELSE 'domain' END,
            pg_type.typname::text
          FROM pg_type
          INNER JOIN pg_namespace AS ns ON ns.oid = pg_type.typnamespace
          WHERE ns.nspname = current_schema()
            AND pg_type.typtype IN ('e', 'd')

          UNION ALL

          SELECT 'row security policy'::text, policy.polname::text
          FROM pg_policy AS policy
          INNER JOIN pg_class AS cls ON cls.oid = policy.polrelid
          INNER JOIN pg_namespace AS ns ON ns.oid = cls.relnamespace
          WHERE ns.nspname = current_schema()

          UNION ALL

          SELECT 'row security enabled table'::text, cls.relname::text
          FROM pg_class AS cls
          INNER JOIN pg_namespace AS ns ON ns.oid = cls.relnamespace
          WHERE ns.nspname = current_schema()
            AND (cls.relrowsecurity OR cls.relforcerowsecurity)
        ) AS unsupported_objects
        ORDER BY kind, name
      `);
      if (unsupported.length > 0) {
        throw new Error(
          `Existing database contains objects outside the immutable baseline: ${unsupported
            .map((row) => `${row.kind} ${row.name}`)
            .join(", ")}`,
        );
      }
    } finally {
      await client.$disconnect();
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function inspectBaselineDatabase({ env = process.env } = {}) {
  validateMigrations();
  const url = selectedUrl(env);
  const baseline = readFileSync(BASELINE_SCHEMA);
  const actualFingerprint = createHash("sha256").update(baseline).digest("hex");
  if (
    EXPECTED_BASELINE_FINGERPRINT !== "PENDING" &&
    actualFingerprint !== EXPECTED_BASELINE_FINGERPRINT
  ) {
    throw new Error(
      `Immutable baseline datamodel checksum mismatch (expected ${EXPECTED_BASELINE_FINGERPRINT}, received ${actualFingerprint})`,
    );
  }

  const childEnv = { ...env, DATABASE_URL: url, DIRECT_URL: url };
  await inspectUnsupportedObjects(url, childEnv);
  const diff = runPrisma(
    [
      "migrate",
      "diff",
      "--exit-code",
      "--from-schema-datasource",
      fileURLToPath(BASELINE_SCHEMA),
      "--to-schema-datamodel",
      fileURLToPath(BASELINE_SCHEMA),
    ],
    childEnv,
  );
  if (diff.status === 2) {
    throw new Error(
      `Existing database does not match the immutable baseline:\n${diff.stdout ?? ""}${diff.stderr ?? ""}`,
    );
  }
  if (diff.status !== 0) {
    throw new Error(
      `Could not compare the existing database to the immutable baseline:\n${diff.stdout ?? ""}${diff.stderr ?? ""}`,
    );
  }
  return { actualFingerprint };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inspectBaselineDatabase()
    .then(({ actualFingerprint }) => {
      console.log(`Baseline schema verified (${actualFingerprint}).`);
      console.log(
        "It is safe to record 20260804000000_baseline as applied; no migration was changed by this check.",
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
