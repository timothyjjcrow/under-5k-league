#!/usr/bin/node
// ggd2l-agent: the only thing the Mac's release tooling runs on the box.
//
//   ssh -o BatchMode=yes ggd2l-1 sudo -n /usr/local/sbin/ggd2l-agent <verb> <args>
//
// Design §2.1. Every verb is in the table below; anything else exits 2. Every
// argument is validated before anything runs. stdout carries exactly one JSON
// value; an error is {ok:false, code, message} with a fixed message and never
// child output. Mutating verbs hold /run/ggd2l-agent.lock for their whole run.
// Installed as /usr/local/lib/ggd2l/ggd2l-agent.mjs, with
// /usr/local/sbin/ggd2l-agent linking to it.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildRelease, fetchMain } from "./build.mjs";
import { MODES } from "./caddy-modes.mjs";
import { createContext, loadEnvFile } from "./context.mjs";
import { identity, grantsCheck, importDump, parity, readLease } from "./database.mjs";
import { checkLeagueEnv } from "./env-contract.mjs";
import {
  AgentError,
  DUMP_NAME_RE,
  MAX_ALLOWED_IPS,
  UsageError,
  ipAddress,
  region,
  releaseId,
  sha,
  since,
} from "./layout.mjs";
import { cronRequestCount, leagueLogs } from "./logs.mjs";
import {
  checkRelease,
  describeRelease,
  liveRelease,
  promoteRelease,
  pruneLeague,
  retireRelease,
  rollbackRelease,
  setAllowlist,
  setMode,
  startRelease,
} from "./releases.mjs";
import { acquireLock } from "./runner.mjs";
import { status } from "./status.mjs";
import { attest, backup, botDeploy, botStatus, drill, migrate, preflight, prepareTools } from "./tools.mjs";

function modeArg(value) {
  if (!MODES.includes(value)) throw new UsageError("bad_mode");
  return value;
}

function dumpArg(value) {
  // A basename, or an absolute path with no "..": the verb then requires it
  // to sit directly in the league's cutover folder.
  if (typeof value !== "string" || !DUMP_NAME_RE.test(value.split("/").at(-1) ?? "")) throw new UsageError("bad_file");
  if (value.includes("/") && (!value.startsWith("/") || value.split("/").includes(".."))) throw new UsageError("bad_file");
  return value;
}

const optional = (validate) => Object.assign((value) => validate(value), { optional: true });

/**
 * The allowlist. `args` validate positionals in order; `rest` validates a
 * variadic tail; `flags` lists each flag's allowed values; `mutating` takes the lock.
 */
export const VERBS = Object.freeze({
  status: { args: [], run: (ctx) => status(ctx) },
  live: { args: [region], run: (ctx, [lg]) => liveRelease(ctx, lg) },
  deployment: { args: [releaseId], run: (ctx, [id]) => describeRelease(ctx, id) },
  fetch: { args: [], mutating: true, run: (ctx) => fetchMain(ctx) },
  prepare: { args: [sha], mutating: true, run: (ctx, [commit]) => prepareTools(ctx, commit) },
  build: { args: [region, sha], mutating: true, run: (ctx, [lg, commit]) => buildRelease(ctx, lg, commit) },
  start: { args: [region, releaseId], mutating: true, run: (ctx, [lg, id]) => startRelease(ctx, lg, id) },
  check: {
    args: [region, releaseId],
    flags: { "--expect": ["production", "staging"] },
    required: ["--expect"],
    run: (ctx, [lg, id], flags) => checkRelease(ctx, lg, id, flags["--expect"]),
  },
  promote: {
    args: [region, releaseId],
    flags: { "--mode": ["proxy", "allowlist"] },
    mutating: true,
    run: (ctx, [lg, id], flags) => promoteRelease(ctx, lg, id, { mode: flags["--mode"] ?? "proxy" }),
  },
  rollback: { args: [region], mutating: true, run: (ctx, [lg]) => rollbackRelease(ctx, lg) },
  retire: { args: [region, releaseId], mutating: true, run: (ctx, [lg, id]) => retireRelease(ctx, lg, id) },
  mode: { args: [region, modeArg], mutating: true, run: (ctx, [lg, mode]) => setMode(ctx, lg, mode) },
  allow: { args: [], rest: ipAddress, min: 1, max: MAX_ALLOWED_IPS, mutating: true, run: (ctx, ips) => setAllowlist(ctx, ips) },
  attest: { args: [region, sha], run: (ctx, [lg, commit]) => attest(ctx, lg, commit) },
  import: { args: [region, dumpArg], mutating: true, run: (ctx, [lg, file]) => importDump(ctx, lg, file) },
  parity: { args: [region], run: (ctx, [lg]) => parity(ctx, lg) },
  identity: { args: [region], mutating: true, run: (ctx, [lg]) => identity(ctx, lg) },
  preflight: { args: [region, sha], run: (ctx, [lg, commit]) => preflight(ctx, lg, commit) },
  "grants-check": { args: [region], run: (ctx, [lg]) => grantsCheck(ctx, lg) },
  migrate: { args: [region, sha], mutating: true, run: (ctx, [lg, commit]) => migrate(ctx, lg, commit) },
  backup: { args: [region], mutating: true, run: (ctx, [lg]) => backup(ctx, lg) },
  drill: { args: [region, optional(sha)], mutating: true, run: (ctx, [lg, commit]) => drill(ctx, lg, commit) },
  logs: { args: [region, since], run: (ctx, [lg, ms]) => leagueLogs({ layout: ctx.layout, runner: ctx.runner, lg, sinceMs: ms }) },
  "cron-requests": {
    args: [region, since],
    run: (ctx, [lg, ms]) => ({ ok: true, count: cronRequestCount({ layout: ctx.layout, lg, sinceMs: ms }) }),
  },
  lease: { args: [region], run: (ctx, [lg]) => readLease(ctx, lg).then((lease) => ({ ok: true, ...lease })) },
  envcheck: { args: [region], run: (ctx, [lg]) => envcheck(ctx, lg) },
  prune: { args: [region], mutating: true, run: (ctx, [lg]) => pruneLeague(ctx, lg) },
  "bot-deploy": { args: [sha], mutating: true, run: (ctx, [commit]) => botDeploy(ctx, commit) },
  "bot-status": { args: [], run: (ctx) => botStatus(ctx) },
});

function envcheck(ctx, lg) {
  const { env, problems } = loadEnvFile(ctx, ctx.layout.leagueEnv(lg));
  const all = [...problems, ...checkLeagueEnv(env, lg, { mode: "file" })];
  if (all.length) throw new AgentError("env_contract", { problems: all });
  return { ok: true, problems: [] };
}

/** Validate a whole command line against the table; throws UsageError. */
export function parseCommand(argv) {
  const [name, ...rest] = argv;
  if (typeof name !== "string" || !Object.hasOwn(VERBS, name)) throw new UsageError("unknown_verb");
  const verb = VERBS[name];
  const positionals = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const allowed = verb.flags?.[token];
      if (!allowed || Object.hasOwn(flags, token)) throw new UsageError("bad_flag");
      const value = rest[++i];
      if (!allowed.includes(value)) throw new UsageError("bad_flag");
      flags[token] = value;
    } else positionals.push(token);
  }
  for (const flag of verb.required ?? []) if (!Object.hasOwn(flags, flag)) throw new UsageError("usage");

  const values = [];
  if (verb.rest) {
    if (positionals.length < verb.min || positionals.length > verb.max) throw new UsageError("usage");
    for (const value of positionals) values.push(verb.rest(value));
  } else {
    const requiredCount = verb.args.filter((validate) => !validate.optional).length;
    if (positionals.length < requiredCount || positionals.length > verb.args.length) throw new UsageError("usage");
    positionals.forEach((value, index) => values.push(verb.args[index](value)));
  }
  // A release id names its league; it must be the league the verb acts on.
  if (verb.args[0] === region && verb.args[1] === releaseId && values[1].slice(0, 2) !== values[0])
    throw new UsageError("bad_id");
  return { name, verb, values, flags };
}

// Extra fields an error may carry: names, verdicts and counts, never output.
const SAFE_EXTRAS = ["problems", "checks", "changed"];

function errorBody(error) {
  const body = { ok: false, code: error.code, message: error.message };
  for (const key of SAFE_EXTRAS) if (error.extra && Object.hasOwn(error.extra, key)) body[key] = error.extra[key];
  return body;
}

/**
 * Run one command line. Resolves the exit code: 0 done, 1 refused or failed,
 * 2 not a valid command (unknown verb or bad arguments).
 */
export async function main(argv, {
  write = (text) => process.stdout.write(text),
  uid = () => process.getuid?.() ?? -1,
  context = () => createContext(),
  lock = (file) => acquireLock(file),
} = {}) {
  const print = (value) => write(`${JSON.stringify(value)}\n`);
  let command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    print(errorBody(error instanceof AgentError ? error : new UsageError("usage")));
    return 2;
  }
  let release = null;
  try {
    if (uid() !== 0) throw new AgentError("not_root");
    const ctx = context();
    if (command.verb.mutating) release = lock(ctx.layout.lock);
    const result = await command.verb.run(ctx, command.values, command.flags);
    // Objects always say ok:true first; `logs` is a bare array of rows.
    print(Array.isArray(result) || Object.hasOwn(result, "ok") ? result : { ok: true, ...result });
    return 0;
  } catch (error) {
    print(errorBody(error instanceof AgentError ? error : new AgentError("internal")));
    if (!(error instanceof AgentError)) process.stderr.write(`ggd2l-agent: internal error (${error?.code ?? error?.name ?? "unknown"})\n`);
    return 1;
  } finally {
    release?.();
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    // /usr/local/sbin/ggd2l-agent is a symlink; Node reports the resolved file.
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
