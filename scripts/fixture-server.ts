// One command per league state, for looking at the site in that state:
//
//   npm run fixture:signups    SIGNUPS, 37 players signed up      http://localhost:3111
//   npm run fixture:regular    last regular-season week open      http://localhost:3116
//   npm run fixture:playoffs   mid-playoffs, final still TBD      http://localhost:3117
//   npm run fixture:complete   whole bracket played, champion     http://localhost:3118
//
// Each state owns its SQLite file (prisma/<state>-fixture.db), its port and its
// Next build folder (.next-fixture-<state>). Next 16 allows one dev server per
// build folder, not per repo, so all four can run at once beside `npm run dev`
// from this one checkout: no repo copies.
//
// Every start rebuilds the database from scratch (schema push, then the
// seeder). Add `-- --no-seed` to serve what is already there, or `-- --dry-run`
// to print the target database, folder and commands without running them.
// Seeder knobs pass through: PLAYERS/CAPTAINS (signups) and FIXTURE_TEAMS (the
// others). Sign in with /api/auth/dev (?admin=1 for an admin); ALLOW_DEV_LOGIN
// is set for these servers only.
//
// Safety: the database path is fixed here, never read from the environment,
// and the seeders refuse any other file (seed-fixture.ts accepts only the exact
// paths in src/lib/fixture-database.ts; the signups seeder needs "fixture" in
// the URL). dev.db and remote databases are never touched.
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_DATABASE_PATHS } from "@/lib/fixture-database";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type Fixture = {
  port: number;
  dbPath: string;
  seedScript: string;
  /** FIXTURE_MODE for scripts/seed-fixture.ts; null clears an inherited one. */
  mode: string | null;
};

const FIXTURES: Record<string, Fixture> = {
  signups: {
    port: 3111,
    // The signups seeder guards on its own ("fixture" in the URL).
    dbPath: path.join(ROOT, "prisma", "signups-fixture.db"),
    seedScript: "scripts/seed-signups-fixture.ts",
    mode: null,
  },
  regular: {
    port: 3116,
    dbPath: FIXTURE_DATABASE_PATHS.demoRegular,
    seedScript: "scripts/seed-fixture.ts",
    mode: "regular",
  },
  playoffs: {
    port: 3117,
    dbPath: FIXTURE_DATABASE_PATHS.demoPlayoffs,
    seedScript: "scripts/seed-fixture.ts",
    mode: null, // the seeder's default mode is mid-playoffs
  },
  complete: {
    port: 3118,
    dbPath: FIXTURE_DATABASE_PATHS.demoComplete,
    seedScript: "scripts/seed-fixture.ts",
    mode: "complete",
  },
};

function fail(message: string): never {
  console.error(`fixture-server: ${message}`);
  process.exit(1);
}

const bin = (name: string) => path.join(ROOT, "node_modules", ".bin", name);

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: "inherit" });
  if (result.error) fail(`${path.basename(command)}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${path.basename(command)} ${args.join(" ")} failed (exit ${result.status ?? result.signal}).`);
  }
}

const FLAGS = ["--no-seed", "--dry-run"];

function main() {
  const [name = "", ...flags] = process.argv.slice(2);
  if (!Object.hasOwn(FIXTURES, name)) {
    fail(`usage: tsx scripts/fixture-server.ts <${Object.keys(FIXTURES).join("|")}> [${FLAGS.join("] [")}]`);
  }
  const fixture = FIXTURES[name];
  const unknown = flags.filter((flag) => !FLAGS.includes(flag));
  if (unknown.length > 0) fail(`unknown option ${unknown.join(" ")}`);
  const seed = !flags.includes("--no-seed");

  // `npm run pg:up` switches the Prisma provider; a SQLite fixture can't run
  // until `npm run pg:down` switches it back.
  const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
  if (!/provider\s*=\s*"sqlite"/.test(schema)) {
    fail('prisma/schema.prisma is not on the sqlite provider. Run "npm run pg:down" first.');
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Same absolute form as the Playwright configs, so the seeders' exact-path
    // guard and Prisma both read it.
    DATABASE_URL: `file:${fixture.dbPath}`,
    NEXT_DIST_DIR: `.next-fixture-${name}`,
    ALLOW_DEV_LOGIN: "true",
  };
  delete env.FIXTURE_MODE;
  if (fixture.mode) env.FIXTURE_MODE = fixture.mode;

  // A throwaway demo file: data loss on a schema change is the point.
  const pushArgs = ["db", "push", "--skip-generate", "--accept-data-loss"];
  const serveArgs = ["dev", "-p", String(fixture.port)];

  if (flags.includes("--dry-run")) {
    console.log(
      [
        `DATABASE_URL=${env.DATABASE_URL}`,
        `NEXT_DIST_DIR=${env.NEXT_DIST_DIR}`,
        `FIXTURE_MODE=${env.FIXTURE_MODE ?? "(unset)"}`,
        ...(seed ? [`prisma ${pushArgs.join(" ")}`, `tsx ${fixture.seedScript}`] : []),
        `next ${serveArgs.join(" ")}`,
      ].join("\n"),
    );
    return;
  }

  if (!seed && !existsSync(fixture.dbPath)) {
    fail(`${path.relative(ROOT, fixture.dbPath)} does not exist yet; run without --no-seed once.`);
  }
  if (seed) {
    // Prisma 5's darwin-arm64 schema engine can fail on a missing SQLite file
    // (see scripts/prepare-sqlite-test-db.mjs), so create it first.
    closeSync(openSync(fixture.dbPath, "a", 0o600));
    run(bin("prisma"), pushArgs, env);
    run(bin("tsx"), [fixture.seedScript], env);
  }

  console.log(`\nfixture:${name} → http://localhost:${fixture.port} (sign in at /api/auth/dev)\n`);
  const options: SpawnOptions = { cwd: ROOT, env, stdio: "inherit" };
  const server = spawn(bin("next"), serveArgs, options);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.kill(signal));
  }
  server.on("exit", (code) => process.exit(code ?? 1));
}

main();
