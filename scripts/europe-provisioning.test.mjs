import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { authorizeEuropeBootstrap, europeBootstrapSql, runEuropeBootstrap } from "./bootstrap-europe.mjs";
import { instanceIdentitySql, executeInstanceSql } from "./instance-database.mjs";
import { validateProductionEnv } from "./validate-prod-env.mjs";
import { assertLocalManagedPostgresUrl } from "./test-db-safety.mjs";

const VALID = {
  VERCEL_ENV: "production",
  DATABASE_URL: "postgresql://league:pooled@ep-eu-pooler.eu-central-1.aws.neon.tech/league?sslmode=require",
  DIRECT_URL: "postgresql://league:direct@ep-eu.eu-central-1.aws.neon.tech/league?sslmode=require",
  AUTH_SECRET: "K3vM9zQ1rT8pL4xN7sW2dF6hJ0cB5yUaE9iO",
  CRON_SECRET: "N6pT2yK8mW4cR9hL1sD7vF3xB5qJ0zUaE2iG",
  BACKUP_RECEIPT_SECRET: "Q8rM4wT2yP9cL6hN1fD7sK3vB5xJ0zUaE2iG",
  STEAM_API_KEY: "0123456789ABCDEF0123456789ABCDEF",
  ADMIN_STEAM_IDS: "76561198000000001",
  APP_URL: "https://ggd2l-europe.vercel.app",
  NEXT_PUBLIC_SITE_URL: "https://ggd2l-europe.vercel.app",
  NEXT_PUBLIC_LEAGUE_REGION: "eu",
  NEXT_PUBLIC_APP_NAME: "GGD2L Europe",
  NEXT_PUBLIC_LEAGUE_TIMEZONE: "Europe/Berlin",
  NEXT_PUBLIC_MATCH_DAY: "",
  NEXT_PUBLIC_MATCH_TIME: "",
};

test("a fresh Europe site can launch with Discord and match night unannounced", () => {
  assert.deepEqual(validateProductionEnv(VALID), []);
  authorizeEuropeBootstrap(["--apply", VALID.APP_URL], VALID);
});

test("Europe rejects US identity, US invite, invalid timezone and half-announced schedules", () => {
  for (const overrides of [
    { NEXT_PUBLIC_LEAGUE_REGION: "Europe" },
    { APP_URL: "https://ggd2l.vercel.app", NEXT_PUBLIC_SITE_URL: "https://ggd2l.vercel.app" },
    { NEXT_PUBLIC_DISCORD_INVITE_URL: "https://discord.gg/H7PJ4VxUGh" },
    { NEXT_PUBLIC_DISCORD_INVITE_URL: "https://discord.com/invite/H7PJ4VxUGh" },
    { NEXT_PUBLIC_DISCORD_INVITE_URL: "https://discord.gg/new-code?redirect=us" },
    { NEXT_PUBLIC_LEAGUE_TIMEZONE: "America/Los_Angeles" },
    { NEXT_PUBLIC_LEAGUE_TIMEZONE: "Europe/Not_A_Zone" },
    { NEXT_PUBLIC_APP_NAME: "GGD2L" },
    { NEXT_PUBLIC_MATCH_DAY: "Sundays" },
  ]) assert.ok(validateProductionEnv({ ...VALID, ...overrides }).length > 0);
  assert.deepEqual(validateProductionEnv({ ...VALID, NEXT_PUBLIC_DISCORD_INVITE_URL: "https://discord.gg/europe-code" }), []);
});

test("existing US deployments require no new configuration", () => {
  const env = { ...VALID, NEXT_PUBLIC_LEAGUE_REGION: undefined, NEXT_PUBLIC_APP_NAME: undefined,
    NEXT_PUBLIC_LEAGUE_TIMEZONE: undefined, APP_URL: "https://ggd2l.vercel.app",
    NEXT_PUBLIC_SITE_URL: "https://ggd2l.vercel.app" };
  assert.deepEqual(validateProductionEnv(env), []);
});

test("bootstrap refuses wrong target and invalid environment before inspecting or writing", async () => {
  for (const { argv, env } of [
    { argv: [], env: VALID },
    { argv: ["--apply", "https://ggd2l.vercel.app"], env: VALID },
    { argv: ["--apply", VALID.APP_URL], env: { ...VALID, VERCEL_ENV: "preview" } },
    { argv: ["--apply", VALID.APP_URL], env: { ...VALID, NEXT_PUBLIC_LEAGUE_REGION: "us" } },
    { argv: ["--apply", VALID.APP_URL], env: { ...VALID, ADMIN_STEAM_IDS: "" } },
  ]) {
    let touched = false;
    await assert.rejects(runEuropeBootstrap({ argv, env,
      inspect: async () => { touched = true; }, executeSql: () => { touched = true; } }));
    assert.equal(touched, false);
  }
});

test("bootstrap requires successful migration attestation before writing", async () => {
  let written = false;
  await assert.rejects(runEuropeBootstrap({ argv: ["--apply", VALID.APP_URL], env: VALID,
    inspect: async () => { throw new Error("schema mismatch"); },
    executeSql: () => { written = true; } }), /schema mismatch/);
  assert.equal(written, false);
});

test("database subprocess errors do not expose connection secrets or SQL payloads", () => {
  assert.throws(() => executeInstanceSql("SELECT 1", { env: VALID,
    execute: () => ({ status: 1, stderr: `${VALID.DIRECT_URL} ${VALID.AUTH_SECRET}` }) }),
  /^Error: Instance database command failed; check connectivity, migrations and database permissions$/);
});

test("Europe scheduler active/pause configurations never address or rename the US worker", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../ops/cloudflare-automation-worker/${name}`, import.meta.url), "utf8"));
  const us = read("wrangler.jsonc");
  const eu = read("wrangler.europe.jsonc");
  const paused = read("wrangler.europe.paused.jsonc");
  assert.notEqual(eu.name, us.name);
  assert.equal(eu.vars.AUTOMATION_URL, `${VALID.APP_URL}/api/cron/automation`);
  assert.deepEqual(eu.triggers.crons, ["* * * * *"]);
  assert.deepEqual(paused.triggers.crons, []);
  assert.deepEqual({ ...paused, triggers: null }, { ...eu, triggers: null });
});

test("PostgreSQL bootstrap is empty-only, atomic, concurrency-safe and region-isolated", {
  skip: !process.env.PG_TEST_URL && "Set PG_TEST_URL to an existing local disposable test database",
}, async () => {
  const target = assertLocalManagedPostgresUrl(process.env.PG_TEST_URL);
  const schema = `eu_provision_${randomUUID().replaceAll("-", "")}`;
  const pgEnv = {
    PATH: process.env.PATH,
    PGHOST: target.hostname,
    PGPORT: target.port || "5432",
    PGUSER: decodeURIComponent(target.username),
    PGPASSWORD: decodeURIComponent(target.password),
    PGDATABASE: decodeURIComponent(target.pathname.slice(1)),
    PGOPTIONS: `-c search_path=${schema}`,
  };
  const args = ["-X", "--no-password", "--set=ON_ERROR_STOP=1", "--tuples-only", "--no-align"];
  const run = (sql, failure = false) => {
    const result = spawnSync("psql", args, { env: pgEnv, input: sql, encoding: "utf8" });
    if (failure) assert.notEqual(result.status, 0, "expected transactional refusal");
    else assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const scalar = (sql) => run(sql).stdout.trim();
  run(`CREATE SCHEMA "${schema}";`);
  try {
    const migrations = new URL("../prisma/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter((name) => /^\d/.test(name)).sort()) {
      run(readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"));
    }
    // An unrelated application's row also prevents the first write.
    run('CREATE TABLE "ExistingData" (id int); INSERT INTO "ExistingData" VALUES (1);');
    assert.match(run(europeBootstrapSql(VALID), true).stderr, /every application table to be empty/);
    assert.equal(scalar('SELECT COUNT(*) FROM "Season";'), "0");
    assert.equal(scalar('SELECT COUNT(*) FROM "Setting";'), "0");
    run('DROP TABLE "ExistingData";');
    // Two concurrent bootstraps produce one complete instance, never two.
    const attempt = () => new Promise((resolve, reject) => {
      const child = spawn("psql", args, { env: pgEnv, stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", reject);
      child.on("close", resolve);
      child.stdin.end(europeBootstrapSql(VALID));
    });
    assert.deepEqual((await Promise.all([attempt(), attempt()])).sort(), [0, 3]);
    assert.equal(scalar('SELECT COUNT(*) FROM "Season";'), "1");
    assert.equal(scalar('SELECT COUNT(*) FROM "Setting";'), "2");
    assert.equal(scalar('SELECT COUNT(*) FROM "User";'), "0");
    assert.equal(scalar(`SELECT COUNT(*) FROM "Season" WHERE "status" = 'SIGNUPS' AND "firstMatchNight" IS NULL AND "draftAt" IS NULL AND "matchSchedule" = 'Match night to be announced';`), "1");
    run(instanceIdentitySql(VALID));
    // Exercise the exact temporary-datasource command used by production
    // builds as well as the native SQL checks above.
    const scopedTarget = new URL(target);
    scopedTarget.searchParams.set("schema", schema);
    executeInstanceSql(instanceIdentitySql(VALID), {
      env: { PATH: process.env.PATH, DIRECT_URL: scopedTarget.href },
    });
    assert.match(run(instanceIdentitySql({ ...VALID, APP_URL: "https://other-eu.example" }), true).stderr, /different site origin/);
    assert.match(run(instanceIdentitySql({ ...VALID, NEXT_PUBLIC_LEAGUE_REGION: "us" }), true).stderr, /different league region/);
    assert.match(run(europeBootstrapSql(VALID), true).stderr, /every application table to be empty/);
    assert.equal(scalar('SELECT COUNT(*) FROM "Season";'), "1");
    run('DELETE FROM "Setting";');
    assert.match(run(instanceIdentitySql(VALID), true).stderr, /identity is missing or incorrect/);
    run(instanceIdentitySql({ APP_URL: "https://ggd2l.vercel.app" }));
  } finally {
    run(`DROP SCHEMA "${schema}" CASCADE;`);
  }
});
