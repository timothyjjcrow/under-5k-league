import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const BASELINE_MIGRATION = "20260804000000_baseline";
export const MIGRATION_SHA256 = Object.freeze({
  "20260804000000_baseline":
    "d3469033ac784aa40dca363b48d3c061bec9dcbcde37f164039ded717b933ae9",
  "20260804010000_release_readiness":
    "09f909e10b0313929bbf1fa11fa387a4aff71e554b3372842b6ef64336c2f3bf",
  "20260804020000_automation_run_state":
    "5e03b414ee0a46bd2e7476cb0d2ca717b7579ff0bfacf44157499f93a412069d",
  "20260814000000_team_logo":
    "db38b63dbfcb34209e2de6cab898b5794bad50b75f9e2a91fefcecb5dea61b2b",
});
export const BASELINE_SCHEMA_SHA256 =
  "8234d47b06f9adf2444b5caaef29f645f6ea2817dc4353c3d6d012b070cb6133";

const DEFAULT_MIGRATIONS_DIR = new URL("../prisma/migrations/", import.meta.url);

function dollarTagAt(sql, offset) {
  const match = sql.slice(offset).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  return match?.[0] ?? null;
}

/**
 * Split SQL at top-level semicolons while ignoring comments and quoted bodies.
 * PostgreSQL DO blocks contain their own semicolons, so a line-based parser is
 * not sufficient for a release gate.
 */
export function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarTag = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        current += "\n";
      }
      continue;
    }

    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 1;
      } else if (char === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }

    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += char;
      }
      continue;
    }

    if (singleQuoted) {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (doubleQuoted) {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      current += char;
      continue;
    }
    if (char === '"') {
      doubleQuoted = true;
      current += char;
      continue;
    }
    if (char === "$") {
      const tag = dollarTagAt(sql, index);
      if (tag) {
        dollarTag = tag;
        current += tag;
        index += tag.length - 1;
        continue;
      }
    }

    current += char;
    if (char === ";") {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }

  if (
    singleQuoted ||
    doubleQuoted ||
    lineComment ||
    blockCommentDepth > 0 ||
    dollarTag
  ) {
    throw new Error("SQL contains an unterminated quote or comment");
  }
  if (current.trim()) {
    throw new Error("Every migration statement must end with a semicolon");
  }
  return statements;
}

const DESTRUCTIVE = [
  [/\bDROP\b/i, "DROP"],
  [/\bTRUNCATE\b/i, "TRUNCATE"],
  [/\bDELETE\s+FROM\b/i, "DELETE FROM"],
  [/\bRENAME\s+(?:TO|COLUMN)\b/i, "RENAME"],
  [/\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i, "ALTER COLUMN TYPE"],
  [/\bSET\s+DATA\s+TYPE\b/i, "SET DATA TYPE"],
  [/\bCREATE\s+OR\s+REPLACE\b/i, "CREATE OR REPLACE"],
];

const SAFE_STATEMENT_STARTS = [
  /^DO\s+\$/i,
  /^ALTER\s+TABLE\b/i,
  /^UPDATE\b/i,
  /^CREATE\s+TABLE\b/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /^CREATE\s+FUNCTION\s+"ld2l_(?:sync_legacy_dota_account_id|preserve_inhouse_queue_time|stamp_inhouse_completion|stamp_match_completion|lock_fantasy_after_game)"\(\)\s+RETURNS\s+trigger\b/i,
  /^CREATE\s+TRIGGER\s+"ld2l_(?:sync_legacy_dota_account_id|preserve_inhouse_queue_time|stamp_inhouse_completion|stamp_match_completion|lock_fantasy_after_game)_trigger"\s/i,
];

export function validateMigrationSql(name, sql, { baseline = false } = {}) {
  const statements = splitSqlStatements(sql);
  if (statements.length < 2) {
    throw new Error(`${name}: migration must contain BEGIN and COMMIT`);
  }
  if (!/^BEGIN(?:\s+TRANSACTION)?$/i.test(statements[0])) {
    throw new Error(`${name}: first statement must be BEGIN`);
  }
  if (!/^COMMIT$/i.test(statements.at(-1))) {
    throw new Error(`${name}: last statement must be COMMIT`);
  }
  const transactionStatements = statements.filter((statement) =>
    /^(?:BEGIN(?:\s+TRANSACTION)?|COMMIT|ROLLBACK)$/i.test(statement),
  );
  if (transactionStatements.length !== 2) {
    throw new Error(`${name}: migration must contain exactly one transaction`);
  }

  if (baseline) return statements;

  for (const [offset, statement] of statements.slice(1, -1).entries()) {
    for (const [pattern, label] of DESTRUCTIVE) {
      if (pattern.test(statement)) {
        throw new Error(
          `${name}: statement ${offset + 2} uses forbidden destructive operation ${label}`,
        );
      }
    }
    if (!SAFE_STATEMENT_STARTS.some((pattern) => pattern.test(statement))) {
      const start = statement.replace(/\s+/g, " ").slice(0, 80);
      throw new Error(
        `${name}: statement ${offset + 2} is not in the additive SQL allowlist: ${start}`,
      );
    }
  }
  return statements;
}

export function validateMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const root = migrationsDir instanceof URL ? migrationsDir : new URL(migrationsDir);
  const lock = readFileSync(new URL("migration_lock.toml", root), "utf8");
  if (!/^provider\s*=\s*"postgresql"\s*$/m.test(lock)) {
    throw new Error("migration_lock.toml must pin the postgresql provider");
  }

  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!names.includes(BASELINE_MIGRATION)) {
    throw new Error(`Missing immutable baseline migration ${BASELINE_MIGRATION}`);
  }
  if (names[0] !== BASELINE_MIGRATION) {
    throw new Error(`${BASELINE_MIGRATION} must be the first migration`);
  }
  const reviewedNames = Object.keys(MIGRATION_SHA256).sort();
  if (JSON.stringify(names) !== JSON.stringify(reviewedNames)) {
    throw new Error(
      `Migration checksum inventory mismatch (reviewed: ${reviewedNames.join(", ")}; present: ${names.join(", ")})`,
    );
  }

  for (const name of names) {
    if (!/^\d{14}_[a-z0-9_]+$/.test(name)) {
      throw new Error(`Invalid migration directory name: ${name}`);
    }
    const sql = readFileSync(new URL(`${name}/migration.sql`, root), "utf8");
    const baseline = name === BASELINE_MIGRATION;
    const digest = createHash("sha256").update(sql).digest("hex");
    const expected = MIGRATION_SHA256[name];
    if (digest !== expected) {
      throw new Error(
        `${name}: immutable migration checksum mismatch (expected ${expected}, received ${digest})`,
      );
    }
    validateMigrationSql(name, sql, { baseline });
  }

  const baselineSchema = readFileSync(
    new URL(`${BASELINE_MIGRATION}/baseline.schema.prisma`, root),
  );
  const baselineSchemaDigest = createHash("sha256")
    .update(baselineSchema)
    .digest("hex");
  if (baselineSchemaDigest !== BASELINE_SCHEMA_SHA256) {
    throw new Error(
      `${BASELINE_MIGRATION}: immutable baseline datamodel checksum mismatch (expected ${BASELINE_SCHEMA_SHA256}, received ${baselineSchemaDigest})`,
    );
  }

  return names;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const names = validateMigrations();
    console.log(`Migration safety gate passed (${names.length} migrations).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
