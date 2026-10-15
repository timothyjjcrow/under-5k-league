import assert from "node:assert/strict";
import { mkdirSync, readlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { renderMode } from "./caddy-modes.mjs";
import { SHA, SHA2, T0, addRelease, makeBox } from "./harness.test.mjs";
import { promoteRelease } from "./releases.mjs";
import { status } from "./status.mjs";
import { attest, backup, botDeploy, botStatus, drill, prepareTools } from "./tools.mjs";

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

test("backup runs the unit and reports the record it wrote", async () => {
  const box = makeBox();
  const record = { file: "/var/backups/ggd2l/us/local/backup-x.sql", sha256: "a".repeat(64), offsiteKey: "us/hourly/2026-10-16/backup-x.sql.gz.age", finishedAt: new Date(T0 + 5_000).toISOString() };
  box.on((command, args) => {
    if (args.join(" ") === "start --wait ggd2l-backup@us.service") {
      writeFileSync(path.join(box.layout.backupDir("us"), "last-backup.json"), JSON.stringify(record));
      return { code: 0 };
    }
    return undefined;
  });
  assert.deepEqual(await backup(box.ctx, "us"), { file: "backup-x.sql", sha256: record.sha256, offsiteKey: record.offsiteKey });

  box.on((command, args) => (args.join(" ") === "start --wait ggd2l-backup@us.service" ? { code: 1 } : undefined));
  await assert.rejects(backup(box.ctx, "us"), { code: "backup_failed" });
});

test("a backup older than the run never answers for it", async () => {
  const box = makeBox();
  const stale = { file: "backup-old.sql", sha256: "b".repeat(64), offsiteKey: null, finishedAt: new Date(T0 - 3_600_000).toISOString() };
  writeFileSync(path.join(box.layout.backupDir("us"), "last-backup.json"), JSON.stringify(stale));
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
  const args = box.calls.at(-1).args;
  assert.ok(args.includes("User=ggd2l-ops"));
  assert.ok(args.includes(`EnvironmentFile=${box.layout.drillEnv}`));
  assert.ok(args.includes(`GGD2L_TOOLS_DIR=${box.layout.toolsDir(SHA)}`));
  assert.deepEqual(args.slice(-3), ["/usr/bin/bash", box.layout.helper("drill-league.sh"), "us"]);
  assert.ok(args.includes(`HOME=${box.layout.buildHome}`) === false, "the drill runs as ggd2l-ops, not the build user");
});

test("bot-deploy archives the bot folder, installs production dependencies and links current", async () => {
  const box = gitBox();
  const { dir } = await botDeploy(box.ctx, SHA);
  assert.equal(dir, path.join(box.layout.botReleases, SHA.slice(0, 12)));
  const lines = box.calls.map((call) => call.args.join(" "));
  assert.ok(lines.some((line) => line.includes(`archive --format=tar --output=${dir}/.source.tar ${SHA} ops/dota-lobby-bot`)));
  assert.ok(lines.some((line) => line.includes("ci --omit=dev")));
  assert.ok(lines.includes(`-R root:ggd2l-bot ${dir}`));
  assert.equal(readlinkSync(box.layout.botCurrent), path.join("releases", SHA.slice(0, 12)));
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
  const result = await status(box.ctx, { meminfo: path.join(box.root, "missing") });
  assert.deepEqual(result.units["ggd2l-us@a.service"], { active: "active", enabled: "enabled" });
  assert.equal(result.units["ggd2l-eu@a.service"].active, "unknown");
  assert.equal(result.leagues.us.live.id, id);
  assert.equal(result.leagues.us.mode, "proxy");
  assert.deepEqual(result.leagues.us.slots, { a: id, b: null });
  assert.deepEqual(result.leagues.us.lastDrill, { result: "success", at: "Sun 2026-10-18 10:31:00 UTC" });
  assert.equal(result.leagues.eu.mode, "maintenance");
  assert.deepEqual(result.failedUnits, ["ggd2l-backup@eu.service"]);
  assert.equal(result.pendingReboot, false);
  assert.equal(result.serverErrors24h, 0);
});
