import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkLeagueEnv, checkSlotEnv, parseContractArgs, parseEnvFile } from "./env-contract.mjs";

const CLI = fileURLToPath(new URL("./env-contract.mjs", import.meta.url));
const PASSWORD = "5f".repeat(32);
const DB = `postgresql://ggd2l_us_app:${PASSWORD}@127.0.0.1:5432/ggd2l_us?schema=public&sslmode=disable&connection_limit=8&pool_timeout=10&connect_timeout=5`;

const VALID_US = Object.freeze({
  DATABASE_URL: DB,
  DIRECT_URL: DB,
  AUTH_SECRET: "auth-secret-0123456789abcdef",
  CRON_SECRET: "cron-secret-0123456789abcdef",
  BACKUP_RECEIPT_SECRET: "receipt-secret-0123456789abcdef",
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  STEAM_API_KEY: "STEAMKEY0123456789ABCDEF",
  DISCORD_CLIENT_ID: "1545719497472741466",
  DISCORD_CLIENT_SECRET: "discord-client-secret-value",
  DISCORD_BOT_TOKEN: "discord-bot-token-value-xyz",
  APP_URL: "https://us.ggd2l.com",
  NEXT_PUBLIC_SITE_URL: "https://us.ggd2l.com",
  NEXT_PUBLIC_LEAGUE_REGION: "us",
  LEAGUE_DEPLOY_ENV: "production",
  CLIENT_IP_HEADER: "cf-connecting-ip",
});

const STAGING_SAFE = (() => {
  const env = { ...VALID_US, LEAGUE_DEPLOY_ENV: "staging" };
  delete env.DISCORD_BOT_TOKEN;
  delete env.DISCORD_CLIENT_SECRET;
  return Object.freeze(env);
})();

const SLOT_US_A = Object.freeze({
  ...VALID_US,
  PORT: "3001",
  NODE_ENV: "production",
  LEAGUE_RELEASE_SHA: "a".repeat(40),
  NODE_OPTIONS: "--max-old-space-size=640",
  NEXT_TELEMETRY_DISABLED: "1",
  MALLOC_ARENA_MAX: "2",
});

const without = (env, key) => {
  const copy = { ...env };
  delete copy[key];
  return copy;
};
const problemsFor = (env, lg = "us") => checkLeagueEnv(env, lg);
const refuses = (env, name, lg = "us") => {
  const problems = problemsFor(env, lg);
  assert.ok(problems.some((problem) => problem.startsWith(`${name}:`)), `${name} should be refused: ${problems}`);
};

test("a complete production env and a staging env each pass", () => {
  assert.deepEqual(problemsFor(VALID_US), []);
  assert.deepEqual(problemsFor(STAGING_SAFE), []);
  const eu = {
    ...VALID_US,
    DATABASE_URL: DB.replaceAll("ggd2l_us", "ggd2l_eu"),
    DIRECT_URL: DB.replaceAll("ggd2l_us", "ggd2l_eu"),
    APP_URL: "https://eu.ggd2l.com",
    NEXT_PUBLIC_SITE_URL: "https://eu.ggd2l.com",
    NEXT_PUBLIC_LEAGUE_REGION: "eu",
  };
  assert.deepEqual(problemsFor(eu, "eu"), []);
});

test("any VERCEL* key is refused", () => {
  for (const key of ["VERCEL_ENV", "VERCEL", "VERCEL_URL", "VERCELX"]) refuses({ ...VALID_US, [key]: "production" }, key);
});

test("the build and test override keys, HOSTNAME and every Neon integration key are refused", () => {
  for (const key of [
    "BUILD_DB_DRY_RUN",
    "PRISMA_ACCEPT_DATA_LOSS",
    "PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK",
    "DISCORD_API_BASE",
    "NEXT_DIST_DIR",
    "HOSTNAME",
    "PGHOST",
    "PGPASSWORD",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "NEON_PROJECT_ID",
    "DATABASE_URL_UNPOOLED",
  ])
    refuses({ ...VALID_US, [key]: "1" }, key);
  // Near misses are not prefixes of a forbidden family.
  assert.deepEqual(problemsFor({ ...VALID_US, POSTGRESQL_NOTE: "x", NEONATAL: "x" }), []);
});

test("LEAGUE_DEPLOY_ENV must be exactly production or staging, and present", () => {
  assert.deepEqual(problemsFor(VALID_US), []);
  assert.deepEqual(problemsFor(STAGING_SAFE), []);
  for (const value of ["", "prod", "Production", "PRODUCTION", "staging ", "preview"])
    refuses({ ...STAGING_SAFE, LEAGUE_DEPLOY_ENV: value }, "LEAGUE_DEPLOY_ENV");
  refuses(without(VALID_US, "LEAGUE_DEPLOY_ENV"), "LEAGUE_DEPLOY_ENV");
});

test("CLIENT_IP_HEADER must be exactly cf-connecting-ip", () => {
  assert.deepEqual(problemsFor(VALID_US), []);
  for (const value of ["CF-Connecting-IP", "x-forwarded-for", "x-real-ip", ""])
    refuses({ ...VALID_US, CLIENT_IP_HEADER: value }, "CLIENT_IP_HEADER");
  refuses(without(VALID_US, "CLIENT_IP_HEADER"), "CLIENT_IP_HEADER");
});

test("APP_URL must equal NEXT_PUBLIC_SITE_URL", () => {
  refuses({ ...VALID_US, NEXT_PUBLIC_SITE_URL: "https://ggd2l.vercel.app" }, "NEXT_PUBLIC_SITE_URL");
  refuses(without(VALID_US, "NEXT_PUBLIC_SITE_URL"), "NEXT_PUBLIC_SITE_URL");
  refuses(without(VALID_US, "APP_URL"), "APP_URL");
});

test("in production APP_URL must be the league's canonical origin", () => {
  for (const url of ["https://eu.ggd2l.com", "http://us.ggd2l.com", "https://ggd2l.vercel.app", "https://us.ggd2l.com/"])
    refuses({ ...VALID_US, APP_URL: url, NEXT_PUBLIC_SITE_URL: url }, "APP_URL");
  // Staging may use another origin (the on-demand ssh -L copy).
  const local = { ...STAGING_SAFE, APP_URL: "http://localhost:3190", NEXT_PUBLIC_SITE_URL: "http://localhost:3190" };
  assert.deepEqual(problemsFor(local), []);
  refuses({ ...local, APP_URL: "http://localhost:3190/x", NEXT_PUBLIC_SITE_URL: "http://localhost:3190/x" }, "APP_URL");
});

test("DATABASE_URL must equal DIRECT_URL", () => {
  refuses({ ...VALID_US, DIRECT_URL: DB.replace("connection_limit=8", "connection_limit=9") }, "DIRECT_URL");
  refuses(without(VALID_US, "DIRECT_URL"), "DIRECT_URL");
  refuses(without(without(VALID_US, "DATABASE_URL"), "DIRECT_URL"), "DATABASE_URL");
});

const withDb = (url) => ({ ...VALID_US, DATABASE_URL: url, DIRECT_URL: url });

test("the database host must be 127.0.0.1", () => {
  for (const host of ["localhost", "10.0.0.5", "ep-cool-1.us-east-2.aws.neon.tech", "[::1]"])
    refuses(withDb(DB.replace("127.0.0.1", host)), "DATABASE_URL");
});

test("the database user must be the league's app role", () => {
  for (const user of ["ggd2l_us_owner", "ggd2l_eu_app", "postgres", "vercel_production"])
    refuses(withDb(DB.replace("ggd2l_us_app", user)), "DATABASE_URL");
  // The EU app role is right for EU and wrong for US.
  refuses(withDb(DB.replace("ggd2l_us_app", "ggd2l_eu_app")), "DATABASE_URL", "us");
});

test("pgbouncer and channel_binding parameters are refused", () => {
  refuses(withDb(`${DB}&pgbouncer=true`), "DATABASE_URL");
  refuses(withDb(`${DB}&channel_binding=require`), "DATABASE_URL");
  refuses(withDb(`${DB}&PgBouncer=true`), "DATABASE_URL");
});

test("a test database name is refused", () => {
  for (const name of ["ld2l_test", "ld2l_pgtest", "ld2l_restore_test"])
    refuses(withDb(DB.replace("/ggd2l_us?", `/${name}?`)), "DATABASE_URL");
  assert.deepEqual(problemsFor(withDb(DB.replace("/ggd2l_us?", "/ggd2l_us_rehearsal?"))), []);
});

test("the server-action key must be the base64 of exactly 32 bytes", () => {
  for (const key of [
    Buffer.alloc(31, 1).toString("base64"),
    Buffer.alloc(33, 1).toString("base64"),
    Buffer.alloc(32, 1).toString("hex"),
    `${Buffer.alloc(32, 1).toString("base64")}\n`,
    Buffer.alloc(32, 255).toString("base64url"),
    "",
  ])
    refuses({ ...VALID_US, NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: key }, "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY");
  refuses(without(VALID_US, "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY"), "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY");
});

test("staging refuses every Discord credential, webhook and lobby bot setting", () => {
  for (const key of [
    "DISCORD_BOT_TOKEN",
    "DISCORD_CLIENT_SECRET",
    "DISCORD_WEBHOOK_URL",
    "DISCORD_INHOUSE_WEBHOOK_URL",
    "DISCORD_INHOUSE_ALERT_WEBHOOK_URL",
    "DOTA_LOBBY_BOT_URL",
    "DOTA_LOBBY_BOT_SECRET",
  ]) {
    refuses({ ...STAGING_SAFE, [key]: "https://example.invalid/x" }, key);
    // Production may hold them.
    assert.deepEqual(problemsFor({ ...VALID_US, [key]: "https://example.invalid/x" }), []);
  }
});

test("the region, dev login and secret distinctness rules", () => {
  refuses({ ...VALID_US, NEXT_PUBLIC_LEAGUE_REGION: "eu" }, "NEXT_PUBLIC_LEAGUE_REGION");
  refuses({ ...VALID_US, ALLOW_DEV_LOGIN: "true" }, "ALLOW_DEV_LOGIN");
  assert.deepEqual(problemsFor({ ...VALID_US, ALLOW_DEV_LOGIN: "false" }), []);
  refuses({ ...VALID_US, CRON_SECRET: VALID_US.AUTH_SECRET }, "CRON_SECRET");
});

test("a league env file may not set what the unit, release or slot sets", () => {
  for (const key of ["NODE_ENV", "NODE_OPTIONS", "PORT", "LEAGUE_RELEASE_SHA", "GGD2L_SKIP_BUILD_TYPECHECK", "MALLOC_ARENA_MAX"])
    refuses({ ...VALID_US, [key]: "1" }, key);
});

test("a slot's environment must carry the slot's port, production and a release sha", () => {
  assert.deepEqual(checkSlotEnv(SLOT_US_A, "us", "a"), []);
  assert.deepEqual(checkSlotEnv({ ...SLOT_US_A, PORT: "3002" }, "us", "b"), []);
  const has = (problems, name) => problems.some((problem) => problem.startsWith(`${name}:`));
  assert.ok(has(checkSlotEnv(SLOT_US_A, "us", "b"), "PORT"));
  assert.ok(has(checkSlotEnv({ ...SLOT_US_A, PORT: "3011" }, "us", "a"), "PORT"));
  assert.ok(has(checkSlotEnv({ ...SLOT_US_A, NODE_ENV: "development" }, "us", "a"), "NODE_ENV"));
  assert.ok(has(checkSlotEnv(without(SLOT_US_A, "LEAGUE_RELEASE_SHA"), "us", "a"), "LEAGUE_RELEASE_SHA"));
  assert.ok(has(checkSlotEnv({ ...SLOT_US_A, GGD2L_SKIP_BUILD_TYPECHECK: "1" }, "us", "a"), "GGD2L_SKIP_BUILD_TYPECHECK"));
  // The slot also gets every league rule.
  assert.ok(has(checkSlotEnv({ ...SLOT_US_A, VERCEL_ENV: "production" }, "us", "a"), "VERCEL_ENV"));
});

test("the env file parser handles quotes and comments and reports bad lines by number only", () => {
  const { env, problems } = parseEnvFile(
    [
      "# comment",
      "; also a comment",
      "",
      'APP_URL="https://us.ggd2l.com"',
      "CRON_SECRET='single quoted'",
      "PLAIN=a=b=c",
      "BROKEN LINE WITH SECRET hunter2hunter2",
      'UNBALANCED="hunter3hunter3',
      "PLAIN=again",
    ].join("\n"),
  );
  assert.equal(env.APP_URL, "https://us.ggd2l.com");
  assert.equal(env.CRON_SECRET, "single quoted");
  assert.equal(env.PLAIN, "again");
  assert.deepEqual(problems, ["line 7: not KEY=value", "line 8: unbalanced quote", "PLAIN: set more than once"]);
  assert.ok(!problems.join(" ").includes("hunter"));
});

test("the CLI accepts exactly one of --slot and --file", () => {
  assert.deepEqual(parseContractArgs(["--league", "us", "--slot", "a"]), { league: "us", slot: "a", file: undefined });
  assert.equal(parseContractArgs(["--league", "us"]), null);
  assert.equal(parseContractArgs(["--league", "us", "--slot", "a", "--file", "x"]), null);
  assert.equal(parseContractArgs(["--league", "xx", "--slot", "a"]), null);
  assert.equal(parseContractArgs(["--league", "us", "--slot", "c"]), null);
});

test("the CLI prints names only, never a value", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ggd2l-env-"));
  const file = path.join(dir, "us.env");
  const bad = {
    ...VALID_US,
    VERCEL_ENV: "vercel-value-should-not-print",
    LEAGUE_DEPLOY_ENV: "staging",
    DATABASE_URL: DB.replace("127.0.0.1", "db.example.invalid"),
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "not-a-key-value-1234",
  };
  writeFileSync(file, Object.entries(bad).map(([k, v]) => `${k}=${v}`).join("\n"));
  const result = spawnSync(process.execPath, [CLI, "--league", "us", "--file", file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  const report = JSON.parse(result.stderr);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => p.startsWith("DISCORD_BOT_TOKEN:")));
  for (const value of Object.values(bad)) if (value.length >= 4 && !["staging", "us"].includes(value)) assert.ok(!output.includes(value), "a value was printed");
  assert.ok(!output.includes(PASSWORD));

  writeFileSync(file, Object.entries(VALID_US).map(([k, v]) => `${k}=${v}`).join("\n"));
  const ok = spawnSync(process.execPath, [CLI, "--league", "us", "--file", file], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true, league: "us", problems: [] });
});
