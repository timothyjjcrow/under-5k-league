import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const BASELINE_SCHEMA = new URL(
  "prisma/migrations/20260804000000_baseline/baseline.schema.prisma",
  ROOT,
);
const PRISMA_CLI = new URL("node_modules/prisma/build/index.js", ROOT);

function preflightSql({ allowUnresolvedBaseline = false } = {}) {
  const migrationHistoryGuard = allowUnresolvedBaseline
    ? ""
    : `
  IF to_regclass(format('%I.%I', current_schema(), '_prisma_migrations')) IS NULL THEN
    RAISE EXCEPTION
      'Migration preflight found an unresolved legacy LD2L schema; verify backup, run baseline-check, then baseline-resolve --apply';
  END IF;
  EXECUTE format(
    'SELECT COUNT(*) FROM %I.%I WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL',
    current_schema(),
    '_prisma_migrations'
  )
  INTO resolved_baseline_count
  USING '20260804000000_baseline';
  IF resolved_baseline_count <> 1 THEN
    RAISE EXCEPTION
      'Migration preflight requires exactly one finished baseline migration record; investigate migration history';
  END IF;
`;

  return `
DO $$
DECLARE
  required_table text;
  missing_tables text[] := ARRAY[]::text[];
  invalid_dota_count bigint;
  cross_user_dota_claim_count bigint;
  active_season_count bigint;
  active_lobby_count bigint;
  unknown_schema_object_count bigint;
  resolved_baseline_count bigint;
BEGIN
  -- A genuinely empty database is the fresh-install path; migrate deploy will
  -- apply baseline and release migrations normally.
  IF to_regclass(format('%I.%I', current_schema(), 'User')) IS NULL
     AND to_regclass(format('%I.%I', current_schema(), 'Season')) IS NULL
     AND to_regclass(format('%I.%I', current_schema(), 'InhouseLobby')) IS NULL THEN
    SELECT COUNT(*)
    INTO unknown_schema_object_count
    FROM (
      SELECT cls.oid
      FROM pg_class AS cls
      INNER JOIN pg_namespace AS ns ON ns.oid = cls.relnamespace
      WHERE ns.nspname = current_schema()
        AND cls.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')

      UNION ALL

      SELECT proc.oid
      FROM pg_proc AS proc
      INNER JOIN pg_namespace AS ns ON ns.oid = proc.pronamespace
      WHERE ns.nspname = current_schema()

      UNION ALL

      SELECT pg_type.oid
      FROM pg_type
      INNER JOIN pg_namespace AS ns ON ns.oid = pg_type.typnamespace
      WHERE ns.nspname = current_schema()
        AND pg_type.typtype IN ('e', 'd')
    ) AS unknown_objects;
    IF unknown_schema_object_count > 0 THEN
      RAISE EXCEPTION
        'Migration preflight found % unknown object(s) in a non-LD2L schema; use a dedicated empty database',
        unknown_schema_object_count;
    END IF;
    RETURN;
  END IF;

  FOREACH required_table IN ARRAY ARRAY['User', 'Season', 'InhouseLobby'] LOOP
    IF to_regclass(format('%I.%I', current_schema(), required_table)) IS NULL THEN
      missing_tables := array_append(missing_tables, required_table);
    END IF;
  END LOOP;
  IF cardinality(missing_tables) > 0 THEN
    RAISE EXCEPTION
      'Migration preflight found a partial/unknown schema; missing baseline tables: %',
      array_to_string(missing_tables, ', ');
  END IF;

  EXECUTE format(
    'SELECT COUNT(*) FROM %I.%I WHERE "dotaAccountId" IS NOT NULL AND "dotaAccountId" <= 0',
    current_schema(),
    'User'
  ) INTO invalid_dota_count;
  IF invalid_dota_count > 0 THEN
    RAISE EXCEPTION
      'Migration preflight failed: % User row(s) have a non-positive legacy dotaAccountId',
      invalid_dota_count;
  END IF;

  EXECUTE format(
    $query$
      SELECT COUNT(*)
      FROM %I.%I AS holder
      INNER JOIN %I.%I AS owner ON owner."id" <> holder."id"
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN owner."steamId" ~ '^[0-9]{17,20}$'
            THEN owner."steamId"::numeric
          ELSE NULL
        END AS steam64
      ) AS identity
      WHERE holder."dotaAccountId" IS NOT NULL
        AND identity.steam64 > 76561197960265728
        AND identity.steam64 <= 76561202255233023
        AND holder."dotaAccountId"::numeric =
          identity.steam64 - 76561197960265728
    $query$,
    current_schema(),
    'User',
    current_schema(),
    'User'
  ) INTO cross_user_dota_claim_count;
  IF cross_user_dota_claim_count > 0 THEN
    RAISE EXCEPTION
      'Migration preflight failed: % legacy dotaAccountId claim(s) collide with another user''s canonical Steam identity; reconcile ownership before deploy',
      cross_user_dota_claim_count;
  END IF;

  EXECUTE format(
    'SELECT COUNT(*) FROM %I.%I WHERE "isActive" IS TRUE',
    current_schema(),
    'Season'
  ) INTO active_season_count;
  IF active_season_count > 1 THEN
    RAISE EXCEPTION
      'Migration preflight failed: % active seasons exist; reconcile to at most one before deploy',
      active_season_count;
  END IF;

  EXECUTE format(
    'SELECT COUNT(*) FROM %I.%I WHERE "status" IN ($1, $2, $3, $4, $5)',
    current_schema(),
    'InhouseLobby'
  )
  INTO active_lobby_count
  USING 'READY_CHECK', 'CAPTAIN_VOTE', 'DRAFTING', 'READY', 'IN_PROGRESS';
  IF active_lobby_count > 1 THEN
    RAISE EXCEPTION
      'Migration preflight failed: % active inhouse lobbies exist; reconcile to at most one before deploy',
      active_lobby_count;
  END IF;
${migrationHistoryGuard}
END
$$;
`;
}

export const PREFLIGHT_SQL = preflightSql();

export function runMigrationPreflight(
  env = process.env,
  { allowUnresolvedBaseline = false } = {},
) {
  const url = env.DIRECT_URL ?? env.DATABASE_URL;
  if (!url) {
    throw new Error("DIRECT_URL (preferred) or DATABASE_URL is required");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Migration preflight database URL is invalid");
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error("Migration preflight only supports PostgreSQL URLs");
  }
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(PRISMA_CLI),
      "db",
      "execute",
      "--stdin",
      "--schema",
      fileURLToPath(BASELINE_SCHEMA),
    ],
    {
      cwd: fileURLToPath(ROOT),
      env: { ...env, DATABASE_URL: url, DIRECT_URL: url },
      encoding: "utf8",
      input: preflightSql({ allowUnresolvedBaseline }),
    },
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status !== 0) {
    throw new Error(`Migration preflight rejected this database:\n${output}`);
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const output = runMigrationPreflight();
    if (output) console.log(output);
    console.log("Migration data preflight passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
