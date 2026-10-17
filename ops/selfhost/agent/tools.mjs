// The tools clone and what runs from it (design §2.1, §2.5, §5.1, §7):
// prepare, attest, preflight, migrate, backup, drill, bot-deploy, bot-status.
//
// Each repo script runs as ggd2l-build from /srv/ggd2l/tools/<sha12> inside a
// systemd-run unit that reads the env files itself (-p EnvironmentFile=), so
// no secret is ever on a command line and the agent never holds it in a child.
// Its output goes, redacted like the build log, to
// /var/log/ggd2l/tools/<verb>-<lg>-<stamp>-<sha12>.log; stdout and the error
// JSON never carry it.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { buildUserEnv, cloneAt, fetchMain, lockDownTree, requireOnMain } from "./build.mjs";
import { loadEnvFile, loadLeagueEnv, loadMigrateEnv, openRedactedLog, readJson } from "./context.mjs";
import { grantsCheck } from "./database.mjs";
import { AgentError, BIN, USERS, compactStamp } from "./layout.mjs";
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

/**
 * One redacted log per verb run, /var/log/ggd2l/tools/<verb>-<lg>-<stamp>-<sha12>.log,
 * so a failure at a time-critical step can be read afterwards without
 * re-running a script by hand. Seeded with every env file the unit reads.
 */
function openToolLog(ctx, verb, lg, commit, envs) {
  const name = `${verb}-${lg}-${compactStamp(ctx.now())}-${commit.slice(0, 12)}`;
  return openRedactedLog(ctx, ctx.layout.toolLog(name), envs);
}

/**
 * Run one repo script from the tools clone; resolves its output lines. With
 * several env files systemd reads them in order and a later file's value wins.
 */
async function runTool(ctx, { dir, envFiles, setEnv = {}, script, args = [], code, log }) {
  const unit = systemdRunArgs({
    user: USERS.build,
    cwd: dir,
    envFiles,
    properties: TOOLS_PROPERTIES,
    setEnv: { ...(await buildUserEnv(ctx)), ...setEnv },
    command: BIN.node,
    args: [script, ...args],
  });
  const lines = [];
  log.write(`== ${script} (${new Date(ctx.now()).toISOString()})`);
  const onLine = (line) => {
    lines.push(line);
    log.write(line);
  };
  const result = await ctx.runner.run(BIN.systemdRun, unit, { onLine, capture: false });
  log.write(`== exit ${result.code}`);
  if (result.code !== 0) throw new AgentError(code);
  return lines;
}

/** Run `work(log)` with a tool log open, and close the log whatever happens. */
async function withToolLog(ctx, verb, lg, commit, envs, work) {
  const log = openToolLog(ctx, verb, lg, commit, envs);
  try {
    return await work(log);
  } finally {
    await log.close();
  }
}

/** `attest <lg> <sha>`: both production gates against the league database. */
export async function attest(ctx, lg, commit) {
  const env = loadLeagueEnv(ctx, lg);
  const dir = await requireTools(ctx, commit);
  return withToolLog(ctx, "attest", lg, commit, [env], async (log) => {
    const common = { dir, envFiles: [ctx.layout.leagueEnv(lg)], setEnv: { NODE_ENV: "production" }, code: "attest_failed", log };
    const gate = await runTool(ctx, { ...common, script: "scripts/validate-prod-env.mjs" });
    if (!gate.some((line) => line.includes("Production environment validation passed."))) throw new AgentError("attest_failed");
    const schema = await runTool(ctx, { ...common, script: "scripts/production-schema-check.mjs" });
    if (!schema.some((line) => line.includes("Production schema attestation passed"))) throw new AgentError("attest_failed");
    return { ok: true };
  });
}

/** `preflight <lg> <sha>`: migration-preflight.mjs as the owner role. */
export async function preflight(ctx, lg, commit) {
  const owner = loadMigrateEnv(ctx, lg);
  const dir = await requireTools(ctx, commit);
  return withToolLog(ctx, "preflight", lg, commit, [owner], async (log) => {
    const lines = await runTool(ctx, {
      dir,
      envFiles: [ctx.layout.migrateEnv(lg)],
      script: "scripts/migration-preflight.mjs",
      code: "preflight_failed",
      log,
    });
    if (!lines.some((line) => line.includes("Migration data preflight passed."))) throw new AgentError("preflight_failed");
    return { ok: true };
  });
}

/**
 * `migrate <lg> <sha>`: release-migrations.mjs as the owner, with
 * VERCEL_ENV=production set only in that child (design D16), then the grant
 * check. The drill and backups then use these tools.
 *
 * The script's first step is validate-prod-env.mjs, which in production needs
 * the whole league env (secrets, APP_URL, ADMIN_STEAM_IDS...), and its
 * postflight attests the instance identity from APP_URL and the region. So
 * the unit reads the league env first and the migrate env second: systemd
 * lets the later file win, and only the owner's DATABASE_URL and DIRECT_URL
 * replace the app role's.
 */
export async function migrate(ctx, lg, commit) {
  const env = loadLeagueEnv(ctx, lg);
  const owner = loadMigrateEnv(ctx, lg);
  const dir = await requireTools(ctx, commit);
  await withToolLog(ctx, "migrate", lg, commit, [env, owner], async (log) => {
    const lines = await runTool(ctx, {
      dir,
      envFiles: [ctx.layout.leagueEnv(lg), ctx.layout.migrateEnv(lg)],
      setEnv: { VERCEL_ENV: "production" },
      script: "scripts/release-migrations.mjs",
      args: ["--apply", commit],
      code: "migrate_failed",
      log,
    });
    if (!lines.some((line) => line.includes(`Migration release completed for ${commit}.`)))
      throw new AgentError("migrate_failed");
  });
  await grantsCheck(ctx, lg);
  linkAtomically(ctx.layout.toolsCurrent, path.basename(dir));
  return { ok: true };
}

/**
 * The record backup-league.sh writes after a good run:
 * /var/backups/ggd2l/<lg>/state/last-backup.json, {ok, league, file, sha256,
 * offsiteKey, finishedAt, ...}, and possibly a copy beside state/. Only a
 * record for this league that says ok and carries a sha256 counts; of two,
 * the later finishedAt answers (state/ on a tie).
 */
export function readBackupRecord(ctx, lg) {
  const folder = ctx.layout.backupDir(lg);
  let best = null;
  for (const file of [path.join(folder, "state", "last-backup.json"), path.join(folder, "last-backup.json")]) {
    const record = readJson(file);
    const finishedAt = Date.parse(record?.finishedAt ?? "");
    if (
      record?.ok === true &&
      record.league === lg &&
      /^[0-9a-f]{64}$/.test(record.sha256 ?? "") &&
      Number.isFinite(finishedAt) &&
      (!best || finishedAt > Date.parse(best.finishedAt))
    )
      best = record;
  }
  return best;
}

/**
 * `backup <lg>`: run the backup unit and wait, then report the record it
 * wrote (with the R2 key). Without a fresh record, the newest dump and its
 * sidecar answer, with no offsite key.
 */
export async function backup(ctx, lg) {
  const started = ctx.now();
  await runUnit(ctx, `ggd2l-backup@${lg}.service`, "backup_failed");
  const record = readBackupRecord(ctx, lg);
  // finishedAt has whole seconds; a run that started in the same second counts.
  if (record && Date.parse(record.finishedAt) >= started - 1000)
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
 * sha's tools clone (design §2.5 step 4), so the new migrations are
 * rehearsed before `migrate` applies them.
 *
 * drill-league.sh takes the sha as its second argument (usage
 * `drill-league.sh us|eu [<40-hex sha>]`) and drills tools/<sha12>; without
 * one it drills tools/current, the live commit. GGD2L_TOOLS_DIR names the same
 * clone for a helper that reads it, and must agree with the sha.
 */
export async function drill(ctx, lg, commit) {
  if (!commit) {
    await runUnit(ctx, `ggd2l-drill@${lg}.service`, "drill_failed");
    return { ok: true };
  }
  const dir = await requireTools(ctx, commit);
  if (!existsSync(ctx.layout.drillEnv)) throw new AgentError("env_missing");
  const { env } = loadEnvFile(ctx, ctx.layout.drillEnv);
  const unit = systemdRunArgs({
    user: USERS.ops,
    envFiles: [ctx.layout.drillEnv],
    properties: ["MemoryMax=700M", "Nice=10", "IOSchedulingClass=idle", "RuntimeMaxSec=3600"],
    setEnv: { GGD2L_TOOLS_DIR: dir },
    command: BIN.bash,
    args: [ctx.layout.helper("drill-league.sh"), lg, commit],
  });
  return withToolLog(ctx, "drill", lg, commit, [env], async (log) => {
    log.write(`== drill-league.sh ${lg} ${commit} (${new Date(ctx.now()).toISOString()})`);
    const result = await ctx.runner.run(BIN.systemdRun, unit, { onLine: log.write, capture: false });
    log.write(`== exit ${result.code}`);
    if (result.code !== 0) throw new AgentError("drill_failed");
    return { ok: true };
  });
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
    await lockDownTree(runner, dir, USERS.bot, "bot_deploy_failed");
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
