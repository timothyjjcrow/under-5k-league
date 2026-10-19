// The tools clone and what runs from it (design §2.1, §2.5, §5.1, §7):
// prepare, attest, preflight, migrate, backup, drill, bot-deploy, bot-status,
// and envcheck's production validation.
//
// Each repo script runs as ggd2l-build from /srv/ggd2l/tools/<sha12> inside a
// systemd-run unit that reads the env files itself (-p EnvironmentFile=), so
// no secret is ever on a command line and the agent never holds it in a child.
// Its output goes, redacted like the build log, to
// /var/log/ggd2l/tools/<verb>-<lg>-<stamp>-<sha12>.log; stdout and the error
// JSON never carry it.
//
// A tools clone is root's from the end of its npm ci (TOOLS_TREE_MODE: all
// read it, only root writes it), like a release: the hourly backup and the
// drill run its scripts as ggd2l-ops, which holds the R2 credentials and the
// dumps, so the build user, whose npm runs third-party code, must not be able
// to change them. No verb runs from a clone root has not locked down.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { ENV_GATE_LINE, TOOLS_TREE_MODE, buildUserEnv, cloneAt, fetchMain, lockDownTree, requireOnMain } from "./build.mjs";
import { loadEnvFile, loadLeagueEnv, loadMigrateEnv, openRedactedLog, readJson } from "./context.mjs";
import { grantsCheck } from "./database.mjs";
import { AgentError, BIN, USERS, compactStamp } from "./layout.mjs";
import { readLive } from "./releases.mjs";
import { asUser, createRedactor, must, systemdRunArgs } from "./runner.mjs";

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

/** Root owns the clone itself (lockDownTree has run), never through a link. */
function lockedDown(ctx, dir) {
  try {
    return ctx.ownerOf(dir) === 0;
  } catch {
    return false;
  }
}

/**
 * npm ci finished (it writes node_modules/.package-lock.json last) at this
 * exact sha, and root has locked the clone down since.
 */
async function toolsReady(ctx, commit) {
  const dir = ctx.layout.toolsDir(commit);
  if (!lockedDown(ctx, dir) || !existsSync(path.join(dir, "node_modules/.package-lock.json"))) return null;
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

/**
 * `prepare <sha>`: the tools clone at the sha, with dev dependencies, owned by
 * root and readable by everyone.
 */
export async function prepareTools(ctx, commit) {
  await fetchMain(ctx);
  await requireOnMain(ctx, commit);
  const dir = ctx.layout.toolsDir(commit);
  if (!(await toolsReady(ctx, commit))) {
    // A half-made clone (a crash inside npm ci), or one root never locked down
    // (made before 2026-10-19, or a crash before the lockdown), is rebuilt
    // from nothing: the build user could have changed it.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(ctx.layout.tools, { recursive: true });
    await cloneAt(ctx, dir, commit);
    await npmCi(ctx, dir, ["--include=dev"], "install_failed");
  }
  // After npm ci's unit has exited, as build does to a release. Again on a
  // ready clone: it changes nothing there, and it finishes a lockdown a crash
  // cut short after the chown. A clone it refuses (a link out of it) is
  // removed: root may own it by then, and it must not look ready.
  try {
    await lockDownTree(ctx.runner, dir, "root", "tools_lockdown_failed", TOOLS_TREE_MODE);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  if (!existsSync(ctx.layout.toolsCurrent)) linkAtomically(ctx.layout.toolsCurrent, path.basename(dir));
  return { dir };
}

/**
 * git refuses a repository another user owns ("dubious ownership"), and the
 * clone is root's: release-migrations.mjs reads HEAD and status as the build
 * user. Command-scope config (GIT_CONFIG_COUNT), which git honours for
 * safe.directory, names exactly this clone.
 */
function gitSafeDirectory(dir) {
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: dir };
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
async function runTool(ctx, { dir, envFiles, setEnv = {}, properties = [], script, args = [], code, log }) {
  const unit = systemdRunArgs({
    user: USERS.build,
    cwd: dir,
    envFiles,
    properties: [...TOOLS_PROPERTIES, ...properties],
    setEnv: { ...(await buildUserEnv(ctx)), ...gitSafeDirectory(dir), ...setEnv },
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

// scripts/validate-prod-env.mjs: the production gate every build, attest and
// migrate runs. envcheck runs it too, against the file as it stands.
const PROD_ENV_SCRIPT = "scripts/validate-prod-env.mjs";
const ENVCHECK_PROPERTIES = Object.freeze(["CPUWeight=20", "Nice=10", "RuntimeMaxSec=120"]);
// An env name as the validator's messages spell one (AUTH_SECRET, APP_URL).
const ENV_NAME_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/**
 * `envcheck`'s production validation: the league env file as it stands,
 * checked by the live release's own scripts/validate-prod-env.mjs. A restart,
 * a reboot or a rollback starts a slot on that file with no build, and the
 * slot's ExecStartPre runs only the env contract, which never checks
 * AUTH_SECRET, CRON_SECRET, ADMIN_STEAM_IDS or STEAM_API_KEY. It runs as the
 * league user, which already reads the file, from the release that user
 * already runs, in a unit that reads the file itself. Resolves problems that
 * name env keys only, never a value or the script's text; which rule each
 * broke is in the redacted tool log, envcheck-<lg>-<stamp>-<sha12>.log.
 */
export async function productionEnvProblems(ctx, lg, env) {
  const live = readLive(ctx, lg);
  if (!live) return ["production validation: no live release to run it from (a build runs it)"];
  const unit = systemdRunArgs({
    user: USERS.league(lg),
    cwd: ctx.layout.release(live.id),
    envFiles: [ctx.layout.leagueEnv(lg)],
    properties: ENVCHECK_PROPERTIES,
    setEnv: { NODE_ENV: "production" },
    command: BIN.node,
    args: [PROD_ENV_SCRIPT],
  });
  const redact = createRedactor([env]);
  return withToolLog(ctx, "envcheck", lg, live.sha, [env], async (log) => {
    log.write(`== ${PROD_ENV_SCRIPT} from ${live.id} (${new Date(ctx.now()).toISOString()})`);
    const lines = [];
    const onLine = (line) => {
      lines.push(redact(line));
      log.write(line);
    };
    const result = await ctx.runner.run(BIN.systemdRun, unit, { onLine, capture: false });
    log.write(`== exit ${result.code}`);
    if (result.code === 0 && lines.some((line) => line.includes(ENV_GATE_LINE))) return [];
    // Its failures are "  - <message>" lines, each naming the keys it broke.
    const names = new Set();
    for (const line of lines.filter((text) => /^\s*- /.test(text)))
      for (const [name] of line.matchAll(ENV_NAME_RE)) names.add(name);
    if (names.size === 0) return ["production validation: failed or printed no pass line (the envcheck tool log says why)"];
    return [...names].map((name) => `${name}: fails the production validation`);
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
 * A copy of the clone's prisma/ that the build user may write, for one
 * migrate run, in `work` (a folder root has just made). release-migrations.mjs
 * switches prisma/schema.prisma to postgresql for Prisma and back, and the
 * clone is root's. Root copies the folder out of the locked clone, so nothing
 * the build user could have planted is followed; the unit mounts the copy over
 * the clone's prisma/ (BindPaths=), where git still sees the committed files.
 */
async function writablePrisma(ctx, dir, work) {
  const copy = path.join(work, "prisma");
  try {
    cpSync(path.join(dir, "prisma"), copy, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  } catch {
    throw new AgentError("migrate_failed");
  }
  await must(ctx.runner, "migrate_failed", BIN.chown, ["-R", "-P", "-h", `${USERS.build}:${USERS.build}`, copy]);
  return `BindPaths=${copy}:${path.join(dir, "prisma")}`;
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
 * replace the app role's. Its prisma/ is a per-run copy (writablePrisma),
 * removed when the run ends.
 */
export async function migrate(ctx, lg, commit) {
  const env = loadLeagueEnv(ctx, lg);
  const owner = loadMigrateEnv(ctx, lg);
  const dir = await requireTools(ctx, commit);
  mkdirSync(ctx.layout.runDir, { recursive: true });
  const work = mkdtempSync(path.join(ctx.layout.runDir, "ggd2l-migrate-"));
  try {
    const bindPrisma = await writablePrisma(ctx, dir, work);
    await withToolLog(ctx, "migrate", lg, commit, [env, owner], async (log) => {
      const lines = await runTool(ctx, {
        dir,
        envFiles: [ctx.layout.leagueEnv(lg), ctx.layout.migrateEnv(lg)],
        setEnv: { VERCEL_ENV: "production" },
        properties: [bindPrisma],
        script: "scripts/release-migrations.mjs",
        args: ["--apply", commit],
        code: "migrate_failed",
        log,
      });
      if (!lines.some((line) => line.includes(`Migration release completed for ${commit}.`)))
        throw new AgentError("migrate_failed");
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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
 * The record drill-league.sh writes after a passing drill, whether the weekly
 * unit or `drill <lg> <sha>` (systemd-run, outside the unit) ran it:
 * /var/backups/ggd2l/<lg>/state/last-drill.json, {ok, league, dump,
 * dumpSha256, tools, finishedAt}. A failed drill writes none, so this is the
 * last pass. Only a record for this league that says ok and carries a
 * readable finishedAt counts.
 */
export function readDrillRecord(ctx, lg) {
  const record = readJson(path.join(ctx.layout.backupDir(lg), "state", "last-drill.json"));
  if (record?.ok !== true || record.league !== lg || !Number.isFinite(Date.parse(record.finishedAt ?? ""))) return null;
  return record;
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
    // As in ggd2l-drill@.service: the drill uploads nothing, and Prisma runs
    // from the clone, so the R2 credentials stay out of its reach.
    properties: [
      "MemoryMax=700M",
      "Nice=10",
      "IOSchedulingClass=idle",
      "RuntimeMaxSec=3600",
      `InaccessiblePaths=-${ctx.layout.rcloneConf}`,
    ],
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
