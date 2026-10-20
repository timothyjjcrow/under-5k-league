import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderMode } from "./caddy-modes.mjs";
import { changedRows, resolveDump } from "./database.mjs";
import { VERBS, main, parseCommand } from "./ggd2l-agent.mjs";
import { ENV_GATE_LINE, SCHEMA_GATE_LINE } from "./build.mjs";
import { parseEnvFile } from "./env-contract.mjs";
import { AgentError, ERRORS } from "./layout.mjs";
import { SHA, SHA2, addRelease, leagueEnv, makeBox, secretsOf } from "./harness.test.mjs";
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
  box.writeEnv("us");
  writeFileSync(box.layout.liveJson("us"), JSON.stringify({ slot: "a", id: ID, sha: SHA, promotedAt: "2026-10-16T15:00:00.000Z", previous: null }));
  box.on((command, args) => (command.endsWith("/systemd-run") && args.includes("scripts/validate-prod-env.mjs") ? { lines: [ENV_GATE_LINE] } : undefined));
  assert.deepEqual((await run(["envcheck", "us"])).body, { ok: true, problems: [] });
  assert.deepEqual((await run(["cron-requests", "us", "0"])).body, { ok: true, count: 0 });
  assert.deepEqual((await run(["logs", "us", "0"])).body, []);
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

/** Run one command line against a fake box; resolves its exit code and JSON. */
async function runAgent(box, argv) {
  let output = "";
  const code = await main(argv, { write: (text) => (output += text), uid: () => 0, context: () => box.ctx, lock: () => () => {} });
  return { code, body: JSON.parse(output) };
}

// 2026-10-19 audit: an env edit takes effect at the next restart, reboot or
// rollback, with no build, and the slot's ExecStartPre runs only the env
// contract. A 31-character AUTH_SECRET or an empty ADMIN_STEAM_IDS passed
// both, then broke every sign-in or every admin. envcheck, which every env
// runbook runs before that restart, now runs the gate a build would.
test("envcheck runs the live release's production validation on the file, and reports names only", async () => {
  const box = makeBox();
  // A value shaped like an env name, which only redaction keeps out of the answer.
  const env = box.writeEnv("us", leagueEnv("us", { DISCORD_CLIENT_SECRET: "LEAKED_CLIENT_SECRET_42" }));
  const validator = (lines, code = 1) =>
    box.on((command, args) => (command.endsWith("/systemd-run") && args.includes("scripts/validate-prod-env.mjs") ? { code, lines } : undefined));

  // No live release: no validator to run, so envcheck cannot pass.
  assert.deepEqual(await runAgent(box, ["envcheck", "us"]), {
    code: 1,
    body: { ok: false, code: "env_invalid", message: ERRORS.env_invalid, problems: ["production validation: no live release to run it from (a build runs it)"] },
  });

  writeFileSync(box.layout.liveJson("us"), JSON.stringify({ slot: "b", id: ID, sha: SHA, promotedAt: "2026-10-16T15:00:00.000Z", previous: null }));
  validator([
    "Production environment validation failed:",
    "  - AUTH_SECRET must contain at least 32 characters",
    "  - every ADMIN_STEAM_IDS entry must be a valid individual SteamID64",
    `  - TypeError at secret() (${env.DISCORD_CLIENT_SECRET}, ${env.CRON_SECRET})`,
  ]);
  const failed = await runAgent(box, ["envcheck", "us"]);
  assert.deepEqual(failed, {
    code: 1,
    body: {
      ok: false,
      code: "env_invalid",
      message: ERRORS.env_invalid,
      problems: ["AUTH_SECRET: fails the production validation", "ADMIN_STEAM_IDS: fails the production validation"],
    },
  });
  for (const secret of [...secretsOf(env), env.DISCORD_CLIENT_SECRET]) assert.ok(!JSON.stringify(failed.body).includes(secret));
  // The live release's own copy, as the league user, reading the file itself.
  const call = box.calls.findLast((entry) => entry.args.includes("scripts/validate-prod-env.mjs"));
  assert.ok(call.command.endsWith("/systemd-run"));
  for (const arg of ["User=ggd2l-us", `WorkingDirectory=${box.layout.release(ID)}`, `EnvironmentFile=${box.layout.leagueEnv("us")}`, "NODE_ENV=production"])
    assert.ok(call.args.includes(arg), arg);
  assert.deepEqual(call.args.slice(-2), ["/usr/bin/node", "scripts/validate-prod-env.mjs"]);
  // The rule each key broke is in the redacted tool log.
  const folder = path.dirname(box.layout.toolLog("x"));
  const log = readdirSync(folder).find((name) => name.startsWith("envcheck-us-") && name.endsWith(`-${SHA.slice(0, 12)}.log`));
  const text = readFileSync(path.join(folder, log), "utf8");
  assert.match(text, /AUTH_SECRET must contain at least 32 characters/);
  assert.ok(!text.includes(env.DISCORD_CLIENT_SECRET) && !text.includes(env.CRON_SECRET));

  // As before a build, a file the contract refuses never reaches the
  // validator: a NODE_ENV in it would skip the gate.
  const runs = box.commandsMatching(/validate-prod-env/).length;
  writeFileSync(box.layout.leagueEnv("us"), readFileSync(box.layout.leagueEnv("us"), "utf8") + "NODE_ENV=development\n");
  assert.deepEqual((await runAgent(box, ["envcheck", "us"])).body, {
    ok: false,
    code: "env_contract",
    message: ERRORS.env_contract,
    problems: ["NODE_ENV: set by the unit, not the league env file"],
  });
  assert.equal(box.commandsMatching(/validate-prod-env/).length, runs);
  box.writeEnv("us", env);

  // Exit 0 without the pass line (a skipped gate) is no pass.
  validator(["validate-prod-env: VERCEL_ENV=(unset) — production validation skipped"], 0);
  assert.deepEqual((await runAgent(box, ["envcheck", "us"])).body.problems, [
    "production validation: failed or printed no pass line (the envcheck tool log says why)",
  ]);
  validator([ENV_GATE_LINE], 0);
  assert.deepEqual(await runAgent(box, ["envcheck", "us"]), { code: 0, body: { ok: true, problems: [] } });
});

test("a refused second rollback names the release live came from and the one it left", async () => {
  const box = makeBox();
  const { promoteRelease } = await import("./releases.mjs");
  const OLD = "us-20261015T120000Z-0123456789ab";
  const NEW = "us-20261016T140000Z-fedcba987654";
  addRelease(box, OLD);
  addRelease(box, NEW, { sha: SHA2 });
  await promoteRelease(box.ctx, "us", OLD);
  box.clock.t += 120_000;
  await promoteRelease(box.ctx, "us", NEW);
  box.clock.t += 120_000;
  assert.deepEqual(await runAgent(box, ["rollback", "us"]), { code: 0, body: { ok: true, id: OLD } });
  assert.deepEqual(await runAgent(box, ["rollback", "us"]), {
    code: 1,
    body: { ok: false, code: "rolled_back", message: ERRORS.rolled_back, live: OLD, rolledBackFrom: NEW },
  });
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
  // validate-prod-env.mjs (the script's first step) needs the whole league
  // env; the migrate env comes second so its owner URLs win.
  assert.deepEqual(
    migrateCall.args.filter((arg) => arg.startsWith("EnvironmentFile=")),
    [`EnvironmentFile=${box.layout.leagueEnv("us")}`, `EnvironmentFile=${box.layout.migrateEnv("us")}`],
  );
  assert.ok(migrateCall.args.includes("VERCEL_ENV=production"));
  assert.deepEqual(migrateCall.args.slice(-4), ["/usr/bin/node", "scripts/release-migrations.mjs", "--apply", SHA]);
  // Preflight needs only the owner URL.
  const preflightCall = box.calls.find((call) => call.args.includes("scripts/migration-preflight.mjs"));
  assert.deepEqual(preflightCall.args.filter((arg) => arg.startsWith("EnvironmentFile=")), [`EnvironmentFile=${box.layout.migrateEnv("us")}`]);
  assert.ok(box.calls.some((call) => call.env?.PGPASSWORD && secrets.includes(call.env.PGPASSWORD)));
});

test("migrate refuses a league env that breaks the contract before running anything", async () => {
  const { box } = secretBox();
  const { migrate } = await import("./tools.mjs");
  writeFileSync(box.layout.leagueEnv("us"), "VERCEL_ENV=production\n");
  const before = box.calls.length;
  await assert.rejects(migrate(box.ctx, "us", SHA), { code: "env_contract" });
  assert.equal(box.calls.length, before);
});

test("attest, preflight, migrate and the sha drill each leave a redacted log", async () => {
  const { box } = secretBox();
  const { attest, preflight, migrate, drill } = await import("./tools.mjs");
  const valuesOf = (file) => Object.values(parseEnvFile(readFileSync(file, "utf8")).env);
  // Each unit echoes every value of every env file it reads, the way a stack
  // trace or a verbose client might, then fails.
  const echoed = new Map();
  box.on((command, args) => {
    if (!command.endsWith("/systemd-run") || args.includes("ci")) return undefined;
    const values = args.filter((arg) => arg.startsWith("EnvironmentFile=")).flatMap((arg) => valuesOf(arg.slice("EnvironmentFile=".length)));
    const script = args.find((arg) => arg.startsWith("scripts/") || arg.endsWith("drill-league.sh"));
    echoed.set(script, values);
    return { code: 1, lines: values.map((value) => `value ${value} end`) };
  });
  await assert.rejects(attest(box.ctx, "us", SHA), { code: "attest_failed" });
  await assert.rejects(preflight(box.ctx, "us", SHA), { code: "preflight_failed" });
  await assert.rejects(migrate(box.ctx, "us", SHA), { code: "migrate_failed" });
  await assert.rejects(drill(box.ctx, "us", SHA), { code: "drill_failed" });
  assert.equal(echoed.size, 4);

  const folder = path.dirname(box.layout.toolLog("x"));
  const logs = readdirSync(folder).sort();
  assert.deepEqual(
    logs.map((name) => name.replace(/-\d{8}T\d{6}Z-/, "-<stamp>-")),
    ["attest", "drill", "migrate", "preflight"].map((verb) => `${verb}-us-<stamp>-${SHA.slice(0, 12)}.log`),
  );
  const all = [...echoed.values()].flat().filter((value) => value.length >= 8);
  for (const name of logs) {
    const text = readFileSync(path.join(folder, name), "utf8");
    assert.match(text, /value \[redacted\] end/, name);
    assert.match(text, /== exit 1/, name);
    for (const value of all) assert.ok(!text.includes(value), `an env value reached ${name}`);
    // The passwords inside the URLs are gone too.
    for (const password of ["9e".repeat(32), "4c".repeat(32), "7a".repeat(32)]) assert.ok(!text.includes(password), name);
    assert.ok(box.calls.some((call) => call.command.endsWith("/chown") && call.args.join(" ") === `root:ggd2l ${path.join(folder, name)}`), name);
  }
  // The JSON error is unchanged: a fixed code and message, never a path or a line.
  let output = "";
  await main(["preflight", "us", SHA], { write: (text) => (output += text), uid: () => 0, context: () => box.ctx, lock: () => () => {} });
  assert.deepEqual(JSON.parse(output), { ok: false, code: "preflight_failed", message: "migration preflight failed" });
});

test("lease reads the automation lease row as the app role, read-only, and says only set or null", async () => {
  const box = makeBox();
  box.writeEnv("us");
  const { readLease } = await import("./database.mjs");
  for (const [answer, expected] of [
    ["set|set\n", { leaseOwner: "set", leaseExpiresAt: "set" }],
    ["null|set\n", { leaseOwner: null, leaseExpiresAt: "set" }],
    ["set|null\n", { leaseOwner: "set", leaseExpiresAt: null }],
    ["null|null\n", { leaseOwner: null, leaseExpiresAt: null }],
    // No row: nothing has ever held the lease.
    ["", { leaseOwner: null, leaseExpiresAt: null }],
  ]) {
    box.on((command) => (command.endsWith("/psql") ? { stdout: answer } : undefined));
    assert.deepEqual(await readLease(box.ctx, "us"), expected, JSON.stringify(answer));
  }
  const call = box.calls.at(-1);
  assert.ok(call.command.endsWith("/psql"));
  assert.ok(call.input.includes('FROM "AutomationRunState"'));
  assert.ok(call.input.includes('"leaseOwner"') && call.input.includes('"leaseExpiresAt"'));
  assert.equal(call.env.PGOPTIONS, "-c default_transaction_read_only=on");
  assert.equal(call.env.PGUSER, "ggd2l_us_app");
  assert.equal(call.env.PGDATABASE, "ggd2l_us");
  // The row key is the app's AUTOMATION_RUN_KEY, read from the source so a rename fails here.
  const service = readFileSync(fileURLToPath(new URL("../../../src/lib/automation-service.ts", import.meta.url)), "utf8");
  const key = /export const AUTOMATION_RUN_KEY = "([^"]+)";/.exec(service)?.[1];
  assert.equal(key, "league-maintenance");
  assert.ok(call.input.includes(`WHERE key = '${key}'`));
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
  assert.ok(!box.calls.some((call) => call.args.some((arg) => arg.endsWith("provision-league-db.sh"))), "nothing dropped");
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
