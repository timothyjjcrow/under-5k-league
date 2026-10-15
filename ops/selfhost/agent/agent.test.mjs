import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderMode } from "./caddy-modes.mjs";
import { changedRows, resolveDump } from "./database.mjs";
import { VERBS, main, parseCommand } from "./ggd2l-agent.mjs";
import { ENV_GATE_LINE, SCHEMA_GATE_LINE } from "./build.mjs";
import { AgentError } from "./layout.mjs";
import { SHA, addRelease, makeBox, secretsOf } from "./harness.test.mjs";
import { createRedactor, createRunner, pgEnv, secretValues } from "./runner.mjs";

const AGENT = fileURLToPath(new URL("./ggd2l-agent.mjs", import.meta.url));
const ID = "us-20261016T150000Z-0123456789ab";

test("arguments are refused before anything runs", () => {
  const refused = [
    [["live", "US"], "bad_region"],
    [["live", "uk"], "bad_region"],
    [["live", "us "], "bad_region"],
    [["build", "us", SHA.slice(0, 39)], "bad_sha"],
    [["build", "us", SHA.toUpperCase()], "bad_sha"],
    [["build", "us", `${SHA}0`], "bad_sha"],
    [["build", "us", "HEAD"], "bad_sha"],
    [["build", "us", "$(reboot)"], "bad_sha"],
    [["start", "us", "us-20261016T150000-0123456789ab"], "bad_id"],
    [["start", "us", "us-20261016T150000Z-0123456789AB"], "bad_id"],
    [["start", "us", "../../etc/passwd"], "bad_id"],
    [["start", "us", "eu-20261016T150000Z-0123456789ab"], "bad_id"],
    [["deployment", "us-2026-10-16-0123456789ab"], "bad_id"],
    [["allow", "1.2.3"], "bad_ip"],
    [["allow", "203.0.113.7/32"], "bad_ip"],
    [["allow", "203.0.113.7", "::g"], "bad_ip"],
    [["allow", "203.0.113.7:443"], "bad_ip"],
    [["allow", "localhost"], "bad_ip"],
    [["logs", "us", "yesterday"], "bad_since"],
    [["logs", "us", "-1"], "bad_since"],
    [["logs", "us", "1.5"], "bad_since"],
    [["mode", "us", "open"], "bad_mode"],
    [["promote", "us", ID, "--mode", "maintenance"], "bad_flag"],
    [["promote", "us", ID, "--force"], "bad_flag"],
    [["check", "us", ID], "usage"],
    [["check", "us", ID, "--expect", "preview"], "bad_flag"],
    [["import", "us", "../dump.sql"], "bad_file"],
    [["import", "us", "dump.sql.gz"], "bad_file"],
    [["allow"], "usage"],
    [["allow", ...Array.from({ length: 9 }, (_, i) => `203.0.113.${i}`)], "usage"],
    [["status", "extra"], "usage"],
    [["drill", "us", SHA, SHA], "usage"],
  ];
  for (const [argv, code] of refused)
    assert.throws(() => parseCommand(argv), { code }, argv.join(" "));

  assert.equal(parseCommand(["allow", "203.0.113.7", "2001:db8::1"]).values.length, 2);
  assert.deepEqual(parseCommand(["drill", "us"]).values, ["us"]);
  assert.deepEqual(parseCommand(["drill", "us", SHA]).values, ["us", SHA]);
  assert.deepEqual(parseCommand(["check", "us", ID, "--expect", "staging"]).flags, { "--expect": "staging" });
  assert.equal(parseCommand(["logs", "us", "1760626800000"]).values[1], 1760626800000);
});

test("a verb outside the allowlist exits 2 with a fixed JSON error", () => {
  for (const argv of [["shell"], ["rm", "-rf", "/"], ["__proto__"], ["toString"], []]) {
    const result = spawnSync(process.execPath, [AGENT, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 2, argv.join(" "));
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: "unknown_verb", message: "verb is not in the agent's allowlist" });
  }
  const bad = spawnSync(process.execPath, [AGENT, "build", "us", "HEAD"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).code, "bad_sha");
});

test("a valid verb run by a non-root user is refused, and exits 1", () => {
  const result = spawnSync(process.execPath, [AGENT, "status"], { encoding: "utf8" });
  assert.equal(result.status, process.getuid() === 0 ? 0 : 1);
  if (process.getuid() !== 0) assert.equal(JSON.parse(result.stdout).code, "not_root");
});

test("mutating verbs hold the agent lock; read-only verbs never take it", async () => {
  const box = makeBox();
  const locks = [];
  const run = async (argv) => {
    let output = "";
    const code = await main(argv, {
      write: (text) => {
        output += text;
      },
      uid: () => 0,
      context: () => box.ctx,
      lock: (file) => {
        locks.push(file);
        return () => locks.push("released");
      },
    });
    return { code, body: JSON.parse(output) };
  };
  locks.length = 0;
  await run(["mode", "us", "maintenance"]);
  assert.deepEqual(locks, [box.layout.lock, "released"]);
  locks.length = 0;
  await run(["envcheck", "us"]);
  await run(["cron-requests", "us", "0"]);
  assert.deepEqual(locks, []);

  let busyOutput = "";
  const busy = await main(["prune", "us"], {
    write: (text) => (busyOutput += text),
    uid: () => 0,
    context: () => box.ctx,
    lock: () => {
      throw new AgentError("busy");
    },
  });
  assert.equal(busy, 1);
  assert.equal(JSON.parse(busyOutput).code, "busy");

  for (const [name, verb] of Object.entries(VERBS)) {
    const readOnly = ["status", "live", "deployment", "check", "attest", "parity", "preflight", "grants-check", "logs", "cron-requests", "lease", "envcheck", "bot-status"];
    assert.equal(Boolean(verb.mutating), !readOnly.includes(name), name);
  }
});

test("errors carry a fixed message and never a child's output", async () => {
  const box = makeBox();
  box.writeEnv("us");
  box.on((command) => (command.endsWith("/psql") ? { code: 2, stdout: "psql: secret detail", stderr: "FATAL: password authentication failed for user" } : undefined));
  let output = "";
  const code = await main(["lease", "us"], { write: (text) => (output += text), uid: () => 0, context: () => box.ctx, lock: () => () => {} });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(output), { ok: false, code: "psql_failed", message: "a database query failed" });
});

test("the runner refuses a command line that carries a secret it has seen", async () => {
  const calls = [];
  const runner = createRunner({ spawnImpl: async (command, args) => (calls.push(args), { code: 0, stdout: "", stderr: "" }) });
  runner.addSecrets(secretValues({ CRON_SECRET: "cron-secret-value", APP_URL: "https://us.ggd2l.com", SHORT: "abc" }));
  await runner.run("/usr/bin/true", ["https://us.ggd2l.com", "abc"]);
  await assert.rejects(runner.run("/usr/bin/true", ["--token=cron-secret-value"]), { code: "argv_secret" });
  assert.equal(calls.length, 1);
  // Children never inherit the agent's environment.
  const seen = [];
  const bare = createRunner({ spawnImpl: async (command, args, options) => (seen.push(options.env), { code: 0, stdout: "", stderr: "" }) });
  process.env.GGD2L_TEST_LEAK = "should-not-pass";
  await bare.run("/usr/bin/true", [], { env: { PGPASSWORD: "x" } });
  delete process.env.GGD2L_TEST_LEAK;
  assert.deepEqual(Object.keys(seen[0]).sort(), ["LANG", "PATH", "PGPASSWORD"]);
});

test("redaction replaces long values longest-first and leaves short ones", () => {
  const redact = createRedactor([{ A: "abcdefgh", B: "abcdefghijkl", C: "short", D: "postgresql://u:p%40ssword-long@127.0.0.1/db" }]);
  assert.equal(redact("x abcdefghijkl y abcdefgh short"), "x [redacted] y [redacted] short");
  assert.equal(redact("pw p@ssword-long and p%40ssword-long"), "pw [redacted] and [redacted]");
});

test("libpq gets the credentials through its environment", () => {
  const env = pgEnv("postgresql://ggd2l_us_app:p%40ss@127.0.0.1:5432/ggd2l_us?schema=public&sslmode=disable&connect_timeout=5", { readOnly: true });
  assert.deepEqual(env, {
    PGHOST: "127.0.0.1",
    PGPORT: "5432",
    PGUSER: "ggd2l_us_app",
    PGPASSWORD: "p@ss",
    PGDATABASE: "ggd2l_us",
    PGSSLMODE: "disable",
    PGCONNECT_TIMEOUT: "5",
    PGAPPNAME: "ggd2l-agent",
    PGOPTIONS: "-c default_transaction_read_only=on",
  });
});

/** A box ready for every verb that touches an env file or a database. */
function secretBox() {
  const box = makeBox();
  const env = box.writeEnv("us");
  const tools = box.layout.toolsDir(SHA);
  mkdirSync(path.join(tools, "node_modules"), { recursive: true });
  writeFileSync(path.join(tools, "node_modules/.package-lock.json"), "{}");
  writeFileSync(box.layout.drillEnv, `PG_RESTORE_TEST_URL=postgresql://ggd2l_rehearsal:${"7a".repeat(32)}@127.0.0.1:5432/ld2l_restore_test\n`);
  writeFileSync(box.layout.modeFile("us"), renderMode("maintenance"));
  const dump = path.join(box.layout.cutoverDir("us"), "backup-2026-10-16T15-25-00-000-123.sql");
  writeFileSync(dump, "CREATE TABLE x();\n");
  writeFileSync(`${dump}.sha256`, `${createHash("sha256").update("CREATE TABLE x();\n").digest("hex")}  ${path.basename(dump)}\n`);
  box.on((command, args) => {
    const line = args.join(" ");
    if (command.endsWith("/runuser") && line.includes("rev-parse")) return { stdout: `${SHA}\n` };
    if (command.endsWith("/systemd-run") && line.includes("validate-prod-env")) return { lines: [ENV_GATE_LINE] };
    if (command.endsWith("/systemd-run") && line.includes("production-schema-check")) return { lines: [`${SCHEMA_GATE_LINE} in schema public`] };
    if (command.endsWith("/systemd-run") && line.includes("migration-preflight")) return { lines: ["Migration data preflight passed."] };
    if (command.endsWith("/systemd-run") && line.includes("release-migrations")) return { lines: [`Migration release completed for ${SHA}.`] };
    if (command.endsWith("/psql") && line.includes("identity-us")) return { stdout: "INSERT 0 1\nINSERT 0 1\n" };
    return undefined;
  });
  box.on((command, args, options) => (command.endsWith("/runuser") && String(options.input ?? "").includes("relowner") ? { stdout: "46|0\n" } : undefined));
  return { box, env, dump };
}

test("no env value ever appears in a spawned command line", async () => {
  const { box, env, dump } = secretBox();
  const { attest, preflight, migrate, drill } = await import("./tools.mjs");
  const { readLease, parity, identity, grantsCheck, importDump } = await import("./database.mjs");
  await attest(box.ctx, "us", SHA);
  await preflight(box.ctx, "us", SHA);
  await migrate(box.ctx, "us", SHA);
  await drill(box.ctx, "us", SHA);
  await readLease(box.ctx, "us");
  await parity(box.ctx, "us");
  assert.deepEqual(await identity(box.ctx, "us"), { changed: 2 });
  await grantsCheck(box.ctx, "us");
  assert.equal((await importDump(box.ctx, "us", path.basename(dump))).tables, 46);

  const secrets = secretsOf(env);
  assert.ok(box.calls.length > 15);
  for (const call of box.calls) {
    const argv = [call.command, ...call.args].join("\u0000");
    for (const secret of secrets) assert.ok(!argv.includes(secret), `a secret reached argv of ${call.command}`);
  }
  // The secrets went where they belong: env files for systemd, libpq env for psql.
  const attestCall = box.calls.find((call) => call.args.includes("scripts/validate-prod-env.mjs"));
  assert.ok(attestCall.args.includes(`EnvironmentFile=${box.layout.leagueEnv("us")}`));
  const migrateCall = box.calls.find((call) => call.args.includes("scripts/release-migrations.mjs"));
  assert.ok(migrateCall.args.includes(`EnvironmentFile=${box.layout.migrateEnv("us")}`));
  assert.ok(migrateCall.args.includes("VERCEL_ENV=production"));
  assert.ok(box.calls.some((call) => call.env?.PGPASSWORD && secrets.includes(call.env.PGPASSWORD)));
});

test("identity requires exactly the expected rows, and import only behind maintenance", async () => {
  const { box, dump } = secretBox();
  const { identity, importDump } = await import("./database.mjs");
  box.on((command, args) => (command.endsWith("/psql") && args.join(" ").includes("identity-us") ? { stdout: "INSERT 0 1\nINSERT 0 0\n" } : undefined));
  await assert.rejects(identity(box.ctx, "us"), (error) => error.code === "identity_unexpected_rows" && error.extra.changed === 1);
  assert.equal(changedRows(["UPDATE 1"]), 1);
  assert.equal(changedRows(["SET", "INSERT 0 2", "BEGIN"]), 2);

  writeFileSync(box.layout.modeFile("us"), renderMode("proxy", { port: 3001 }));
  await assert.rejects(importDump(box.ctx, "us", path.basename(dump)), { code: "not_maintenance" });
  writeFileSync(box.layout.modeFile("us"), renderMode("maintenance"));
  writeFileSync(dump, "tampered\n");
  await assert.rejects(importDump(box.ctx, "us", path.basename(dump)), { code: "checksum_mismatch" });
  assert.ok(!box.calls.some((call) => call.command.endsWith("provision-league-db.sh")), "nothing dropped");
  assert.throws(() => resolveDump(box.layout, "us", "/tmp/backup.sql"), { code: "bad_file" });
  assert.equal(resolveDump(box.layout, "us", dump), dump);
});

test("check runs the shared smoke from the release as the league user and returns names and verdicts", async () => {
  const box = makeBox();
  addRelease(box, ID);
  const { startRelease, checkRelease } = await import("./releases.mjs");
  await startRelease(box.ctx, "us", ID);
  const verdict = { ok: true, checks: [{ name: "health", ok: true, ms: 3, detail: { body: "x" } }] };
  box.on((command, args) => (args.some((arg) => arg.endsWith("smoke.mjs")) ? { stdout: JSON.stringify(verdict) } : undefined));
  assert.deepEqual(await checkRelease(box.ctx, "us", ID, "staging"), { ok: true, checks: [{ name: "health", ok: true }] });
  const call = box.calls.find((entry) => entry.args.some((arg) => arg.endsWith("smoke.mjs")));
  assert.deepEqual(call.args.slice(0, 3), ["-u", "ggd2l-us", "--"]);
  assert.ok(call.args.join(" ").includes("--base http://127.0.0.1:3001 --host us.ggd2l.com --origin https://us.ggd2l.com --region us"));
  assert.ok(call.args.join(" ").includes("--expect staging"));

  const cache = path.join(box.layout.release(ID), ".next/cache/fetch-cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "e1"), JSON.stringify({ tags: ["automation-gate:v12"] }));
  await assert.rejects(checkRelease(box.ctx, "us", ID, "staging"), { code: "fetch_cache_tagged" });
  box.on((command, args) => (args.some((arg) => arg.endsWith("smoke.mjs")) ? { code: 1, stdout: JSON.stringify({ ok: false, checks: [{ name: "health", ok: false, error: "body: hunter2" }] }) } : undefined));
  await assert.rejects(checkRelease(box.ctx, "us", ID, "staging"), (error) => error.code === "smoke_failed" && !JSON.stringify(error.extra).includes("hunter2"));
});
