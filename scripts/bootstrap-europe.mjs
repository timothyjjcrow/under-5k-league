import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { validateProductionEnv } from "./validate-prod-env.mjs";
import { inspectPostflightDatabase } from "./migration-postflight.mjs";
import { executeInstanceSql, instanceIdentitySql, sqlLiteral } from "./instance-database.mjs";

export function authorizeEuropeBootstrap(argv, env) {
  if (argv.length !== 2 || argv[0] !== "--apply" || argv[1] !== env.APP_URL) {
    throw new Error("Usage: npm run db:bootstrap:europe -- --apply <Europe APP_URL>");
  }
  if (env.VERCEL_ENV !== "production" || env.NEXT_PUBLIC_LEAGUE_REGION !== "eu") {
    throw new Error("Europe bootstrap requires VERCEL_ENV=production and NEXT_PUBLIC_LEAGUE_REGION=eu");
  }
  const errors = validateProductionEnv(env);
  if (errors.length) throw new Error(errors.join("\n"));
}

export function europeBootstrapSql(env, id = randomUUID()) {
  return `BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
DO $empty$
DECLARE application_table text; has_rows boolean;
BEGIN
  -- The table locks cover the emptiness check and both inserts. Concurrent
  -- logins, queue joins and second bootstraps cannot race this safety gate.
  FOR application_table IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'
    ORDER BY tablename
  LOOP
    EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE', current_schema(), application_table);
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', current_schema(), application_table) INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'Bootstrap requires every application table to be empty';
    END IF;
  END LOOP;
END $empty$;
INSERT INTO "Setting" ("key", "value") VALUES
  ('deploymentRegion', 'eu'),
  ('deploymentOrigin', ${sqlLiteral(env.APP_URL)});
INSERT INTO "Season" ("id", "name", "status", "isActive", "maxMmr", "matchSchedule", "firstMatchNight", "draftAt", "updatedAt")
VALUES (${sqlLiteral(id)}, 'GGD2L Europe Season 1', 'SIGNUPS', true, 4500,
  'Match night to be announced', NULL, NULL, CURRENT_TIMESTAMP);
COMMIT;`;
}

export async function runEuropeBootstrap({
  argv = process.argv.slice(2), env = process.env,
  inspect = inspectPostflightDatabase, executeSql = executeInstanceSql,
} = {}) {
  authorizeEuropeBootstrap(argv, env);
  await inspect({ env });
  executeSql(europeBootstrapSql(env), { env });
  executeSql(instanceIdentitySql(env), { env });
  console.log("Europe initialized: one signup season, match night unannounced, no player or demo data. Allowlisted administrators receive access when they sign in with Steam.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEuropeBootstrap().catch((error) => {
    console.error(error instanceof Error ? error.message : "Europe bootstrap failed");
    process.exitCode = 1;
  });
}
