// Stand the local Postgres test environment up and back down.
//
//   npm run pg:up      # create the throwaway DB, deploy migrations, generate
//   npm run pg:down    # put EVERYTHING back to sqlite and drop the DB
//
// WHY THIS IS A SCRIPT AND NOT A README PARAGRAPH. Running the Postgres suite
// or the mutation guard means switching `prisma/schema.prisma` to the
// postgresql provider and regenerating the client. Forgetting to switch BACK
// leaves the repo on a provider local dev and the SQLite suites cannot use —
// and leaves a modified schema.prisma sitting in `git status`, one `git add -A`
// away from being committed. That teardown is the step a human skips; making it
// one command is the point.
//
// Safe by construction: it only ever creates/drops a database whose name
// contains "pgtest", so it cannot be aimed at dev, prod or the e2e databases
// (same discipline as scripts/assert-local-db.mjs).
import { execFileSync, execSync } from "node:child_process";
import { assertLocalManagedPostgresUrl } from "./test-db-safety.mjs";

const DB = "ld2l_pgtest";
const URL_FOR = (db) => `postgresql://${process.env.USER}@localhost:5432/${db}`;
const url = process.env.PG_TEST_URL ?? URL_FOR(DB);
let parsed;
try {
  parsed = assertLocalManagedPostgresUrl(url);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unsafe PG_TEST_URL");
  process.exit(2);
}

const run = (cmd, env = {}) =>
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
const adminUrl = new URL(parsed);
adminUrl.pathname = "/postgres";
const databaseToolEnv = { ...process.env, PGDATABASE: adminUrl.toString() };
delete databaseToolEnv.DATABASE_URL;
delete databaseToolEnv.DIRECT_URL;
const quietDatabaseTool = (command, args) => {
  try {
    execFileSync(command, args, { stdio: "pipe", env: databaseToolEnv });
  } catch {
    /* best effort */
  }
};

const mode = process.argv[2];
const dbEnv = { DATABASE_URL: url, DIRECT_URL: url };

if (mode === "up") {
  quietDatabaseTool("dropdb", ["--if-exists", "--force", DB]);
  execFileSync("createdb", [DB], { stdio: "inherit", env: databaseToolEnv });
  run("node scripts/switch-db-provider.mjs postgresql");
  run("npm run db:migrate:validate", dbEnv);
  run("npm run db:migrate:preflight", dbEnv);
  run("npx prisma migrate deploy", dbEnv);
  run("npm run db:migrate:postflight", dbEnv);
  run("npx prisma generate", dbEnv);
  console.log(`\nReady. Keep PG_TEST_URL pointed at ${DB}, then run:\n`);
  if (!process.env.PG_TEST_URL) {
    console.log(`  export PG_TEST_URL="${url}"`);
  } else {
    console.log("  # PG_TEST_URL was supplied; keep that same value in this shell");
  }
  console.log(`  npm run test:pg                    # full Postgres suite`);
  console.log(`  npm run test:mutation              # verify the baseline`);
  console.log(`  npm run test:mutation:discover -- --only X  # probe one claim`);
  console.log(`\nWhen you're done: npm run pg:down`);
} else if (mode === "down") {
  // Provider first: even if the drop fails, the repo is left usable.
  run("node scripts/switch-db-provider.mjs sqlite");
  run("npx prisma generate");
  quietDatabaseTool("dropdb", ["--if-exists", "--force", DB]);
  console.log(`\nBack on sqlite, ${DB} dropped. Check: git status --short`);
} else {
  console.error("Usage: node scripts/pg-test-env.mjs <up|down>");
  process.exit(2);
}
