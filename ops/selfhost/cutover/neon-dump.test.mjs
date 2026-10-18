import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEAGUES, NEONCTL, OWNER_ROLE, parseArguments, runNeonDump, scrub,
} from "./neon-dump.mjs";

const SCRIPT = fileURLToPath(new URL("./neon-dump.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PASSWORD = "npg_S3cretOwnerPassw0rd";
const US_URL = `postgresql://${OWNER_ROLE}:${PASSWORD}@ep-quiet-sky-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require`;
const EU_URL = `postgresql://${OWNER_ROLE}:${PASSWORD}@ep-late-fog-b1ap78ik.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`;
const RECEIPT_SECRET = "receipt-secret-that-must-never-be-used-0123456789";

/**
 * A sandbox with a fake `npx` (standing in for neonctl) and a fake pg_dump 18.
 * Both log what they were given, including every ancestor's argv as `ps` sees
 * it, so a test can prove where the URL did and did not travel.
 */
function sandbox({ url = US_URL, pgVersion = "18.1", neonctlFails = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ggd2l-neon-dump-test-"));
  const bin = path.join(dir, "bin");
  const pgBin = path.join(dir, "pg18");
  mkdirSync(bin);
  mkdirSync(pgBin);
  mkdirSync(path.join(dir, "home"));
  const npxLog = path.join(dir, "npx.jsonl");
  const pgLog = path.join(dir, "pg_dump.jsonl");
  const ancestry = `
    function ancestry() {
      const rows = [];
      let pid = process.pid;
      for (let depth = 0; depth < 4 && pid > 1; depth += 1) {
        const r = spawnSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8" });
        const line = (r.stdout || "").trim();
        if (!line) break;
        const [ppid, ...args] = line.split(/\\s+/);
        rows.push(args.join(" "));
        pid = Number(ppid);
      }
      return rows;
    }`;
  writeFileSync(path.join(bin, "npx"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(npxLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (${neonctlFails}) {
  process.stderr.write("Error: request failed for ${url}\\n");
  process.exit(1);
}
process.stdout.write(${JSON.stringify(`${url}\n`)});
`);
  writeFileSync(path.join(pgBin, "pg_dump"), `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
${ancestry}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("pg_dump (PostgreSQL) ${pgVersion} (Homebrew)\\n");
  process.exit(0);
}
appendFileSync(${JSON.stringify(pgLog)}, JSON.stringify({
  args,
  env: {
    PGHOST: process.env.PGHOST, PGUSER: process.env.PGUSER, PGDATABASE: process.env.PGDATABASE,
    PGPASSWORD: process.env.PGPASSWORD, PGSSLMODE: process.env.PGSSLMODE,
    DIRECT_URL: process.env.DIRECT_URL, DATABASE_URL: process.env.DATABASE_URL,
    BACKUP_RECEIPT_SECRET: process.env.BACKUP_RECEIPT_SECRET,
  },
  ancestry: ancestry(),
}) + "\\n");
const file = args.find((arg) => arg.startsWith("--file="));
writeFileSync(file.slice("--file=".length), "-- fake dump\\nSELECT 1;\\n");
`);
  chmodSync(path.join(bin, "npx"), 0o755);
  chmodSync(path.join(pgBin, "pg_dump"), 0o755);
  const env = {
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: path.join(dir, "home"),
    // Present in the operator's shell, so each must be kept away from children.
    BACKUP_RECEIPT_SECRET: RECEIPT_SECRET,
    DATABASE_URL: "postgresql://someone:else@127.0.0.1:5432/other",
    PGPASSWORD: "inherited-pg-password",
  };
  const readJsonLines = (file) =>
    existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return {
    dir,
    pgBin,
    out: path.join(dir, "out", "us"),
    env,
    npxCalls: () => readJsonLines(npxLog),
    pgDumpCalls: () => readJsonLines(pgLog),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** spawnSync, recording every command, argv and child environment. */
function spyRunner() {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args: [...args], env: { ...(options?.env ?? {}) }, cwd: options?.cwd });
    return spawnSync(command, args, options);
  };
  return { calls, run };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

test("a US dump keeps the URL in one child's environment: never in argv, output or ps", () => {
  const box = sandbox();
  try {
    const spy = spyRunner();
    const lines = [];
    const result = runNeonDump({
      args: ["us", "--out", box.out, "--pg-bin", box.pgBin],
      env: box.env,
      run: spy.run,
      log: (line) => lines.push(line),
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, "neonctl");
    assert.equal(result.database, "neondb");
    assert.equal(result.files.length, 3);
    const [sql, checksum, metadata] = result.files;
    assert.match(sql.path, /\/backup-[^/]+\.sql$/);
    assert.equal(path.dirname(sql.path), box.out);
    assert.equal(checksum.path, `${sql.path}.sha256`);
    assert.equal(metadata.path, `${sql.path}.metadata.json`);
    for (const file of result.files) {
      assert.equal(file.sha256, sha256(file.path));
      assert.equal(file.bytes, readFileSync(file.path).length);
    }
    assert.equal(readFileSync(checksum.path, "utf8").split(" ")[0], sql.sha256);

    // neonctl got only public identifiers.
    assert.deepEqual(box.npxCalls(), [[
      "--yes", NEONCTL, "connection-string",
      "--project-id", LEAGUES.us.projectId,
      "--role-name", OWNER_ROLE,
      "--database-name", "neondb",
    ]]);

    // No spawned argv carries the URL or password; exactly one environment
    // (backup-db.mjs) carries the URL, and no child sees the receipt secret.
    for (const call of spy.calls) {
      assert.doesNotMatch(JSON.stringify(call.args), new RegExp(PASSWORD));
      assert.equal(call.env.BACKUP_RECEIPT_SECRET, undefined);
      assert.equal(call.env.DATABASE_URL, undefined);
      assert.equal(call.env.PGPASSWORD, undefined);
    }
    const withUrl = spy.calls.filter((call) => JSON.stringify(call.env).includes(PASSWORD));
    assert.equal(withUrl.length, 1);
    assert.equal(withUrl[0].env.DIRECT_URL, US_URL);
    assert.deepEqual(withUrl[0].args, [path.join(REPO_ROOT, "scripts", "backup-db.mjs")]);
    assert.equal(withUrl[0].env.BACKUP_DIR, box.out);
    // Both node children run from an empty scratch folder, not the caller's cwd.
    const nodeCalls = spy.calls.filter((call) => call.command === process.execPath);
    assert.equal(nodeCalls.length, 2);
    for (const call of nodeCalls) {
      assert.match(call.cwd, /ggd2l-neon-dump-/);
      assert.ok(!existsSync(call.cwd), "the scratch folder is removed afterwards");
    }

    // pg_dump got libpq fields, never a URL, and no ancestor's argv held it.
    const [dump] = box.pgDumpCalls();
    assert.deepEqual(dump.args.filter((arg) => !arg.startsWith("--file=")), ["--no-owner", "--no-privileges"]);
    assert.equal(dump.env.PGPASSWORD, PASSWORD);
    assert.equal(dump.env.PGHOST, "ep-quiet-sky-a1b2c3d4.us-east-2.aws.neon.tech");
    assert.equal(dump.env.PGUSER, OWNER_ROLE);
    assert.equal(dump.env.DIRECT_URL, undefined);
    assert.equal(dump.env.BACKUP_RECEIPT_SECRET, undefined);
    assert.ok(dump.ancestry.some((args) => args.includes("backup-db.mjs")), "ps saw backup-db.mjs");
    for (const args of dump.ancestry) assert.doesNotMatch(args, new RegExp(PASSWORD));

    const printed = `${lines.join("\n")}\n${JSON.stringify(result)}`;
    assert.doesNotMatch(printed, new RegExp(PASSWORD));
    assert.doesNotMatch(printed, /postgres(ql)?:\/\//);
  } finally {
    box.cleanup();
  }
});

test("the CLI prints only paths, sizes and hashes, even beside a .env with a receipt secret", () => {
  const box = sandbox();
  try {
    // A .env in the operator's cwd would make verify-backup.mjs mint a receipt
    // (and backup-db.mjs read another URL) if the children ran there.
    const cwd = path.join(box.dir, "operator-cwd");
    mkdirSync(cwd);
    writeFileSync(
      path.join(cwd, ".env"),
      `BACKUP_RECEIPT_SECRET="${RECEIPT_SECRET}"\nDIRECT_URL="postgresql://wrong:wrong@127.0.0.1/wrong"\n`,
    );
    const result = spawnSync(process.execPath, [SCRIPT, "us", "--out", box.out, "--pg-bin", box.pgBin], {
      cwd,
      env: box.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, new RegExp(PASSWORD));
    assert.doesNotMatch(output, /postgres(ql)?:\/\//);
    assert.doesNotMatch(output, /receipt:/i);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(summary).sort(), ["database", "files", "league", "ok", "pgDump", "source"]);
    for (const file of summary.files) {
      assert.deepEqual(Object.keys(file).sort(), ["bytes", "path", "sha256"]);
      assert.equal(file.sha256, sha256(file.path));
    }
  } finally {
    box.cleanup();
  }
});

test("--dry-run checks the login, the URL and pg_dump, and writes nothing", () => {
  const box = sandbox();
  try {
    const spy = spyRunner();
    const result = runNeonDump({
      args: ["us", "--dry-run", "--out", box.out, "--pg-bin", box.pgBin],
      env: box.env,
      run: spy.run,
      log: () => {},
    });
    assert.deepEqual(result, {
      ok: true, dryRun: true, league: "us", source: "neonctl", role: OWNER_ROLE,
      database: "neondb", endpoint: "direct", pgDump: "18.1", outDir: box.out,
    });
    assert.equal(existsSync(box.out), false);
    assert.deepEqual(box.pgDumpCalls(), []);
    assert.ok(spy.calls.every((call) => call.command !== process.execPath));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(PASSWORD));
  } finally {
    box.cleanup();
  }
});

test("Europe reads DIRECT_URL from its private env file and never asks neonctl", () => {
  const box = sandbox({ url: EU_URL });
  try {
    const envFile = path.join(box.dir, "europe-production.env");
    writeFileSync(envFile, `DATABASE_URL="postgresql://pooled@x/y"\nDIRECT_URL="${EU_URL}"\n`, { mode: 0o600 });
    const result = runNeonDump({
      args: ["eu", "--env-file", envFile, "--out", box.out, "--pg-bin", box.pgBin],
      env: box.env,
      log: () => {},
    });
    assert.equal(result.source, "env-file");
    assert.deepEqual(box.npxCalls(), []);
    assert.equal(box.pgDumpCalls()[0].env.PGHOST, "ep-late-fog-b1ap78ik.eu-central-1.aws.neon.tech");

    chmodSync(envFile, 0o644);
    assert.throws(
      () => runNeonDump({ args: ["eu", "--env-file", envFile, "--dry-run", "--pg-bin", box.pgBin], env: box.env, log: () => {} }),
      /chmod 600/,
    );
  } finally {
    box.cleanup();
  }
});

test("Europe falls back to neonctl when its env file is missing, unless the file was demanded", () => {
  const box = sandbox({ url: EU_URL });
  try {
    const missing = path.join(box.dir, "absent.env");
    const result = runNeonDump({
      args: ["eu", "--env-file", missing, "--dry-run", "--pg-bin", box.pgBin],
      env: box.env,
      log: () => {},
    });
    assert.equal(result.source, "neonctl");
    assert.equal(box.npxCalls()[0][box.npxCalls()[0].indexOf("--project-id") + 1], LEAGUES.eu.projectId);
    assert.throws(
      () => runNeonDump({
        args: ["eu", "--source", "env-file", "--env-file", missing, "--dry-run", "--pg-bin", box.pgBin],
        env: box.env,
        log: () => {},
      }),
      /missing or holds no DIRECT_URL/,
    );
  } finally {
    box.cleanup();
  }
});

test("a pooled, foreign, non-owner or wrong-database URL is refused before any dump", () => {
  const cases = [
    [US_URL.replace("ep-quiet-sky-a1b2c3d4.", "ep-quiet-sky-a1b2c3d4-pooler."), /pooler/],
    [US_URL.replace(".us-east-2.aws.neon.tech", ".example.com"), /not point at a Neon endpoint/],
    [US_URL.replace(`${OWNER_ROLE}:`, "vercel_production:"), /role is not neondb_owner/],
    [US_URL.replace("/neondb?", "/otherdb?"), /names database otherdb, not neondb/],
  ];
  for (const [url, message] of cases) {
    const box = sandbox({ url });
    try {
      let error;
      try {
        runNeonDump({ args: ["us", "--out", box.out, "--pg-bin", box.pgBin], env: box.env, log: () => {} });
      } catch (caught) {
        error = caught;
      }
      assert.match(error?.message ?? "", message);
      assert.doesNotMatch(error.message, new RegExp(PASSWORD));
      assert.deepEqual(box.pgDumpCalls(), []);
      assert.equal(existsSync(box.out), false);
    } finally {
      box.cleanup();
    }
  }
});

test("a neonctl failure is reported without the URL it may have echoed", () => {
  const box = sandbox({ neonctlFails: true });
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "us", "--out", box.out, "--pg-bin", box.pgBin], {
      cwd: box.dir,
      env: box.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /neonctl returned no connection string \(exit 1\)/);
    assert.match(result.stderr, /\[redacted\]/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(PASSWORD));
    assert.equal(result.stdout, "");
  } finally {
    box.cleanup();
  }
});

test("pg_dump must be PostgreSQL 18 at the given folder, with a clear failure otherwise", () => {
  const box = sandbox({ pgVersion: "17.6" });
  try {
    const args = (pgBin) => ["us", "--dry-run", "--pg-bin", pgBin];
    assert.throws(
      () => runNeonDump({ args: args(path.join(box.dir, "no-such-bin")), env: box.env, log: () => {} }),
      /pg_dump 18 was not found at .*brew install postgresql@18/,
    );
    assert.throws(
      () => runNeonDump({ args: args(box.pgBin), env: box.env, log: () => {} }),
      /is PostgreSQL 17; the cutover needs pg_dump 18/,
    );
  } finally {
    box.cleanup();
  }
});

test("arguments are strict and a dump never lands in the repository", () => {
  for (const args of [[], ["ca"], ["us", "eu"], ["us", "--out"], ["us", "--out", "a", "--out", "b"],
    ["us", "--bogus"], ["us", "--source", "vercel"], ["us", "--database", "neondb;drop"],
    ["us", "--source", "env-file"], ["us", "--dry-run", "--dry-run"]]) {
    assert.throws(() => parseArguments(args), undefined, JSON.stringify(args));
  }
  assert.equal(parseArguments(["us"]).source, "neonctl");
  assert.equal(parseArguments(["eu"]).source, "env-file");
  assert.match(parseArguments(["eu"]).out, /ggd2l-cutover\/eu$/);

  const box = sandbox();
  try {
    assert.throws(
      () => runNeonDump({
        args: ["us", "--dry-run", "--pg-bin", box.pgBin, "--out", path.join(REPO_ROOT, "ops")],
        env: box.env,
        log: () => {},
      }),
      /inside the repository/,
    );
  } finally {
    box.cleanup();
  }
});

test("scrub removes the URL, its password and any other connection string", () => {
  const text = `failed for ${US_URL}; password ${PASSWORD}; also postgres://a:b@c/d`;
  const cleaned = scrub(text, [US_URL, PASSWORD]);
  assert.doesNotMatch(cleaned, new RegExp(PASSWORD));
  assert.doesNotMatch(cleaned, /postgres(ql)?:\/\//);
});
