// A fake box for the agent's tests: the installed layout under a temporary
// root, and a runner whose spawns are recorded and answered by handlers.
// Named *.test.mjs so the install never copies it; it holds no tests itself.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLayout } from "./layout.mjs";
import { createRunner } from "./runner.mjs";

export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
export const PASSWORD = "9e".repeat(32);
export const OWNER_PASSWORD = "4c".repeat(32);
export const T0 = Date.parse("2026-10-16T15:00:00Z");

export function databaseUrl(lg, role = "app", password = PASSWORD) {
  return `postgresql://ggd2l_${lg}_${role}:${password}@127.0.0.1:5432/ggd2l_${lg}?schema=public&sslmode=disable&connection_limit=8&pool_timeout=10&connect_timeout=5`;
}

export function leagueEnv(lg, overrides = {}) {
  return {
    DATABASE_URL: databaseUrl(lg),
    DIRECT_URL: databaseUrl(lg),
    AUTH_SECRET: `auth-secret-${lg}-0123456789abcdef`,
    CRON_SECRET: `cron-secret-${lg}-0123456789abcdef`,
    BACKUP_RECEIPT_SECRET: `receipt-secret-${lg}-0123456789`,
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: Buffer.alloc(32, lg === "us" ? 3 : 4).toString("base64"),
    STEAM_API_KEY: "STEAMKEY0123456789ABCDEF0123",
    DISCORD_CLIENT_ID: "1545719497472741466",
    DISCORD_CLIENT_SECRET: "discord-client-secret-abcdef",
    DISCORD_BOT_TOKEN: "discord-bot-token-0123456789",
    DOTA_LOBBY_BOT_SECRET: "lobby-bot-secret-0123456789",
    APP_URL: `https://${lg}.ggd2l.com`,
    NEXT_PUBLIC_SITE_URL: `https://${lg}.ggd2l.com`,
    NEXT_PUBLIC_LEAGUE_REGION: lg,
    LEAGUE_DEPLOY_ENV: "production",
    CLIENT_IP_HEADER: "cf-connecting-ip",
    ...overrides,
  };
}

/** Values that must never reach a command line. */
export function secretsOf(env) {
  return [
    env.DATABASE_URL,
    env.AUTH_SECRET,
    env.CRON_SECRET,
    env.BACKUP_RECEIPT_SECRET,
    env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,
    env.STEAM_API_KEY,
    env.DISCORD_CLIENT_SECRET,
    env.DISCORD_BOT_TOKEN,
    env.DOTA_LOBBY_BOT_SECRET,
    PASSWORD,
    OWNER_PASSWORD,
  ].filter(Boolean);
}

const envText = (env) => `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;

export function makeBox() {
  const root = mkdtempSync(path.join(tmpdir(), "ggd2l-box-"));
  const layout = createLayout(root);
  for (const dir of [
    "etc/ggd2l",
    "etc/caddy/ggd2l",
    "srv/ggd2l/repo.git",
    "srv/ggd2l/tools",
    "srv/ggd2l/www",
    "usr/local/lib/ggd2l/sql",
    "var/log/caddy",
    "var/log/ggd2l/builds",
    "run",
    "var/run",
  ])
    mkdirSync(path.join(root, dir), { recursive: true });
  for (const lg of ["us", "eu"]) {
    for (const dir of [`srv/ggd2l/${lg}/releases`, `srv/ggd2l/${lg}/slots`, `var/lib/ggd2l/${lg}`, `var/backups/ggd2l/${lg}/local`, `var/backups/ggd2l/cutover/${lg}`])
      mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(layout.caddyfile, "# test Caddyfile\n");

  const calls = [];
  const handlers = [];
  // Who owns what, as the agent's own chown and `install -d -o` calls left it
  // (they never run here): ctx.ownerOf answers 0 only for a path root took.
  // Everything else is the build user's, as a clone is until it is locked.
  const owners = new Map();
  const BUILD_UID = 1500;
  const recordOwner = (command, args) => {
    if (command.endsWith("/chown"))
      owners.set(path.resolve(args.at(-1)), args.find((arg) => !arg.startsWith("-")).split(":")[0]);
    else if (command.endsWith("/install") && args[0] === "-d" && args.includes("-o"))
      owners.set(path.resolve(args.at(-1)), args[args.indexOf("-o") + 1]);
  };
  const spawnImpl = async (command, args, options) => {
    calls.push({ command, args, env: options.env, input: options.input, cwd: options.cwd });
    recordOwner(command, args);
    for (const handler of handlers) {
      const result = await handler(command, args, options);
      if (result) {
        for (const line of result.lines ?? []) options.onLine?.(line, "stdout");
        return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
    }
    // A oneshot unit the test did not script finished successfully.
    if (command.endsWith("/systemctl") && args[0] === "show" && args.includes("--property=Result"))
      return { code: 0, stdout: "success\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const clock = { t: T0 };
  const box = {
    root,
    layout,
    calls,
    clock,
    health: () => 200,
    free: 100 * 1024 ** 3,
    on(handler) {
      handlers.unshift(handler);
      return box;
    },
    writeEnv(lg, env = leagueEnv(lg)) {
      writeFileSync(layout.leagueEnv(lg), envText(env), { mode: 0o600 });
      writeFileSync(layout.migrateEnv(lg), envText({ DATABASE_URL: databaseUrl(lg, "owner", OWNER_PASSWORD), DIRECT_URL: databaseUrl(lg, "owner", OWNER_PASSWORD) }), { mode: 0o600 });
      return env;
    },
    argv: () => calls.map((call) => [call.command, ...call.args]),
    commandsMatching: (pattern) => calls.filter((call) => pattern.test([call.command, ...call.args].join(" "))),
    /** Mark a path as owned by `owner`, as a chown on the box would. */
    own(file, owner = "root") {
      owners.set(path.resolve(file), owner);
      return box;
    },
  };
  box.ctx = {
    layout,
    runner: createRunner({ spawnImpl }),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    httpGet: async (url) => box.health(url),
    freeBytes: () => box.free,
    ownerOf: (file) => (owners.get(path.resolve(file)) === "root" ? 0 : BUILD_UID),
  };
  return box;
}

// What every real checkout of the repo holds at its root besides package.json:
// the tracked examples, which no tool loads (git ls-files | grep .env).
export const TRACKED_DOTENV_EXAMPLES = Object.freeze([".env.example", ".env.europe.example"]);

/** A finished release folder, as build leaves it. */
export function addRelease(box, id, { state = "BUILT", sha = SHA, staticFiles = ["chunks/app.js"] } = {}) {
  const dir = box.layout.release(id);
  for (const file of staticFiles) {
    mkdirSync(path.dirname(path.join(dir, ".next/static", file)), { recursive: true });
    writeFileSync(path.join(dir, ".next/static", file), "x");
  }
  writeFileSync(
    path.join(dir, "release.json"),
    JSON.stringify({ id, region: id.slice(0, 2), sha, role: "candidate", state, node: "v22.23.3" }),
  );
  return dir;
}

// caddy validate runs as caddy: runuser -u caddy -- env HOME=... caddy validate ...
export const isCaddyValidate = (command, args) =>
  command.endsWith("/runuser") && args.some((arg) => arg.endsWith("/caddy")) && args.includes("validate");
export const isReload = (command, args) => command.endsWith("/systemctl") && args[0] === "reload";
