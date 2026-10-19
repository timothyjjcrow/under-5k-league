// The shared plumbing every verb uses: the injectable context (layout, runner,
// clock, HTTP probe), JSON state files written atomically, and env files read
// as data. Reading an env file registers its secret values with the runner,
// which then refuses any command line that contains one.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { checkLeagueEnv, parseEnvFile } from "./env-contract.mjs";
import { AgentError, BIN, createLayout } from "./layout.mjs";
import { createRedactor, createRunner, httpGet, secretValues } from "./runner.mjs";

export function createContext(overrides = {}) {
  return {
    layout: createLayout("/"),
    runner: createRunner(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    httpGet,
    freeBytes: (dir) => {
      const fs = statfsSync(dir);
      return fs.bavail * fs.bsize;
    },
    // The uid that owns a path itself (never through a link): 0 once the
    // agent has locked a tree the build user wrote down to root.
    ownerOf: (file) => lstatSync(file).uid,
    ...overrides,
  };
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, value, mode = 0o644) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, file);
}

/**
 * A log on the box (0640, group ggd2l once closed) that holds a child's
 * output with every value of `envs` of 8 or more characters, and any URL
 * password in them, replaced by [redacted]. Lines are hashed as written, so
 * close() resolves the log's sha256.
 */
export function openRedactedLog(ctx, file, envs) {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "w", 0o640);
  const redact = createRedactor(envs);
  const hash = createHash("sha256");
  let digest = null;
  return {
    file,
    write(line) {
      const text = `${redact(line)}\n`;
      hash.update(text);
      writeSync(fd, text);
    },
    async close() {
      if (digest !== null) return digest;
      closeSync(fd);
      digest = hash.digest("hex");
      // The admin user reads it without sudo; a failure leaves it root-only.
      await ctx.runner.run(BIN.chown, ["root:ggd2l", file]);
      return digest;
    },
  };
}

/** Parse an env file as data and register its secrets. Never returns raw text. */
export function loadEnvFile(ctx, file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new AgentError("env_missing");
  }
  const { env, problems } = parseEnvFile(text);
  ctx.runner.addSecrets(secretValues(env));
  return { env, problems };
}

/** The league env, refused unless it passes the env contract (names only). */
export function loadLeagueEnv(ctx, lg) {
  const { env, problems } = loadEnvFile(ctx, ctx.layout.leagueEnv(lg));
  const all = [...problems, ...checkLeagueEnv(env, lg, { mode: "file" })];
  if (all.length) throw new AgentError("env_contract", { problems: all });
  return env;
}

/** <lg>-migrate.env: only DATABASE_URL = DIRECT_URL for the owner role. */
export function loadMigrateEnv(ctx, lg) {
  const { env } = loadEnvFile(ctx, ctx.layout.migrateEnv(lg));
  if (!(env.DIRECT_URL || env.DATABASE_URL)) throw new AgentError("env_missing");
  return env;
}

/** The owner-role URL from <lg>-migrate.env. */
export function loadOwnerUrl(ctx, lg) {
  const env = loadMigrateEnv(ctx, lg);
  return env.DIRECT_URL || env.DATABASE_URL;
}
