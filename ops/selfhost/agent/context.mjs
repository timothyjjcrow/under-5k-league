// The shared plumbing every verb uses: the injectable context (layout, runner,
// clock, HTTP probe), JSON state files written atomically, and env files read
// as data. Reading an env file registers its secret values with the runner,
// which then refuses any command line that contains one.
import { readFileSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { checkLeagueEnv, parseEnvFile } from "./env-contract.mjs";
import { AgentError, createLayout } from "./layout.mjs";
import { createRunner, httpGet, secretValues } from "./runner.mjs";

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

/** The owner-role URL from <lg>-migrate.env (DATABASE_URL = DIRECT_URL). */
export function loadOwnerUrl(ctx, lg) {
  const { env } = loadEnvFile(ctx, ctx.layout.migrateEnv(lg));
  const url = env.DIRECT_URL || env.DATABASE_URL;
  if (!url) throw new AgentError("env_missing");
  return url;
}
