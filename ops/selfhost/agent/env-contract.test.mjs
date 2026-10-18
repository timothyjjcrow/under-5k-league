import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBotEnv, checkLeagueEnv, checkSlotEnv, parseContractArgs, parseEnvFile } from "./env-contract.mjs";

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

test("APP_URL is the league's own https origin in production and in staging", () => {
  const wrong = [
    "https://eu.ggd2l.com",
    "http://us.ggd2l.com",
    "ftp://us.ggd2l.com",
    "https://ggd2l.vercel.app",
    "https://us.ggd2l.com/",
    "https://us.ggd2l.com:443",
    "https://US.ggd2l.com",
    "https://us.ggd2l.com/path",
    "http://127.0.0.1:3001",
    "https://127.0.0.1:3001",
    "https://localhost:3001",
    "http://localhost:3190",
    "https://[::1]:3001",
    "",
  ];
  // NEXT_PUBLIC_SITE_URL agrees in every case, so only the APP_URL rule can refuse.
  for (const base of [VALID_US, STAGING_SAFE])
    for (const url of wrong) {
      const problems = problemsFor({ ...base, APP_URL: url, NEXT_PUBLIC_SITE_URL: url });
      assert.deepEqual(problems, ["APP_URL: must be exactly https://us.ggd2l.com"], `${base.LEAGUE_DEPLOY_ENV} ${url}`);
    }
  // EU's own origin is right for EU and wrong for US, in both modes.
  const eu = {
    ...STAGING_SAFE,
    DATABASE_URL: DB.replaceAll("ggd2l_us", "ggd2l_eu"),
    DIRECT_URL: DB.replaceAll("ggd2l_us", "ggd2l_eu"),
    APP_URL: "https://eu.ggd2l.com",
    NEXT_PUBLIC_SITE_URL: "https://eu.ggd2l.com",
    NEXT_PUBLIC_LEAGUE_REGION: "eu",
  };
  assert.deepEqual(problemsFor(eu, "eu"), []);
  assert.deepEqual(problemsFor({ ...eu, APP_URL: "https://us.ggd2l.com", NEXT_PUBLIC_SITE_URL: "https://us.ggd2l.com" }, "eu"), [
    "APP_URL: must be exactly https://eu.ggd2l.com",
  ]);
  // A slot's ExecStartPre applies the same rule.
  assert.ok(checkSlotEnv({ ...SLOT_US_A, LEAGUE_DEPLOY_ENV: "staging", DISCORD_BOT_TOKEN: undefined, DISCORD_CLIENT_SECRET: undefined, APP_URL: "http://127.0.0.1:3001", NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3001" }, "us", "a").includes("APP_URL: must be exactly https://us.ggd2l.com"));
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
    // Production may hold them (the bot's URL only where the next test says).
    const value = key === "DOTA_LOBBY_BOT_URL" ? "http://127.0.0.1:8090" : "https://example.invalid/x";
    assert.deepEqual(problemsFor({ ...VALID_US, [key]: value }), []);
  }
});

const EU_OVERRIDES = Object.freeze({
  DATABASE_URL: DB.replaceAll("ggd2l_us", "ggd2l_eu"),
  DIRECT_URL: DB.replaceAll("ggd2l_us", "ggd2l_eu"),
  APP_URL: "https://eu.ggd2l.com",
  NEXT_PUBLIC_SITE_URL: "https://eu.ggd2l.com",
  NEXT_PUBLIC_LEAGUE_REGION: "eu",
});

test("production reaches the lobby bot on this box or through the relay, nowhere else", () => {
  for (const url of [
    "http://127.0.0.1:8090",
    "http://127.0.0.1:8090/",
    "https://ggd2l-dota-lobby-relay.ggd2l.workers.dev",
    "https://ggd2l-dota-lobby-relay.ggd2l.workers.dev/",
    // Unset, or set empty: no bot.
    "",
  ])
    for (const lg of ["us", "eu"]) {
      const env = lg === "us" ? VALID_US : { ...VALID_US, ...EU_OVERRIDES };
      assert.deepEqual(problemsFor({ ...env, DOTA_LOBBY_BOT_URL: url }, lg), [], `${lg} ${url}`);
    }
  assert.deepEqual(problemsFor(VALID_US), []);
  for (const url of [
    "http://localhost:8090",
    "http://[::1]:8090",
    "http://127.0.0.1:8091",
    "http://127.0.0.1",
    "http://10.0.0.5:8090",
    "https://relay.example",
    "http://ggd2l-dota-lobby-relay.ggd2l.workers.dev",
    "https://ggd2l-dota-lobby-relay.ggd2l.workers.dev/lobby",
    "https://ggd2l-dota-lobby-relay.ggd2l.workers.dev?x=1",
    "https://user:pw@ggd2l-dota-lobby-relay.ggd2l.workers.dev",
    "not a url",
  ])
    refuses({ ...VALID_US, DOTA_LOBBY_BOT_URL: url }, "DOTA_LOBBY_BOT_URL");
  // The refusal names the key and the two accepted origins, never the value.
  const [problem] = problemsFor({ ...VALID_US, DOTA_LOBBY_BOT_URL: "https://secret-host.invalid" });
  assert.ok(!problem.includes("secret-host"));
});

test("the lobby bot's own env: its state directory, its secret, no Steam password, the unit's settings left alone", () => {
  const BOT_SECRET = "b0t-secret-".repeat(4);
  const file = Object.freeze({
    DOTA_LOBBY_BOT_SECRET: BOT_SECRET,
    DOTA_BOT_STATE_DIR: "/var/lib/ggd2l-bot",
    DOTA_LOBBY_RELAY_URL: "https://ggd2l-dota-lobby-relay.ggd2l.workers.dev",
    DOTA_RELAY_WORKER_SECRET: "relay-secret-".repeat(3),
    DOTA_GAME_SERVER_REGIONS: "2",
  });
  const unit = Object.freeze({ ...file, NODE_ENV: "production", HOST: "127.0.0.1", PORT: "8090" });
  const has = (problems, name) => problems.some((problem) => problem.startsWith(`${name}:`));
  assert.deepEqual(checkBotEnv(file), []);
  assert.deepEqual(checkBotEnv(unit, { mode: "unit" }), []);
  // The Mac's .env copied whole: a relative state directory, and the unit's
  // own settings, which bot.env would override.
  for (const [key, value] of [["DOTA_BOT_STATE_DIR", "./state"], ["HOST", "127.0.0.1"], ["PORT", "8090"], ["NODE_ENV", "production"]])
    assert.ok(has(checkBotEnv({ ...file, [key]: value }), key), key);
  assert.ok(has(checkBotEnv(without(file, "DOTA_BOT_STATE_DIR")), "DOTA_BOT_STATE_DIR"));
  assert.ok(has(checkBotEnv({ ...file, STEAM_BOT_PASSWORD: "hunter2" }), "STEAM_BOT_PASSWORD"));
  assert.ok(has(checkBotEnv({ ...unit, STEAM_BOT_PASSWORD: "hunter2" }, { mode: "unit" }), "STEAM_BOT_PASSWORD"));
  for (const secret of [undefined, "short", `${"x".repeat(40)} y`])
    assert.ok(has(checkBotEnv({ ...file, DOTA_LOBBY_BOT_SECRET: secret }), "DOTA_LOBBY_BOT_SECRET"));
  // In the unit's environment, an override from bot.env shows as a changed value.
  for (const [key, value] of [["HOST", "0.0.0.0"], ["PORT", "80"], ["NODE_ENV", "development"], ["DOTA_BOT_STATE_DIR", "./state"]])
    assert.ok(has(checkBotEnv({ ...unit, [key]: value }, { mode: "unit" }), key), key);
});

test("the bot CLI checks the unit's environment or a file, by names only", () => {
  assert.deepEqual(parseContractArgs(["--bot"]), { bot: true });
  assert.deepEqual(parseContractArgs(["--bot", "--file", "/etc/ggd2l/bot.env"]), { bot: true, file: "/etc/ggd2l/bot.env" });
  assert.equal(parseContractArgs(["--bot", "--league", "us"]), null);
  assert.equal(parseContractArgs(["--bot", "--file"]), null);
  const value = "bot-secret-that-must-not-print-0123456789";
  const env = {
    PATH: process.env.PATH,
    DOTA_LOBBY_BOT_SECRET: value,
    DOTA_BOT_STATE_DIR: "./state",
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "8090",
  };
  const bad = spawnSync(process.execPath, [CLI, "--bot"], { encoding: "utf8", env });
  assert.equal(bad.status, 1);
  assert.deepEqual(JSON.parse(bad.stderr), {
    ok: false,
    bot: true,
    problems: ["DOTA_BOT_STATE_DIR: must be exactly /var/lib/ggd2l-bot"],
  });
  assert.ok(!(bad.stdout + bad.stderr).includes(value));
  const good = spawnSync(process.execPath, [CLI, "--bot"], {
    encoding: "utf8",
    env: { ...env, DOTA_BOT_STATE_DIR: "/var/lib/ggd2l-bot" },
  });
  assert.equal(good.status, 0);
  assert.deepEqual(JSON.parse(good.stdout), { ok: true, bot: true, problems: [] });
  const dir = mkdtempSync(path.join(tmpdir(), "ggd2l-bot-env-"));
  const file = path.join(dir, "bot.env");
  writeFileSync(file, `DOTA_LOBBY_BOT_SECRET=${value}\nDOTA_BOT_STATE_DIR=/var/lib/ggd2l-bot\nPORT=8090\n`);
  const fromFile = spawnSync(process.execPath, [CLI, "--bot", "--file", file], { encoding: "utf8" });
  assert.equal(fromFile.status, 1);
  assert.deepEqual(JSON.parse(fromFile.stderr).problems, ["PORT: set by the unit, not bot.env"]);
  assert.ok(!(fromFile.stdout + fromFile.stderr).includes(value));
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
