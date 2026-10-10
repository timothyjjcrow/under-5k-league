import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const BASELINE_MIGRATION = "20260804000000_baseline";
export const MIGRATION_SHA256 = Object.freeze({
  "20261004000000_match_night_poll":
    "56b97d121d453f1da9f1da8fc665260e532d50c680a67146c35872cb4230db0f",
  "20261004120000_reschedule_ready_check":
    "da2ea9d5373bda63c5b80d7c2435290edb330b6e8521aa0fa85f0a7040618155",
  "20261008000000_inhouse_night_rsvp":
    "d33fb8a0d758ad2cf30c054bb5f74c1b2cd94de7492ef1d3b382ded124f67c36",
  "20261009000000_inhouse_game_slots":
    "f3ba48a351a1f4f27801d396547131d6920ad11b93bfcb1a6980a18777da1fd8",
  "20261010000000_inhouse_result_pending_roles":
    "fffa30af102bbffbdc63be5c18fc402970e40cdb1b0c4c094307782674cc961c",
  "20261010120000_inhouse_time_rsvp":
    "bfab6c3d45833ee388958f9f0bfe9a87ebc6129a939a0177c0f5ea68b5105cbd",
  "20260927000000_review_followups":
    "2c53b367b55dc02d2d837791ab67bfcb075ffb635be6d2bba73a839e076387b9",
  "20260925020000_historical_participation":
    "f5a63e8fbf76a6cc0754038799467339c31ff6725a6903c33a635f609b475937",
  "20260925010000_resumable_import":
    "d6c96cd035417c0b023416b76356d257c9f163b881707c1984fa804e6330e7a9",
  "20260804000000_baseline":
    "d3469033ac784aa40dca363b48d3c061bec9dcbcde37f164039ded717b933ae9",
  "20260804010000_release_readiness":
    "09f909e10b0313929bbf1fa11fa387a4aff71e554b3372842b6ef64336c2f3bf",
  "20260804020000_automation_run_state":
    "5e03b414ee0a46bd2e7476cb0d2ca717b7579ff0bfacf44157499f93a412069d",
  "20260814000000_team_logo":
    "db38b63dbfcb34209e2de6cab898b5794bad50b75f9e2a91fefcecb5dea61b2b",
  "20260817000000_scrims":
    "4dbadb273a1990c98bf7d93bc3bd749ef3f93f897f5f1ef5dd0768a1c70a6752",
  "20260831000000_inhouse_queue_idle_timeout":
    "6d8c8c62c69d0586c527306e94d20f58347d36385c8e55b364ae0030314cfe16",
  "20260914000000_manual_player_medal":
    "e70cf9bb5cc3976140796f6d0ca351b2463a3022236ca3cdf32e0dba517cb955",
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

/**
 * Reviewed contractions: the only destructive statements a migration may run,
 * each spelled exactly and allowed only in the one migration named here. Each
 * drops something the binary still serving does not rely on (the migration's
 * own comment says why), so it ships like an additive migration. Every other
 * statement that matches DESTRUCTIVE still fails, and a listed statement the
 * migration no longer contains fails too, so the list cannot go stale.
 */
const REVIEWED_CONTRACTIONS = Object.freeze({
  // Two inhouse games can be live at once: the per-slot index created just
  // before it replaces the one-live-lobby index.
  "20261009000000_inhouse_game_slots": Object.freeze([
    'DROP INDEX "InhouseLobby_one_active_idx"',
  ]),
});

const normalizeStatement = (statement) => statement.replace(/\s+/g, " ").trim();

const SAFE_STATEMENT_STARTS = [
  /^DO\s+\$/i,
  /^ALTER\s+TABLE\b/i,
  /^UPDATE\b/i,
  /^CREATE\s+TABLE\b/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /^CREATE\s+FUNCTION\s+"ld2l_(?:sync_legacy_dota_account_id|preserve_inhouse_queue_time|refresh_inhouse_queue_idle_deadline|stamp_inhouse_completion|stamp_match_completion|lock_fantasy_after_game)"\(\)\s+RETURNS\s+trigger\b/i,
  /^CREATE\s+TRIGGER\s+"ld2l_(?:(?:sync_legacy_dota_account_id|preserve_inhouse_queue_time|stamp_inhouse_completion|stamp_match_completion|lock_fantasy_after_game)_trigger|refresh_inhouse_queue_idle_deadline_(?:insert|delete)_trigger)"\s/i,
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

  const contractions = REVIEWED_CONTRACTIONS[name] ?? [];
  const contracted = new Set();
  for (const [offset, statement] of statements.slice(1, -1).entries()) {
    const normalized = normalizeStatement(statement);
    if (contractions.includes(normalized)) {
      contracted.add(normalized);
      continue;
    }
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
  for (const statement of contractions) {
    if (!contracted.has(statement)) {
      throw new Error(
        `${name}: reviewed contraction is missing from the migration: ${statement}`,
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
