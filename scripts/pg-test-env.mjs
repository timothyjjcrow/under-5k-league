// Stand the local Postgres test environment up and back down.
//
//   npm run pg:up      # create the throwaway DB, point Prisma at it, push, generate
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
import { execSync } from "node:child_process";

const DB = "ld2l_pgtest";
const URL_FOR = (db) => `postgresql://${process.env.USER}@localhost:5432/${db}`;
const url = process.env.PG_TEST_URL ?? URL_FOR(DB);

if (!/pgtest/.test(url)) {
  console.error(
    `Refusing to touch ${url} — this script only manages a database whose\n` +
      `name contains "pgtest". Unset PG_TEST_URL to use the default.`,
  );
  process.exit(2);
}

const run = (cmd, env = {}) =>
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
const quiet = (cmd) => {
  try {
    execSync(cmd, { stdio: "pipe" });
  } catch {
    /* best effort */
  }
};

const mode = process.argv[2];
const dbEnv = { DATABASE_URL: url, DIRECT_URL: url };

if (mode === "up") {
  quiet(`psql -d postgres -c "DROP DATABASE IF EXISTS ${DB}"`);
  run(`psql -d postgres -c "CREATE DATABASE ${DB}"`);
  run("node scripts/switch-db-provider.mjs postgresql");
  run("npx prisma db push --skip-generate --accept-data-loss", dbEnv);
  run("npx prisma generate", dbEnv);
  console.log(`\nReady. Export this, then run the suite or the guard:\n`);
  console.log(`  export PG_TEST_URL="${url}"`);
  console.log(`  npm run test:pg                    # the 402-test suite`);
  console.log(`  npm run test:mutation              # verify the baseline`);
  console.log(`  npm run test:mutation -- --only X  # probe one claim`);
  console.log(`\nWhen you're done: npm run pg:down`);
} else if (mode === "down") {
  // Provider first: even if the drop fails, the repo is left usable.
  run("node scripts/switch-db-provider.mjs sqlite");
  run("npx prisma generate");
  quiet(`psql -d postgres -c "DROP DATABASE IF EXISTS ${DB}"`);
  console.log(`\nBack on sqlite, ${DB} dropped. Check: git status --short`);
} else {
  console.error("Usage: node scripts/pg-test-env.mjs <up|down>");
  process.exit(2);
}
