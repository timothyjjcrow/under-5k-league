// The env contract (design §1.4): what a league's env may and may not hold on
// the box. It runs in three places and always prints NAMES only, never a value:
//
//   ExecStartPre   node env-contract.mjs --league us --slot a      (the unit's own env)
//   install-kit    node env-contract.mjs --league us --file /etc/ggd2l/us.env
//   the agent      import { checkLeagueEnv } before every build, attest and envcheck
//   the bot        node env-contract.mjs --bot                      (ggd2l-bot's ExecStartPre)
//                  node env-contract.mjs --bot --file /etc/ggd2l/bot.env
//
// It holds only rules a working box always passes, the ones without which a
// slot must not serve at all: the database, the origin, the marker, the action
// key, no Vercel, Neon or test keys, no dev login. The production validation
// (scripts/validate-prod-env.mjs: the secrets' length and shape,
// ADMIN_STEAM_IDS, STEAM_API_KEY, the Discord pairs) runs in every build and
// in `envcheck`, before the restart that reads an edited file, and never at a
// slot's start: a refused start turns a broken sign-in or admin list into a
// league that is down, and after a reboot both leagues at once.
//
// A file is the league env as written (/etc/ggd2l/<lg>.env): the keys the unit
// or release sets (NODE_ENV, PORT, LEAGUE_RELEASE_SHA...) must not be in it. A
// slot is the full environment systemd hands the server, so those keys must be
// present and right.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PORTS, PUBLIC_HOST } from "./layout.mjs";

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

// Where a production league reaches the lobby bot: the bot on this box over
// loopback (ggd2l-bot.service binds 127.0.0.1:8090), or the Cloudflare relay
// until the bot moves here. Unset is fine (no bot). Anything else would send
// the bot's bearer secret somewhere new, or over plain http off the box.
export const BOT_LOOPBACK_ORIGIN = "http://127.0.0.1:8090";
export const BOT_RELAY_ORIGIN = "https://ggd2l-dota-lobby-relay.ggd2l.workers.dev";
const PRODUCTION_BOT_ORIGINS = new Set([BOT_LOOPBACK_ORIGIN, BOT_RELAY_ORIGIN]);

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

/**
 * The bot URL's origin when it is a bare origin (the site's own rule: no
 * path past "/", no query, fragment or credentials), else null. A trailing
 * "/" is the same origin.
 */
function botOriginOf(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    return null;
  if (value !== url.origin && value !== `${url.origin}/`) return null;
  return url.origin;
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

  // A declared deployment builds every redirect, the same-origin guard and the
  // Steam and Discord return URLs from APP_URL (src/lib/public-origin.ts), so
  // in production and in the rehearsal alike it is the league's own https
  // origin: never http, another scheme, the bind address or the other league.
  const origin = `https://${PUBLIC_HOST[lg]}`;
  if (!has("APP_URL")) problems.push("APP_URL: missing");
  else if (env.APP_URL !== origin) problems.push(`APP_URL: must be exactly ${origin}`);
  if (env.NEXT_PUBLIC_SITE_URL !== env.APP_URL)
    problems.push("NEXT_PUBLIC_SITE_URL: must equal APP_URL");

  problems.push(...databaseUrlProblems(env, lg));

  if (!strictBase64Of32Bytes(env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY))
    problems.push("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: must be the base64 of 32 bytes");

  if (deployEnv === "staging") {
    for (const key of STAGING_FORBIDDEN)
      if (has(key)) problems.push(`${key}: not allowed in staging`);
  }

  if (deployEnv === "production" && has("DOTA_LOBBY_BOT_URL") && env.DOTA_LOBBY_BOT_URL !== "") {
    if (!PRODUCTION_BOT_ORIGINS.has(botOriginOf(env.DOTA_LOBBY_BOT_URL)))
      problems.push(
        `DOTA_LOBBY_BOT_URL: must be unset, exactly ${BOT_LOOPBACK_ORIGIN} or exactly ${BOT_RELAY_ORIGIN}`,
      );
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

// The lobby bot's env (design §7). ggd2l-bot.service sets NODE_ENV, HOST and
// PORT and then reads /etc/ggd2l/bot.env, whose values OVERRIDE the unit's
// (systemd lets EnvironmentFile= win over Environment=): a bot.env copied
// from the Mac's .env would bring DOTA_BOT_STATE_DIR="./state", a path under
// the read-only release, and the bot would never start.
export const BOT_STATE_DIR = "/var/lib/ggd2l-bot";
const BOT_UNIT_ENV = { NODE_ENV: "production", HOST: "127.0.0.1", PORT: "8090" };

/**
 * The rules for the bot's env: bot.env as written (`mode: "file"`), or the
 * whole environment the unit hands the bot (`mode: "unit"`, its
 * ExecStartPre). Names only, never a value.
 */
export function checkBotEnv(env, { mode = "file" } = {}) {
  const problems = [];
  const has = (key) => Object.hasOwn(env, key) && env[key] !== undefined;
  // The login helper run by hand (systemd-run) gets none of the unit's
  // Environment=, so the file carries the state directory itself.
  if (env.DOTA_BOT_STATE_DIR !== BOT_STATE_DIR)
    problems.push(`DOTA_BOT_STATE_DIR: must be exactly ${BOT_STATE_DIR}`);
  const secret = env.DOTA_LOBBY_BOT_SECRET ?? "";
  if (secret.length < 32 || secret.length > 512 || /\s/.test(secret))
    problems.push("DOTA_LOBBY_BOT_SECRET: must be 32 to 512 characters with no whitespace");
  // The bot signs in with its saved Steam session; the password never
  // lives on the box.
  if (has("STEAM_BOT_PASSWORD")) problems.push("STEAM_BOT_PASSWORD: not allowed on the box");
  // bot.env's values override the unit's. A file may repeat the unit's own
  // value, which changes nothing (docs/DOTA-LOBBY-BOT.md's key whitelist
  // leaves them out), but never set another.
  for (const [key, value] of Object.entries(BOT_UNIT_ENV)) {
    if (mode === "file") {
      if (has(key) && env[key] !== value)
        problems.push(`${key}: set by the unit; bot.env may only repeat ${value}`);
    } else if (env[key] !== value) {
      problems.push(`${key}: must be ${value}`);
    }
  }
  return problems;
}

export function checkBotEnvFile(file, read = readFileSync) {
  let text;
  try {
    text = read(file, "utf8");
  } catch {
    return { env: null, problems: ["file: unreadable"] };
  }
  const { env, problems } = parseEnvFile(text);
  return { env, problems: [...problems, ...checkBotEnv(env, { mode: "file" })] };
}

export function parseContractArgs(argv) {
  if (argv[0] === "--bot") {
    if (argv.length === 1) return { bot: true };
    if (argv.length === 3 && argv[1] === "--file" && argv[2]) return { bot: true, file: argv[2] };
    return null;
  }
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
    out.error(
      "usage: env-contract.mjs --league us|eu (--slot a|b | --file <path>)\n" +
        "       env-contract.mjs --bot [--file <path>]",
    );
    return 2;
  }
  if (options.bot) {
    const problems = options.file
      ? checkBotEnvFile(options.file).problems
      : checkBotEnv(env, { mode: "unit" });
    const report = { ok: problems.length === 0, bot: true, problems };
    (problems.length ? out.error : out.log)(JSON.stringify(report));
    return problems.length ? 1 : 0;
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
