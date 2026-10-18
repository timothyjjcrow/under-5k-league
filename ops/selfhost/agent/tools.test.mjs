import assert from "node:assert/strict";
import { mkdirSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { caddyConfigSha256, renderMode } from "./caddy-modes.mjs";
import { SHA, SHA2, T0, TRACKED_DOTENV_EXAMPLES, addRelease, makeBox } from "./harness.test.mjs";
import { promoteRelease } from "./releases.mjs";
import { STATUS_UNITS, lastDrill, status } from "./status.mjs";
import { attest, backup, botDeploy, botStatus, drill, prepareTools, readDrillRecord } from "./tools.mjs";

function gitBox() {
  const box = makeBox();
  box.on((command, args) => {
    const line = args.join(" ");
    if (command.endsWith("/runuser") && line.includes("rev-parse refs/remotes/origin/main")) return { stdout: `${SHA}\n` };
    if (command.endsWith("/runuser") && line.includes("rev-parse HEAD")) return { stdout: `${SHA}\n` };
    if (command.endsWith("/install") && args[0] === "-d") {
      mkdirSync(args.at(-1), { recursive: true });
      return { code: 0 };
    }
    // A checkout holds what the repo tracks, the dotenv examples included.
    if (command.endsWith("/runuser") && args.includes("checkout")) {
      const dir = args[args.indexOf("-C") + 1];
      writeFileSync(path.join(dir, "package.json"), "{}");
      for (const name of TRACKED_DOTENV_EXAMPLES) writeFileSync(path.join(dir, name), "APP_URL=\n");
      return { code: 0 };
    }
    if (command.endsWith("/systemd-run") && args.includes("ci")) {
      const cwd = args.find((arg) => arg.startsWith("WorkingDirectory=")).slice("WorkingDirectory=".length);
      mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
      writeFileSync(path.join(cwd, "node_modules/.package-lock.json"), "{}");
      return { code: 0 };
    }
    return undefined;
  });
  return box;
}

test("prepare clones the sha, installs dev dependencies and points tools/current at the first clone", async () => {
  const box = gitBox();
  const { dir } = await prepareTools(box.ctx, SHA);
  assert.equal(dir, box.layout.toolsDir(SHA));
  const install = box.calls.find((call) => call.args.includes("ci")).args;
  assert.ok(install.includes("UnsetEnvironment=NODE_ENV"));
  assert.ok(install.includes("--include=dev"));
  assert.equal(readlinkSync(box.layout.toolsCurrent), SHA.slice(0, 12));
  const clones = box.calls.filter((call) => call.args.includes("clone")).length;
  await prepareTools(box.ctx, SHA);
  assert.equal(box.calls.filter((call) => call.args.includes("clone")).length, clones, "a ready clone is reused");
});

test("attest refuses without a prepared tools clone at the sha", async () => {
  const box = makeBox();
  box.writeEnv("us");
  await assert.rejects(attest(box.ctx, "us", SHA2), { code: "tools_missing" });
});

/** The record backup-league.sh (WP-E3) writes to <lg>/state/last-backup.json. */
function backupRecord(overrides = {}) {
  return {
    ok: true,
    league: "us",
    file: "/var/backups/ggd2l/us/local/backup-x.sql",
    sha256: "a".repeat(64),
    ageFile: "/var/backups/ggd2l/us/offsite/backup-x.sql.gz.age",
    ageSha256: "c".repeat(64),
    offsite: "uploaded",
    offsiteKey: "us/hourly/2026-10-16/backup-x.sql.gz.age",
    daily: false,
    monthly: false,
    // backup-league.sh writes whole seconds.
    finishedAt: new Date(T0 + 5_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...overrides,
  };
}

const stateRecord = (box, lg = "us") => path.join(box.layout.backupDir(lg), "state", "last-backup.json");

test("backup runs the unit and reports the record it wrote, with the R2 key", async () => {
  const box = makeBox();
  const record = backupRecord();
  box.on((command, args) => {
    if (args.join(" ") === "start --wait ggd2l-backup@us.service") {
      mkdirSync(path.dirname(stateRecord(box)), { recursive: true });
      writeFileSync(stateRecord(box), `${JSON.stringify(record)}\n`);
      return { code: 0 };
    }
    return undefined;
  });
  assert.deepEqual(await backup(box.ctx, "us"), { file: "backup-x.sql", sha256: record.sha256, offsiteKey: record.offsiteKey });
  const shown = await status(box.ctx, { meminfo: path.join(box.root, "missing") });
  assert.equal(shown.leagues.us.lastBackupAt, record.finishedAt);

  box.on((command, args) => (args.join(" ") === "start --wait ggd2l-backup@us.service" ? { code: 1 } : undefined));
  await assert.rejects(backup(box.ctx, "us"), { code: "backup_failed" });
});

test("only an ok record for the league counts; of state/ and the copy beside it, the newer answers", async () => {
  const box = makeBox();
  const { readBackupRecord } = await import("./tools.mjs");
  mkdirSync(path.dirname(stateRecord(box)), { recursive: true });
  const copy = path.join(box.layout.backupDir("us"), "last-backup.json");
  writeFileSync(copy, JSON.stringify(backupRecord({ offsiteKey: "copy" })));
  assert.equal(readBackupRecord(box.ctx, "us").offsiteKey, "copy", "the copy answers alone");
  writeFileSync(stateRecord(box), JSON.stringify(backupRecord()));
  assert.equal(readBackupRecord(box.ctx, "us").offsiteKey, backupRecord().offsiteKey, "state/ wins a tie");
  writeFileSync(copy, JSON.stringify(backupRecord({ offsiteKey: "newer", finishedAt: new Date(T0 + 3_600_000).toISOString() })));
  assert.equal(readBackupRecord(box.ctx, "us").offsiteKey, "newer");
  for (const bad of [{ ok: false }, { league: "eu" }, { sha256: "nope" }, { finishedAt: "yesterday" }]) {
    writeFileSync(stateRecord(box), JSON.stringify(backupRecord(bad)));
    writeFileSync(copy, JSON.stringify(backupRecord(bad)));
    assert.equal(readBackupRecord(box.ctx, "us"), null, JSON.stringify(bad));
  }
});

test("a backup older than the run never answers for it", async () => {
  const box = makeBox();
  const stale = backupRecord({ file: "backup-old.sql", sha256: "b".repeat(64), offsiteKey: null, finishedAt: new Date(T0 - 3_600_000).toISOString() });
  mkdirSync(path.dirname(stateRecord(box)), { recursive: true });
  writeFileSync(stateRecord(box), JSON.stringify(stale));
  const dump = path.join(box.layout.backupDir("us"), "local", "backup-old.sql");
  writeFileSync(dump, "x");
  utimesSync(dump, (T0 - 3_600_000) / 1000, (T0 - 3_600_000) / 1000);
  await assert.rejects(backup(box.ctx, "us"), { code: "backup_failed" });
});

test("drill without a sha is the drill unit; with one it runs the helper on that sha's tools", async () => {
  const box = gitBox();
  await drill(box.ctx, "us");
  assert.deepEqual(box.calls.at(-2).args, ["start", "--wait", "ggd2l-drill@us.service"]);
  box.on((command, args) => (args.join(" ") === "show --property=Result --value ggd2l-drill@us.service" ? { stdout: "exit-code\n" } : undefined));
  await assert.rejects(drill(box.ctx, "us"), { code: "drill_failed" });
  await prepareTools(box.ctx, SHA);
  writeFileSync(box.layout.drillEnv, "PG_RESTORE_TEST_URL=postgresql://x\n");
  await drill(box.ctx, "us", SHA);
  const call = box.calls.find((entry) => entry.command.endsWith("/systemd-run") && entry.args.some((arg) => arg.endsWith("drill-league.sh")));
  const args = call.args;
  assert.ok(args.includes("User=ggd2l-ops"));
  assert.ok(args.includes(`EnvironmentFile=${box.layout.drillEnv}`));
  assert.ok(args.includes(`GGD2L_TOOLS_DIR=${box.layout.toolsDir(SHA)}`));
  // drill-league.sh us|eu [<40-hex sha>]: without the sha it drills tools/current,
  // the live commit, and would pass without rehearsing the new migrations.
  assert.deepEqual(args.slice(-4), ["/usr/bin/bash", box.layout.helper("drill-league.sh"), "us", SHA]);
  assert.ok(args.includes(`HOME=${box.layout.buildHome}`) === false, "the drill runs as ggd2l-ops, not the build user");

  box.on((command, args) => (command.endsWith("/systemd-run") && args.some((arg) => arg.endsWith("drill-league.sh")) ? { code: 1, lines: ["drill-us: restore failed"] } : undefined));
  await assert.rejects(drill(box.ctx, "us", SHA), { code: "drill_failed" });
});

test("bot-deploy archives the bot folder, installs production dependencies and links current", async () => {
  const box = gitBox();
  const { dir } = await botDeploy(box.ctx, SHA);
  assert.equal(dir, path.join(box.layout.botReleases, SHA.slice(0, 12)));
  const lines = box.calls.map((call) => call.args.join(" "));
  assert.ok(lines.some((line) => line.includes(`archive --format=tar --output=${dir}/.source.tar ${SHA} ops/dota-lobby-bot`)));
  assert.ok(lines.some((line) => line.includes("ci --omit=dev")));
  assert.ok(lines.includes(`-R -P -h root:ggd2l-bot ${dir}`));
  assert.ok(lines.includes(`-R g+rX,g-w,o-rwx ${dir}`));
  assert.equal(readlinkSync(box.layout.botCurrent), path.join("releases", SHA.slice(0, 12)));
});

test("bot-deploy refuses a tree with a link npm planted outside it", async () => {
  const box = gitBox();
  const dir = path.join(box.layout.botReleases, SHA.slice(0, 12));
  box.on((command, args) => {
    if (command.endsWith("/systemd-run") && args.includes("--omit=dev")) {
      mkdirSync(path.join(dir, "ops/dota-lobby-bot"), { recursive: true });
      symlinkSync("/etc/ggd2l", path.join(dir, "ops/dota-lobby-bot/leak"));
      return { code: 0 };
    }
    return undefined;
  });
  await assert.rejects(botDeploy(box.ctx, SHA), { code: "link_escapes" });
  assert.ok(!box.calls.some((call) => call.args.includes("g+rX,g-w,o-rwx")), "no chmod follows the refusal");
});

test("bot-status reports the unit and whether a lobby is held, never its contents", async () => {
  const box = makeBox();
  mkdirSync(box.layout.botState, { recursive: true });
  writeFileSync(path.join(box.layout.botState, "lobbies.json"), JSON.stringify({ active: { lobbyId: "123", password: "secret" } }));
  box.on((command, args) => (args[0] === "show" ? { stdout: "ActiveState=active\nSubState=running\nUnitFileState=enabled\nNRestarts=2\nActiveEnterTimestamp=Fri 2026-10-16 17:45:00 UTC\n" } : undefined));
  const result = await botStatus(box.ctx);
  assert.deepEqual(result, { ok: true, active: "active", subState: "running", enabled: "enabled", restarts: 2, since: "Fri 2026-10-16 17:45:00 UTC", release: null, lobby: "set" });
});

test("status summarises units, live releases, modes and slots", async () => {
  const box = makeBox();
  const id = "us-20261016T150000Z-0123456789ab";
  addRelease(box, id);
  await promoteRelease(box.ctx, "us", id);
  writeFileSync(box.layout.modeFile("eu"), renderMode("maintenance"));
  box.on((command, args) =>
    args[0] === "show"
      ? { stdout: "Id=ggd2l-us@a.service\nActiveState=active\nUnitFileState=enabled\n\nId=ggd2l-drill@us.service\nActiveState=inactive\nUnitFileState=static\nResult=success\nExecMainExitTimestamp=Sun 2026-10-18 10:31:00 UTC\n" }
      : args[0] === "--failed"
        ? { stdout: "ggd2l-backup@eu.service loaded failed failed GGD2L backup eu\n" }
        : undefined,
  );
  // Europe's only drill ran through `drill eu <sha>` (systemd-run, outside the
  // unit), so only its record shows it.
  mkdirSync(path.join(box.layout.backupDir("eu"), "state"), { recursive: true });
  writeFileSync(path.join(box.layout.backupDir("eu"), "state", "last-drill.json"),
    JSON.stringify({ ok: true, league: "eu", dump: "/x/backup-a.sql", dumpSha256: "a".repeat(64), tools: "/srv/ggd2l/tools/0123456789ab", finishedAt: "2026-10-16T13:21:00Z" }));
  const result = await status(box.ctx, { meminfo: path.join(box.root, "missing") });
  assert.deepEqual(result.units["ggd2l-us@a.service"], { active: "active", enabled: "enabled" });
  assert.equal(result.units["ggd2l-eu@a.service"].active, "unknown");
  assert.equal(result.leagues.us.live.id, id);
  assert.equal(result.leagues.us.mode, "proxy");
  assert.deepEqual(result.leagues.us.slots, { a: id, b: null });
  assert.deepEqual(result.leagues.us.lastDrill, { result: "success", at: "2026-10-18T10:31:00.000Z", source: "unit" });
  assert.deepEqual(result.leagues.eu.lastDrill, { result: "success", at: "2026-10-16T13:21:00.000Z", source: "record" });
  assert.equal(result.leagues.eu.mode, "maintenance");
  assert.deepEqual(result.failedUnits, ["ggd2l-backup@eu.service"]);
  assert.equal(result.pendingReboot, false);
  assert.equal(result.serverErrors24h, 0);
  assert.equal(result.maintenance503s24h, 0);
  // The daily config archive is reported with the other timers.
  for (const unit of ["ggd2l-config-archive.timer", "ggd2l-config-archive.service"]) {
    assert.ok(STATUS_UNITS.includes(unit), unit);
    assert.ok(unit in result.units, unit);
    assert.ok(box.calls.some((call) => call.args[0] === "show" && call.args.includes(unit)), `systemctl show asks for ${unit}`);
  }
  // release-box records it in box-manifest.json.
  assert.match(result.caddyConfigSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.caddyConfigSha256, caddyConfigSha256(box.layout));
});

test("the last drill is the later of the unit's last run and the last passing drill's record", () => {
  const record = { ok: true, league: "us", finishedAt: "2026-10-17T13:21:00Z" };
  const unit = (Result, at) => ({ Result, ExecMainExitTimestamp: at });
  const passed = { result: "success", at: "2026-10-17T13:21:00.000Z", source: "record" };
  // Never run either way.
  assert.equal(lastDrill(undefined, null), null);
  assert.equal(lastDrill(unit("", ""), null), null);
  // Only the agent's sha drill ran: the record answers (the bug: null).
  assert.deepEqual(lastDrill(unit("", ""), record), passed);
  assert.deepEqual(lastDrill(unit("", "n/a"), record), passed);
  // The weekly unit failed after that pass: the failure shows.
  assert.deepEqual(lastDrill(unit("exit-code", "Sun 2026-10-18 10:31:00 UTC"), record),
    { result: "exit-code", at: "2026-10-18T10:31:00.000Z", source: "unit" });
  // The unit failed, then a sha drill passed: the pass clears it.
  assert.deepEqual(lastDrill(unit("exit-code", "Fri 2026-10-16 10:31:00 UTC"), record), passed);
  // A time systemd printed in a zone this can't read: a failure still shows.
  assert.deepEqual(lastDrill(unit("exit-code", "Sun 2026-10-18 12:31:00 CEST"), record),
    { result: "exit-code", at: "Sun 2026-10-18 12:31:00 CEST", source: "unit" });
  assert.deepEqual(lastDrill(unit("success", "Sun 2026-10-18 12:31:00 CEST"), record), passed);
});

test("a drill record counts only for its league, when it says ok and has a time", () => {
  const box = makeBox();
  const file = path.join(box.layout.backupDir("us"), "state", "last-drill.json");
  mkdirSync(path.dirname(file), { recursive: true });
  assert.equal(readDrillRecord(box.ctx, "us"), null);
  const good = { ok: true, league: "us", finishedAt: "2026-10-17T13:21:00Z" };
  for (const [record, expected] of [
    [good, good],
    [{ ...good, league: "eu" }, null],
    [{ ...good, ok: false }, null],
    [{ ...good, finishedAt: "soon" }, null],
  ]) {
    writeFileSync(file, JSON.stringify(record));
    assert.deepEqual(readDrillRecord(box.ctx, "us"), expected);
  }
  writeFileSync(file, "{ not json");
  assert.equal(readDrillRecord(box.ctx, "us"), null);
});

test("status counts the maintenance page's 503s apart from real 5xx", async () => {
  const box = makeBox();
  const line = (atMs, status, headers) => JSON.stringify({
    ts: atMs / 1000, status, resp_headers: headers,
    request: { host: "eu.ggd2l.com", uri: "/", method: "GET" },
  });
  const page = { "Retry-After": ["600"], "Cache-Control": ["no-store"], "X-Robots-Tag": ["noindex, nofollow"] };
  const file = path.join(box.layout.caddyLogs, "eu.access.json");
  writeFileSync(file, `${[line(T0 - 60_000, 503, page), line(T0 - 50_000, 503, page), line(T0 - 40_000, 502, {})].join("\n")}\n`);
  utimesSync(file, T0 / 1000, T0 / 1000);
  const result = await status(box.ctx, { meminfo: path.join(box.root, "missing") });
  assert.equal(result.serverErrors24h, 1);
  assert.equal(result.maintenance503s24h, 2);
});
