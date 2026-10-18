#!/usr/bin/env node
// Diff one league's Neon database against its copy on the box (design §10
// G-DATA; §6 P5, W8 and E5). Runs ops/selfhost/sql/db-parity.sql on Neon from
// the Mac, runs `ggd2l-agent parity <lg>` on the box, and compares the two
// fingerprints line by line:
//
//   node ops/selfhost/cutover/neon-parity.mjs us|eu [--source neonctl|env-file]
//
// The Neon owner URL is obtained exactly as neon-dump.mjs does and reaches
// psql only as libpq environment fields (never argv). Prints JSON: the table
// and migration counts on each side and every differing line's table name
// (never row data). Exit 0 only when the fingerprints are identical. During a
// rehearsal Neon is still live, so busy tables are expected to differ; at the
// cutover (Neon read-only) any difference stops the line.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_DATABASE,
  DEFAULT_PG_BIN,
  LEAGUES,
  assertNeonOwnerUrl,
  envFileConnectionString,
  neonctlConnectionString,
} from "./neon-dump.mjs";

const PARITY_SQL = fileURLToPath(new URL("../sql/db-parity.sql", import.meta.url));
const PASSED_THROUGH = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "TMPDIR", "TZ", "USER", "PATH"];

/** libpq fields for psql's environment; the URL itself never reaches a child. */
export function libpqEnv(raw, base = process.env) {
  const url = new URL(raw);
  const env = {};
  for (const key of PASSED_THROUGH) if (base[key] !== undefined) env[key] = base[key];
  Object.assign(env, {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGSSLMODE: "require",
    PGCONNECT_TIMEOUT: "15",
  });
  return env;
}

/** Split a parity fingerprint into a map keyed by table (or migration name). */
export function fingerprint(text) {
  const lines = String(text).split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const tables = new Map();
  const migrations = [];
  for (const line of lines) {
    const [kind, name] = line.split("\t");
    if (kind === "table") tables.set(name, line);
    else if (kind === "migration") migrations.push(line);
  }
  return { tables, migrations };
}

export function compareFingerprints(neon, box) {
  const a = fingerprint(neon);
  const b = fingerprint(box);
  const names = new Set([...a.tables.keys(), ...b.tables.keys()]);
  const differing = [...names].filter((name) => a.tables.get(name) !== b.tables.get(name)).sort();
  const migrationsMatch = a.migrations.length === b.migrations.length &&
    a.migrations.every((line, i) => line === b.migrations[i]);
  return {
    identical: differing.length === 0 && migrationsMatch,
    neon: { tables: a.tables.size, migrations: a.migrations.length },
    box: { tables: b.tables.size, migrations: b.migrations.length },
    differingTables: differing,
    migrationsMatch,
  };
}

function ownerUrl(lg, source) {
  const league = LEAGUES[lg];
  let raw = null;
  if (source !== "neonctl" && league.envFile) raw = envFileConnectionString(league.envFile);
  if (!raw) raw = neonctlConnectionString({ projectId: league.projectId, database: DEFAULT_DATABASE, env: process.env, run: spawnSync });
  assertNeonOwnerUrl(raw, DEFAULT_DATABASE);
  return raw;
}

export function runNeonParity(lg, { source = "auto", host = process.env.GGD2L_BOX_SSH || "ggd2l-1", pgBin = DEFAULT_PG_BIN } = {}) {
  if (!LEAGUES[lg]) throw new Error("league must be us or eu");
  const neon = spawnSync(path.join(pgBin, "psql"), ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", PARITY_SQL], {
    env: libpqEnv(ownerUrl(lg, source)), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (neon.status !== 0) throw new Error(`psql on Neon failed (exit ${neon.status ?? "none"})`);
  const box = spawnSync("ssh", ["-o", "BatchMode=yes", host, `sudo ggd2l-agent parity ${lg}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (box.status !== 0) throw new Error(`ggd2l-agent parity ${lg} failed on ${host} (exit ${box.status ?? "none"})`);
  let boxText = box.stdout;
  try {
    const parsed = JSON.parse(box.stdout);
    if (Array.isArray(parsed.rows)) boxText = parsed.rows.join("\n");
    else if (typeof parsed.output === "string") boxText = parsed.output;
  } catch {
    // plain text output
  }
  return compareFingerprints(neon.stdout, boxText);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [lg, ...rest] = process.argv.slice(2);
  const sourceIndex = rest.indexOf("--source");
  try {
    const result = runNeonParity(lg, { source: sourceIndex >= 0 ? rest[sourceIndex + 1] : "auto" });
    console.log(JSON.stringify({ league: lg, ...result }, null, 2));
    process.exitCode = result.identical ? 0 : 1;
  } catch (error) {
    console.error(`neon-parity: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 2;
  }
}
