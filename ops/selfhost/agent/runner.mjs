// Every operating-system call the agent makes goes through one small runner,
// so the tests can spy on each spawn and the agent can refuse, in one place,
// to put a secret on a command line (/proc/<pid>/cmdline is world-readable).
//
// Secrets reach children only through a spawned process's environment or
// through `systemd-run -p EnvironmentFile=`, which systemd reads as root.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import http from "node:http";
import { AgentError, BIN } from "./layout.mjs";

export const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MIN_SECRET_LENGTH = 8;

// Env keys whose values are public and may legitimately appear in argv or a
// log (a SHA, an origin, a public Discord id). Everything else is secret.
const PUBLIC_KEYS = new Set([
  "LEAGUE_DEPLOY_ENV",
  "CLIENT_IP_HEADER",
  "APP_URL",
  "ALLOW_DEV_LOGIN",
  "ADMIN_STEAM_IDS",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "DISCORD_INHOUSE_ROLE_ID",
  "DOTA_INHOUSE_LEAGUE_ID",
  "DOTA_SEASON_LOBBY_BOT_ENABLED",
  "DOTA_LOBBY_BOT_URL",
  "DOTA_LOBBY_RELAY_URL",
  "DOTA_GAME_SERVER_REGIONS",
  "BACKUP_DIR",
  "PORT",
  "HOST",
]);

function urlPassword(value) {
  try {
    const url = new URL(value);
    return url.password ? decodeURIComponent(url.password) : null;
  } catch {
    return null;
  }
}

/** The secret strings of a parsed env file: values of non-public keys. */
export function secretValues(env) {
  const values = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (PUBLIC_KEYS.has(key) || key.startsWith("NEXT_PUBLIC_")) continue;
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
    values.add(value);
    const password = urlPassword(value);
    if (password && password.length >= MIN_SECRET_LENGTH) values.add(password);
  }
  return values;
}

/**
 * Build-log redaction (design §2.1): every env value of 8 characters or more,
 * public or not, plus the password inside any URL value, becomes [redacted].
 * Longest first, so a value that contains another is removed whole.
 */
export function createRedactor(envs) {
  const values = new Set();
  for (const env of envs) {
    for (const value of Object.values(env)) {
      if (typeof value !== "string") continue;
      if (value.length >= MIN_SECRET_LENGTH) values.add(value);
      const password = urlPassword(value);
      if (password && password.length >= MIN_SECRET_LENGTH) values.add(password);
      // A URL-encoded password appears encoded in a URL and decoded elsewhere.
      if (password && encodeURIComponent(password) !== password) values.add(encodeURIComponent(password));
    }
  }
  const ordered = [...values].sort((a, b) => b.length - a.length);
  return (line) => {
    let out = line;
    for (const value of ordered) if (out.includes(value)) out = out.split(value).join("[redacted]");
    return out;
  };
}

/** Line-buffer a stream of chunks so redaction never sees half a value. */
export function lineSplitter(onLine) {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    },
    end() {
      if (pending) onLine(pending);
      pending = "";
    },
  };
}

function defaultSpawn(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const out = lineSplitter((line) => options.onLine?.(line, "stdout"));
    const err = lineSplitter((line) => options.onLine?.(line, "stderr"));
    let timer;
    if (options.timeoutMs) timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (options.capture !== false) stdout.push(chunk);
      if (options.onLine) out.push(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      if (options.capture !== false) stderr.push(chunk);
      if (options.onLine) err.push(chunk.toString("utf8"));
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: "" });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.end();
      err.end();
      resolve({
        code: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.on("error", () => {});
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/**
 * run(command, args, {env, cwd, input, onLine, capture, timeoutMs}) resolves
 * {code, stdout, stderr}. Children get a minimal environment (PATH and LANG)
 * plus exactly what the caller passes, never the agent's own environment.
 */
export function createRunner({ spawnImpl = defaultSpawn } = {}) {
  const secrets = new Set();
  return {
    addSecrets(values) {
      for (const value of values) if (value && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
    },
    assertArgvClean(command, args) {
      for (const arg of [command, ...args]) {
        for (const secret of secrets) if (String(arg).includes(secret)) throw new AgentError("argv_secret");
      }
    },
    async run(command, args = [], options = {}) {
      this.assertArgvClean(command, args);
      const env = { PATH: SAFE_PATH, LANG: "C.UTF-8", ...(options.env ?? {}) };
      return spawnImpl(command, args, { ...options, env });
    },
  };
}

/** Throw a fixed code unless the command exited 0. */
export async function must(runner, code, command, args, options) {
  const result = await runner.run(command, args, options);
  if (result.code !== 0) throw new AgentError(code);
  return result;
}

/**
 * `systemd-run --wait --pipe --collect` with properties. Values passed with
 * -E are public (NODE_ENV, a SHA, a cache path); secrets only ever arrive
 * through EnvironmentFile=, which systemd reads as root.
 */
export function systemdRunArgs({ user, cwd, envFiles = [], setEnv = {}, unsetEnv = [], properties = [], command, args = [] }) {
  const out = ["--wait", "--pipe", "--collect", "--service-type=exec"];
  if (user) out.push("-p", `User=${user}`);
  if (cwd) out.push("-p", `WorkingDirectory=${cwd}`);
  for (const file of envFiles) out.push("-p", `EnvironmentFile=${file}`);
  if (unsetEnv.length) out.push("-p", `UnsetEnvironment=${unsetEnv.join(" ")}`);
  for (const property of properties) out.push("-p", property);
  for (const [key, value] of Object.entries(setEnv)) out.push("-E", `${key}=${value}`);
  out.push(command, ...args);
  return out;
}

/**
 * `rm -rf` as root on a tree another user wrote (a clone, a release). GNU rm
 * descends by file descriptor and never enters a folder swapped for a link
 * mid-walk. Node 22's rmSync lstats a folder, then reads and deletes inside
 * it by path, so whoever can write the tree can swap the folder for a link in
 * between and have root delete files elsewhere.
 */
export function removeTree(runner, dir, code) {
  return must(runner, code, BIN.rm, ["-rf", "--one-file-system", "--", dir]);
}

/** Run a command as an unprivileged user without systemd (short git and tar calls). */
export function asUser(user, command, args) {
  return [BIN.runuser, ["-u", user, "--", command, ...args]];
}

/**
 * The agent-wide lock (design §2.1: flock /run/ggd2l-agent.lock). flock(1)
 * locks the open file description it inherits as fd 3; this process keeps
 * that description open, so the lock lasts exactly as long as the agent.
 */
export function acquireLock(file) {
  const fd = openSync(file, "a", 0o600);
  const result = spawnSync(BIN.flock, ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
  if (result.status !== 0) {
    closeSync(fd);
    throw new AgentError("busy");
  }
  return () => closeSync(fd);
}

/** A local GET that sends the public Host, as Caddy would. Resolves the status (0 on error). */
export function httpGet(url, { host, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const request = http.get(
      url,
      { headers: { host, "x-forwarded-proto": "https" }, timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(0));
  });
}

/** libpq environment for one role, from a postgresql:// URL; never argv. */
export function pgEnv(rawUrl, { readOnly = false } = {}) {
  const url = new URL(rawUrl);
  const env = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGSSLMODE: url.searchParams.get("sslmode") ?? "disable",
    PGCONNECT_TIMEOUT: url.searchParams.get("connect_timeout") ?? "5",
    PGAPPNAME: "ggd2l-agent",
  };
  if (readOnly) env.PGOPTIONS = "-c default_transaction_read_only=on";
  return env;
}
