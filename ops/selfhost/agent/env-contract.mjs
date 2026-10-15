// The env contract (design §1.4): what a league's env may and may not hold on
// the box. It runs in three places and always prints NAMES only, never a value:
//
//   ExecStartPre   node env-contract.mjs --league us --slot a      (the unit's own env)
//   envcheck       node env-contract.mjs --league us --file /etc/ggd2l/us.env
//   the agent      import { checkLeagueEnv } before every build and attest
//
// A file is the league env as written (/etc/ggd2l/<lg>.env): the keys the unit
// or release sets (NODE_ENV, PORT, LEAGUE_RELEASE_SHA...) must not be in it. A
// slot is the full environment systemd hands the server, so those keys must be
// present and right.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PORTS } from "./layout.mjs";

const FORBIDDEN_KEYS = new Set([
  "BUILD_DB_DRY_RUN",
  "PRISMA_ACCEPT_DATA_LOSS",
  "PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK",
  "DISCORD_API_BASE",
  "NEXT_DIST_DIR",
  "HOSTNAME",
  "DATABASE_URL_UNPOOLED",
]);
// Vercel's own keys and every Neon integration key (PGHOST, POSTGRES_URL...).
const FORBIDDEN_PREFIXES = ["VERCEL", "PG", "POSTGRES_", "NEON_"];

// Set by the unit, the release or the slot; never by the league env file,
// where an EnvironmentFile= line would silently override the unit's value.
const UNIT_OWNED_KEYS = [
  "NODE_ENV",
  "NODE_OPTIONS",
  "NEXT_TELEMETRY_DISABLED",
  "MALLOC_ARENA_MAX",
  "PORT",
  "LEAGUE_RELEASE_SHA",
  "GGD2L_SKIP_BUILD_TYPECHECK",
];

// The rehearsal and any later staging copy must hold no way to reach Discord
// or the lobby bot (design §4).
const STAGING_FORBIDDEN = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_WEBHOOK_URL",
  "DISCORD_INHOUSE_WEBHOOK_URL",
  "DISCORD_INHOUSE_ALERT_WEBHOOK_URL",
  "DOTA_LOBBY_BOT_URL",
  "DOTA_LOBBY_BOT_SECRET",
];

const TEST_DATABASES = new Set(["ld2l_test", "ld2l_pgtest", "ld2l_restore_test"]);
const DISTINCT_SECRETS = ["AUTH_SECRET", "CRON_SECRET", "BACKUP_RECEIPT_SECRET"];
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a systemd EnvironmentFile. Supports KEY=value, '#' and ';' comments,
 * blank lines and one level of single or double quotes. A malformed line is
 * reported by its number only, so a value never reaches the output.
 */
export function parseEnvFile(text) {
  const env = {};
  const problems = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) return;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!KEY_RE.test(key)) {
      problems.push(`line ${index + 1}: not KEY=value`);
      return;
    }
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(["\\$`])/g, "$1");
    } else if (quote === '"' || quote === "'") {
      problems.push(`line ${index + 1}: unbalanced quote`);
      return;
    }
    if (Object.hasOwn(env, key)) problems.push(`${key}: set more than once`);
    env[key] = value;
  });
  return { env, problems };
}

function bareOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value ? url : null;
  } catch {
    return null;
  }
}

function strictBase64Of32Bytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 && bytes.toString("base64") === value;
}

function databaseUrlProblems(env, lg) {
  const problems = [];
  const raw = env.DATABASE_URL;
  if (!raw) return ["DATABASE_URL: missing"];
  if (env.DIRECT_URL !== raw) problems.push("DIRECT_URL: must equal DATABASE_URL");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return [...problems, "DATABASE_URL: not a URL"];
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:")
    problems.push("DATABASE_URL: not a postgresql URL");
  if (url.hostname !== "127.0.0.1") problems.push("DATABASE_URL: host must be 127.0.0.1");
  let user = "";
  try {
    user = decodeURIComponent(url.username);
  } catch {
    // An undecodable user is simply the wrong user.
  }
  if (user !== `ggd2l_${lg}_app`) problems.push(`DATABASE_URL: user must be ggd2l_${lg}_app`);
  for (const key of url.searchParams.keys()) {
    const name = key.toLowerCase();
    if (name === "pgbouncer" || name === "channel_binding")
      problems.push(`DATABASE_URL: ${name} parameter is not allowed`);
  }
  let database = url.pathname.replace(/^\//, "");
  try {
    database = decodeURIComponent(database);
  } catch {
    // Compared as written.
  }
  if (TEST_DATABASES.has(database)) problems.push("DATABASE_URL: names a test database");
  return problems;
}

/** The rules every league env must pass, in a file or in a running slot. */
export function checkLeagueEnv(env, lg, { mode = "file" } = {}) {
  if (lg !== "us" && lg !== "eu") return ["league: must be us or eu"];
  const problems = [];
  const has = (key) => Object.hasOwn(env, key) && env[key] !== undefined;

  for (const key of Object.keys(env)) {
    if (FORBIDDEN_KEYS.has(key) || FORBIDDEN_PREFIXES.some((prefix) => key.startsWith(prefix)))
      problems.push(`${key}: not allowed on the box`);
  }

  const deployEnv = env.LEAGUE_DEPLOY_ENV;
  if (deployEnv !== "production" && deployEnv !== "staging")
    problems.push("LEAGUE_DEPLOY_ENV: must be exactly production or staging");
  if (env.CLIENT_IP_HEADER !== "cf-connecting-ip")
    problems.push("CLIENT_IP_HEADER: must be exactly cf-connecting-ip");
  if (env.NEXT_PUBLIC_LEAGUE_REGION !== lg)
    problems.push(`NEXT_PUBLIC_LEAGUE_REGION: must be ${lg}`);

  if (!has("APP_URL")) problems.push("APP_URL: missing");
  else if (!bareOrigin(env.APP_URL)) problems.push("APP_URL: must be a bare origin");
  if (env.NEXT_PUBLIC_SITE_URL !== env.APP_URL)
    problems.push("NEXT_PUBLIC_SITE_URL: must equal APP_URL");
  if (deployEnv === "production" && env.APP_URL !== `https://${lg}.ggd2l.com`)
    problems.push(`APP_URL: must be https://${lg}.ggd2l.com in production`);

  problems.push(...databaseUrlProblems(env, lg));

  if (!strictBase64Of32Bytes(env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY))
    problems.push("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: must be the base64 of 32 bytes");

  if (deployEnv === "staging") {
    for (const key of STAGING_FORBIDDEN)
      if (has(key)) problems.push(`${key}: not allowed in staging`);
  }

  if (has("ALLOW_DEV_LOGIN") && env.ALLOW_DEV_LOGIN !== "false")
    problems.push("ALLOW_DEV_LOGIN: must be unset or exactly false");

  const secrets = DISTINCT_SECRETS.filter((key) => env[key]);
  for (let i = 0; i < secrets.length; i++)
    for (let j = i + 1; j < secrets.length; j++)
      if (env[secrets[i]] === env[secrets[j]])
        problems.push(`${secrets[j]}: must differ from ${secrets[i]}`);

  if (mode === "file") {
    for (const key of UNIT_OWNED_KEYS)
      if (has(key)) problems.push(`${key}: set by the unit, not the league env file`);
  }
  return problems;
}

/** The extra rules for the environment a slot's server actually starts with. */
export function checkSlotEnv(env, lg, slot) {
  const problems = checkLeagueEnv(env, lg, { mode: "slot" });
  const port = PORTS[lg]?.[slot];
  if (!port) return [...problems, "slot: must be a or b"];
  if (env.PORT !== String(port)) problems.push(`PORT: must be ${port} for slot ${slot}`);
  if (env.NODE_ENV !== "production") problems.push("NODE_ENV: must be production");
  if (!/^[0-9a-f]{40}$/.test(env.LEAGUE_RELEASE_SHA ?? ""))
    problems.push("LEAGUE_RELEASE_SHA: must be a 40-character sha");
  if (Object.hasOwn(env, "GGD2L_SKIP_BUILD_TYPECHECK"))
    problems.push("GGD2L_SKIP_BUILD_TYPECHECK: build-only, not allowed at runtime");
  return problems;
}

export function checkEnvFile(file, lg, read = readFileSync) {
  let text;
  try {
    text = read(file, "utf8");
  } catch {
    return { env: null, problems: ["file: unreadable"] };
  }
  const { env, problems } = parseEnvFile(text);
  return { env, problems: [...problems, ...checkLeagueEnv(env, lg, { mode: "file" })] };
}

export function parseContractArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--league", "--slot", "--file"].includes(flag) || value === undefined || options[flag])
      return null;
    options[flag] = value;
  }
  const league = options["--league"];
  if (league !== "us" && league !== "eu") return null;
  if (Boolean(options["--slot"]) === Boolean(options["--file"])) return null;
  if (options["--slot"] && !["a", "b"].includes(options["--slot"])) return null;
  return { league, slot: options["--slot"], file: options["--file"] };
}

export function runContractCli(argv = process.argv.slice(2), env = process.env, out = console) {
  const options = parseContractArgs(argv);
  if (!options) {
    out.error("usage: env-contract.mjs --league us|eu (--slot a|b | --file <path>)");
    return 2;
  }
  const problems = options.slot
    ? checkSlotEnv(env, options.league, options.slot)
    : checkEnvFile(options.file, options.league).problems;
  const report = { ok: problems.length === 0, league: options.league, problems };
  (problems.length ? out.error : out.log)(JSON.stringify(report));
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runContractCli();
}
