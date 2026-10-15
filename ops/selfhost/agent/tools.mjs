// The tools clone and what runs from it (design §2.1, §2.5, §5.1, §7):
// prepare, attest, preflight, migrate, backup, drill, bot-deploy, bot-status.
//
// Each repo script runs as ggd2l-build from /srv/ggd2l/tools/<sha12> inside a
// systemd-run unit that reads the env file itself (-p EnvironmentFile=), so
// no secret is ever on a command line and the agent never holds it in a child.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { buildUserEnv, cloneAt, fetchMain, requireOnMain } from "./build.mjs";
import { loadLeagueEnv, loadOwnerUrl, readJson } from "./context.mjs";
import { grantsCheck } from "./database.mjs";
import { AgentError, BIN, USERS } from "./layout.mjs";
import { asUser, must, systemdRunArgs } from "./runner.mjs";

const TOOLS_PROPERTIES = Object.freeze(["CPUWeight=20", "IOWeight=20", "Nice=10", "RuntimeMaxSec=1800"]);

function linkAtomically(link, target) {
  const temporary = `${link}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}

async function headOf(ctx, dir) {
  const [command, args] = asUser(USERS.build, BIN.git, ["-c", "safe.directory=*", "-C", dir, "rev-parse", "HEAD"]);
  const result = await ctx.runner.run(command, args);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** npm ci finished (it writes node_modules/.package-lock.json last) at this exact sha. */
async function toolsReady(ctx, commit) {
  const dir = ctx.layout.toolsDir(commit);
  if (!existsSync(path.join(dir, "node_modules/.package-lock.json"))) return null;
  return (await headOf(ctx, dir)) === commit ? dir : null;
}

async function requireTools(ctx, commit) {
  const dir = await toolsReady(ctx, commit);
  if (!dir) throw new AgentError("tools_missing");
  return dir;
}

async function npmCi(ctx, dir, args, code) {
  const install = systemdRunArgs({
    user: USERS.build,
    cwd: dir,
    unsetEnv: ["NODE_ENV"],
    properties: TOOLS_PROPERTIES,
    setEnv: await buildUserEnv(ctx),
    command: BIN.npm,
    args: ["ci", ...args, "--no-audit", "--no-fund", "--prefer-offline"],
  });
  await must(ctx.runner, code, BIN.systemdRun, install, { capture: false });
}

/** Start a oneshot unit, wait for it to finish, and require Result=success. */
async function runUnit(ctx, unit, code) {
  await must(ctx.runner, code, BIN.systemctl, ["start", "--wait", unit]);
  const result = await must(ctx.runner, code, BIN.systemctl, ["show", "--property=Result", "--value", unit]);
  if (result.stdout.trim() !== "success") throw new AgentError(code);
}

/** `prepare <sha>`: the tools clone at the sha, with dev dependencies. */
export async function prepareTools(ctx, commit) {
  await fetchMain(ctx);
  await requireOnMain(ctx, commit);
  const dir = ctx.layout.toolsDir(commit);
  if (!(await toolsReady(ctx, commit))) {
    // A half-made clone (a crash inside npm ci) is rebuilt from nothing.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(ctx.layout.tools, { recursive: true });
    await cloneAt(ctx, dir, commit);
    await npmCi(ctx, dir, ["--include=dev"], "install_failed");
  }
  if (!existsSync(ctx.layout.toolsCurrent)) linkAtomically(ctx.layout.toolsCurrent, path.basename(dir));
  return { dir };
}

/** Run one repo script from the tools clone; resolves its stdout lines. */
async function runTool(ctx, { dir, envFile, setEnv = {}, script, args = [], code }) {
  const unit = systemdRunArgs({
    user: USERS.build,
    cwd: dir,
    envFiles: [envFile],
    properties: TOOLS_PROPERTIES,
    setEnv: { ...(await buildUserEnv(ctx)), ...setEnv },
    command: BIN.node,
    args: [script, ...args],
  });
  const lines = [];
  const result = await ctx.runner.run(BIN.systemdRun, unit, { onLine: (line) => lines.push(line), capture: false });
  if (result.code !== 0) throw new AgentError(code);
  return lines;
}

/** `attest <lg> <sha>`: both production gates against the league database. */
export async function attest(ctx, lg, commit) {
  loadLeagueEnv(ctx, lg);
  const dir = await requireTools(ctx, commit);
  const common = { dir, envFile: ctx.layout.leagueEnv(lg), setEnv: { NODE_ENV: "production" }, code: "attest_failed" };
  const env = await runTool(ctx, { ...common, script: "scripts/validate-prod-env.mjs" });
  if (!env.some((line) => line.includes("Production environment validation passed."))) throw new AgentError("attest_failed");
  const schema = await runTool(ctx, { ...common, script: "scripts/production-schema-check.mjs" });
  if (!schema.some((line) => line.includes("Production schema attestation passed"))) throw new AgentError("attest_failed");
  return { ok: true };
}

/** `preflight <lg> <sha>`: migration-preflight.mjs as the owner role. */
export async function preflight(ctx, lg, commit) {
  loadOwnerUrl(ctx, lg);
  const dir = await requireTools(ctx, commit);
  const lines = await runTool(ctx, {
    dir,
    envFile: ctx.layout.migrateEnv(lg),
    script: "scripts/migration-preflight.mjs",
    code: "preflight_failed",
  });
  if (!lines.some((line) => line.includes("Migration data preflight passed."))) throw new AgentError("preflight_failed");
  return { ok: true };
}

/**
 * `migrate <lg> <sha>`: release-migrations.mjs as the owner, with
 * VERCEL_ENV=production set only in that child (design D16), then the grant
 * check. The drill and backups then use these tools.
 */
export async function migrate(ctx, lg, commit) {
  loadOwnerUrl(ctx, lg);
  const dir = await requireTools(ctx, commit);
  const lines = await runTool(ctx, {
    dir,
    envFile: ctx.layout.migrateEnv(lg),
    setEnv: { VERCEL_ENV: "production" },
    script: "scripts/release-migrations.mjs",
    args: ["--apply", commit],
    code: "migrate_failed",
  });
  if (!lines.some((line) => line.includes(`Migration release completed for ${commit}.`)))
    throw new AgentError("migrate_failed");
  await grantsCheck(ctx, lg);
  linkAtomically(ctx.layout.toolsCurrent, path.basename(dir));
  return { ok: true };
}

/**
 * `backup <lg>`: run the backup unit and wait. backup-league.sh records its
 * result in /var/backups/ggd2l/<lg>/last-backup.json
 * ({file, sha256, offsiteKey, finishedAt}); without it, the newest dump and
 * its sidecar answer, with no offsite key.
 */
export async function backup(ctx, lg) {
  const started = ctx.now();
  await runUnit(ctx, `ggd2l-backup@${lg}.service`, "backup_failed");
  const record = readJson(path.join(ctx.layout.backupDir(lg), "last-backup.json"));
  if (record && Date.parse(record.finishedAt) >= started - 1000 && /^[0-9a-f]{64}$/.test(record.sha256 ?? ""))
    return { file: path.basename(String(record.file)), sha256: record.sha256, offsiteKey: record.offsiteKey ?? null };
  const latest = newestDump(ctx, lg);
  if (!latest || latest.mtimeMs < started - 1000) throw new AgentError("backup_failed");
  const sidecar = /^([0-9a-f]{64})\s/.exec(readFileSafe(`${latest.file}.sha256`));
  if (!sidecar) throw new AgentError("backup_failed");
  return { file: path.basename(latest.file), sha256: sidecar[1], offsiteKey: null };
}

function readFileSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function newestDump(ctx, lg) {
  const folder = path.join(ctx.layout.backupDir(lg), "local");
  let names = [];
  try {
    names = readdirSync(folder).filter((name) => /^backup-.+\.sql$/.test(name));
  } catch {
    return null;
  }
  return names
    .map((name) => ({ file: path.join(folder, name), mtimeMs: statSync(path.join(folder, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file))[0] ?? null;
}

/**
 * `drill <lg> [sha]`: the newest local dump restored into ld2l_restore_test by
 * rehearse-backup-restore.mjs as ggd2l_rehearsal, then dropped. Without a sha
 * this is the weekly drill unit; with one, the same helper runs against that
 * sha's tools clone (design §2.5 step 4).
 */
export async function drill(ctx, lg, commit) {
  if (!commit) {
    await runUnit(ctx, `ggd2l-drill@${lg}.service`, "drill_failed");
    return { ok: true };
  }
  const dir = await requireTools(ctx, commit);
  if (!existsSync(ctx.layout.drillEnv)) throw new AgentError("env_missing");
  const unit = systemdRunArgs({
    user: USERS.ops,
    envFiles: [ctx.layout.drillEnv],
    properties: ["MemoryMax=700M", "Nice=10", "IOSchedulingClass=idle", "RuntimeMaxSec=3600"],
    setEnv: { GGD2L_TOOLS_DIR: dir },
    command: BIN.bash,
    args: [ctx.layout.helper("drill-league.sh"), lg],
  });
  await must(ctx.runner, "drill_failed", BIN.systemdRun, unit, { capture: false });
  return { ok: true };
}

/**
 * `bot-deploy <sha>` (design §7): ops/dota-lobby-bot at the sha, production
 * dependencies only, owned by root and readable by ggd2l-bot, then `current`
 * moves to it. A running bot picks it up on its next restart.
 */
export async function botDeploy(ctx, commit) {
  const { layout, runner } = ctx;
  await fetchMain(ctx);
  await requireOnMain(ctx, commit);
  const short = commit.slice(0, 12);
  const dir = path.join(layout.botReleases, short);
  const botDir = path.join(dir, "ops/dota-lobby-bot");
  if (!existsSync(path.join(botDir, "node_modules/.package-lock.json"))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(layout.botReleases, { recursive: true });
    await must(runner, "bot_deploy_failed", BIN.install, ["-d", "-o", USERS.build, "-g", USERS.build, "-m", "0755", dir]);
    const archive = path.join(dir, ".source.tar");
    for (const [command, args] of [
      asUser(USERS.build, BIN.git, ["-c", "safe.directory=*", "-C", layout.repo, "archive", "--format=tar", `--output=${archive}`, commit, "ops/dota-lobby-bot"]),
      asUser(USERS.build, BIN.tar, ["-x", "-f", archive, "-C", dir]),
    ])
      await must(runner, "bot_deploy_failed", command, args);
    rmSync(archive, { force: true });
    await npmCi(ctx, botDir, ["--omit=dev"], "bot_deploy_failed");
    await must(runner, "bot_deploy_failed", BIN.chown, ["-R", `root:${USERS.bot}`, dir]);
    await must(runner, "bot_deploy_failed", BIN.chmod, ["-R", "g-w,o-rwx", dir]);
  }
  mkdirSync(path.dirname(layout.botCurrent), { recursive: true });
  linkAtomically(layout.botCurrent, path.join("releases", short));
  return { ok: true, dir };
}

/** `bot-status`: the unit, the deployed release and whether a lobby is held. */
export async function botStatus(ctx) {
  const result = await ctx.runner.run(BIN.systemctl, [
    "show",
    "ggd2l-bot.service",
    "--property=ActiveState,SubState,UnitFileState,NRestarts,ActiveEnterTimestamp",
  ]);
  const props = Object.fromEntries(
    result.stdout.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  let release = null;
  try {
    release = path.basename(readlinkSync(ctx.layout.botCurrent));
  } catch {
    // Not deployed yet.
  }
  const lobbies = readJson(path.join(ctx.layout.botState, "lobbies.json"));
  return {
    ok: true,
    active: props.ActiveState ?? "unknown",
    subState: props.SubState ?? "unknown",
    enabled: props.UnitFileState ?? "unknown",
    restarts: Number(props.NRestarts ?? 0),
    since: props.ActiveEnterTimestamp || null,
    release: /^[0-9a-f]{12}$/.test(release ?? "") ? release : null,
    lobby: lobbies ? (lobbies.active ? "set" : null) : "unknown",
  };
}
