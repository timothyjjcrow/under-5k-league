import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectBaselineDatabase } from "./migration-baseline-check.mjs";
import { runMigrationPreflight } from "./migration-preflight.mjs";
import { validateMigrations } from "./migration-safety.mjs";

const ROOT = new URL("../", import.meta.url);
const MIGRATIONS = new URL("prisma/migrations/", ROOT);
const BASELINE_SCHEMA = new URL(
  "prisma/migrations/20260804000000_baseline/baseline.schema.prisma",
  ROOT,
);
const PRISMA_CLI = new URL("node_modules/prisma/build/index.js", ROOT);
const BASELINE_MIGRATION = "20260804000000_baseline";

function directUrl(env) {
  const raw = env.DIRECT_URL;
  if (!raw) {
    throw new Error(
      "DIRECT_URL is required for the one-time baseline metadata write",
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Baseline resolve database URL is invalid");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Baseline resolve only supports PostgreSQL URLs");
  }
  if (parsed.searchParams.get("pgbouncer") === "true") {
    throw new Error("DIRECT_URL must not use PgBouncer transaction pooling");
  }
  return raw;
}

export async function resolveBaselineDatabase({
  env = process.env,
  confirmed = false,
} = {}) {
  if (!confirmed) {
    throw new Error(
      "Baseline resolve is metadata-changing; rerun with the explicit --apply flag after backup verification",
    );
  }
  const url = directUrl(env);
  validateMigrations();
  runMigrationPreflight(
    { ...env, DATABASE_URL: url, DIRECT_URL: url },
    { allowUnresolvedBaseline: true },
  );
  // The read-only exact-schema check runs immediately before the metadata
  // write. It rejects drift, unsupported objects and any prior migration table.
  await inspectBaselineDatabase({ env: { ...env, DATABASE_URL: url, DIRECT_URL: url } });

  // Prisma locates `migrations/` beside the supplied schema. Build an isolated
  // copy so a clean checkout can resolve PostgreSQL without changing the
  // committed SQLite schema or generated client.
  const temporary = mkdtempSync(path.join(tmpdir(), "ld2l-baseline-resolve-"));
  const temporarySchema = path.join(temporary, "schema.prisma");
  try {
    writeFileSync(temporarySchema, readFileSync(BASELINE_SCHEMA));
    cpSync(fileURLToPath(MIGRATIONS), path.join(temporary, "migrations"), {
      recursive: true,
    });
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(PRISMA_CLI),
        "migrate",
        "resolve",
        "--applied",
        BASELINE_MIGRATION,
        "--schema",
        temporarySchema,
      ],
      {
        cwd: fileURLToPath(ROOT),
        env: { ...env, DATABASE_URL: url, DIRECT_URL: url },
        encoding: "utf8",
      },
    );
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (result.status !== 0) {
      throw new Error(`Could not record the verified baseline:\n${output}`);
    }
    return output;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resolveBaselineDatabase({ confirmed: process.argv.includes("--apply") })
    .then((output) => {
      if (output) console.log(output);
      console.log(
        "Verified baseline recorded. Run migration preflight, then prisma migrate deploy.",
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
