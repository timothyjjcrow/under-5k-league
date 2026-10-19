// `fetch` and `build <lg> <sha>` (design §2.2): an exact CI-green SHA becomes a
// locked-down release folder plus its static files in the league's union dir.
//
// npm ci and the build run as ggd2l-build inside systemd-run units at low CPU
// and OOM priority (and an I/O weight the box's disk ignores: BUILD_PROPERTIES),
// the build under memory limits. The league env reaches the build only through
// `-p EnvironmentFile=`; the build log is written with every env value of 8 or
// more characters replaced by [redacted].
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseCgroupReport } from "./cgroup-report.mjs";
import { loadLeagueEnv, openRedactedLog, writeJsonAtomic } from "./context.mjs";
import { AgentError, BIN, MIN_BUILD_FREE_BYTES, RELEASE_WRITABLE_DIRS, USERS, makeReleaseId } from "./layout.mjs";
import { asUser, must, systemdRunArgs } from "./runner.mjs";

export const ENV_GATE_LINE = "Production environment validation passed.";
export const SCHEMA_GATE_LINE = "Production schema attestation passed";
export const BUILD_NODE_OPTIONS = "--max-old-space-size=3072";
// Low priority so the live slots keep answering while a build runs; the box
// holds every build to these (checked in an identical unit, 2026-10-18).
// MemoryHigh pushes the build into swap rather than OOM-killing it: two
// builds (2026-10-17/18) sat near 1.1 GiB with 0.7-0.8 GB in swap. MemoryMax
// stays above the 1.54 GB the 2026-10-15 trial build peaked at outside these
// limits. A build's own peak is its unit's memory.peak (reportOnStop).
// IOWeight needs io.cost or BFQ, and the box's disk runs mq-deadline, so
// there it sets io.weight and nothing more.
export const BUILD_PROPERTIES = Object.freeze([
  "CPUWeight=20",
  "IOWeight=20",
  "Nice=10",
  "MemoryHigh=1200M",
  "MemoryMax=1800M",
  "OOMScoreAdjust=600",
  "RuntimeMaxSec=2400",
]);
const INSTALL_PROPERTIES = Object.freeze(["CPUWeight=20", "IOWeight=20", "Nice=10", "RuntimeMaxSec=1800"]);

// The files a box build must produce (design §2.2 step 7).
export const REQUIRED_ARTIFACTS = Object.freeze([
  "node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node",
  "node_modules/@img/sharp-linux-x64",
  ".next/BUILD_ID",
  ".next/static",
  "public/merch/jerseys",
  "src/lib/og-fonts",
  "src/app/overlay/overlay-client.js",
]);

/**
 * The build user's home and npm cache. ggd2l-build has no login home, and npm,
 * Prisma and Next each write a little under $HOME, so every unit that runs
 * repo code as ggd2l-build gets this one. Created here, idempotently.
 */
export async function buildUserEnv(ctx) {
  const { layout, runner } = ctx;
  for (const dir of [layout.buildHome, layout.npmCache])
    await must(runner, "install_failed", BIN.install, ["-d", "-o", USERS.build, "-g", USERS.build, "-m", "0750", dir]);
  return { HOME: layout.buildHome, npm_config_cache: layout.npmCache };
}

/**
 * The dotenv files Next (@next/env, in any mode) and Prisma (the root and
 * prisma/) load by themselves, which would quietly add to or override the env
 * systemd hands the build. The repo's tracked examples (.env.example,
 * .env.europe.example) are never loaded, so they stay.
 */
export const AUTOLOADED_DOTENV_RE = /^\.env(?:\.local|\.(?:production|development|test)(?:\.local)?)?$/;

/** git as the repo's owner; safe.directory because root also reads these clones. */
function git(args) {
  return asUser(USERS.build, BIN.git, ["-c", "safe.directory=*", ...args]);
}

/** `fetch`: update origin/main in the bare mirror. */
export async function fetchMain(ctx) {
  const repo = ctx.layout.repo;
  const [command, args] = git(["-C", repo, "fetch", "--quiet", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  await must(ctx.runner, "fetch_failed", command, args);
  const [revCommand, revArgs] = git(["-C", repo, "rev-parse", "refs/remotes/origin/main"]);
  const head = (await must(ctx.runner, "fetch_failed", revCommand, revArgs)).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new AgentError("fetch_failed");
  return { head };
}

export async function requireOnMain(ctx, commit) {
  const [command, args] = git(["-C", ctx.layout.repo, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"]);
  if ((await ctx.runner.run(command, args)).code !== 0) throw new AgentError("not_on_main");
}

/**
 * A fresh clone of the mirror at exactly `commit`, owned by ggd2l-build.
 * The mirror's main lives under refs/remotes, which a plain clone skips, so
 * the clone fetches it by name before checking out.
 */
export async function cloneAt(ctx, dir, commit) {
  const { runner } = ctx;
  await must(runner, "clone_failed", BIN.install, ["-d", "-o", USERS.build, "-g", USERS.build, "-m", "0755", dir]);
  for (const args of [
    ["clone", "--quiet", "--no-hardlinks", "--no-checkout", ctx.layout.repo, dir],
    ["-C", dir, "fetch", "--quiet", "--no-tags", "origin", "+refs/remotes/origin/main:refs/remotes/origin/main"],
    ["-C", dir, "checkout", "--quiet", "--detach", commit],
  ]) {
    const [command, argv] = git(args);
    await must(runner, "clone_failed", command, argv);
  }
  const [revCommand, revArgs] = git(["-C", dir, "rev-parse", "HEAD"]);
  if ((await must(runner, "clone_failed", revCommand, revArgs)).stdout.trim() !== commit)
    throw new AgentError("clone_mismatch");
  const [statusCommand, statusArgs] = git(["-C", dir, "status", "--porcelain", "--untracked-files=all"]);
  if ((await must(runner, "clone_failed", statusCommand, statusArgs)).stdout.trim())
    throw new AgentError("dirty_checkout");
  for (const folder of [dir, path.join(dir, "prisma")]) {
    let names = [];
    try {
      names = readdirSync(folder);
    } catch {
      // No such folder.
    }
    if (names.some((name) => AUTOLOADED_DOTENV_RE.test(name))) throw new AgentError("dotenv_present");
  }
}

/**
 * Every symlink under `dir` must point inside `dir`. npm ci and the build run
 * third-party code as ggd2l-build, and root then chowns, chmods and publishes
 * the tree: a planted link (say .next/static -> /etc/ggd2l) would otherwise
 * make root copy or re-own files outside the release. Checked lexically, link
 * by link, so a chain of inside links stays inside and a dangling one inside
 * is allowed. Run it after the build user's units have exited and the tree is
 * root's, so nothing can change it between the check and the use.
 */
export function assertLinksContained(dir, code = "link_escapes") {
  const root = path.resolve(dir);
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.resolve(path.dirname(full), readlinkSync(full));
        if (target !== root && !target.startsWith(root + path.sep)) throw new AgentError(code);
      } else if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
}

// A release or the bot: its group reads it, others nothing. A tools clone,
// which the build user and ggd2l-ops both read: everyone reads it.
const RELEASE_TREE_MODE = "g+rX,g-w,o-rwx";
export const TOOLS_TREE_MODE = "a+rX,go-w";

/**
 * Take a tree the build user wrote: root owns it (never following a link),
 * no link escapes it, then nobody but root can write it, and the group (or,
 * with TOOLS_TREE_MODE, everyone) can read it.
 */
export async function lockDownTree(runner, dir, group, code, mode = RELEASE_TREE_MODE) {
  await must(runner, code, BIN.chown, ["-R", "-P", "-h", `root:${group}`, dir]);
  assertLinksContained(dir);
  await must(runner, code, BIN.chmod, ["-R", mode, dir]);
}

/**
 * Every part of `relative` under `dir` that exists must be a real directory.
 * Root re-owns these folders for the league user, so a link the build left in
 * their place (even one inside the release) would hand it something else.
 */
function requireRealDirs(dir, relative) {
  let current = dir;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return; // Missing from here down: `install -d` creates it.
    }
    if (!stat.isDirectory()) throw new AgentError("lockdown_failed");
  }
}

/**
 * Each unit prints its own cgroup as it stops (cgroup-report.mjs), so the
 * record holds the build's real memory peak, never systemd-run's "Memory
 * peak", which systemd 255 can repeat from the unit's first second. "-": a
 * report that fails never fails the unit.
 */
const reportOnStop = (ctx) => `ExecStopPost=-${BIN.node} ${ctx.layout.helper("cgroup-report.mjs")}`;

/** The log's summary of a unit's report, after systemd-run's own. */
function memoryLine(step, report) {
  if (report?.peakMb == null) return `== ${step} memory peak unknown (no cgroup report)`;
  const swap = report.swapPeakMb == null ? "" : `, swap peak ${report.swapPeakMb} MB`;
  return `== ${step} memory peak ${report.peakMb} MB${swap}, read from the unit's cgroup as it stopped`;
}

export async function buildRelease(ctx, lg, commit) {
  const { layout, runner } = ctx;

  // 1. Arguments are checked by the caller; the env contract and disk here.
  const env = loadLeagueEnv(ctx, lg);
  if (ctx.freeBytes(layout.srv) < MIN_BUILD_FREE_BYTES) throw new AgentError("disk_low");

  // 2. Only a commit on origin/main is ever built.
  await fetchMain(ctx);
  await requireOnMain(ctx, commit);

  const startedAt = ctx.now();
  const id = makeReleaseId(lg, commit, startedAt);
  const dir = layout.release(id);
  mkdirSync(layout.releases(lg), { recursive: true });
  const log = openRedactedLog(ctx, layout.buildLog(id), [env]);
  let logSha256 = null;
  const record = {
    id,
    region: lg,
    sha: commit,
    role: "candidate",
    state: "BUILDING",
    node: process.version,
    builtAt: null,
    buildSeconds: null,
    peakRssMb: null,
    buildLogSha256: null,
  };

  try {
    // 3. Clone as ggd2l-build.
    await cloneAt(ctx, dir, commit);
    // The build writes the server-action key into .next: nobody else reads it.
    await must(runner, "clone_failed", BIN.chmod, ["0700", dir]);
    writeJsonAtomic(path.join(dir, "release.json"), record);

    // 4. Install with devDependencies (typescript, tailwind): NODE_ENV unset.
    const install = systemdRunArgs({
      user: USERS.build,
      cwd: dir,
      unsetEnv: ["NODE_ENV"],
      properties: [...INSTALL_PROPERTIES, reportOnStop(ctx)],
      setEnv: await buildUserEnv(ctx),
      command: BIN.npm,
      args: ["ci", "--include=dev", "--no-audit", "--no-fund", "--prefer-offline"],
    });
    log.write(`== npm ci (${new Date(ctx.now()).toISOString()})`);
    let installReport = null;
    const onInstallLine = (line) => {
      installReport = parseCgroupReport(line) ?? installReport;
      log.write(line);
    };
    const installed = await runner.run(BIN.systemdRun, install, { onLine: onInstallLine, capture: false });
    log.write(memoryLine("npm ci", installReport));
    if (installed.code !== 0) throw new AgentError("install_failed");

    // 5. Build with the league env, NODE_ENV=production and no in-build type check.
    const gates = { env: false, schema: false };
    let report = null;
    const onLine = (line) => {
      if (line.includes(ENV_GATE_LINE)) gates.env = true;
      if (line.includes(SCHEMA_GATE_LINE)) gates.schema = true;
      report = parseCgroupReport(line) ?? report;
      log.write(line);
    };
    const build = systemdRunArgs({
      user: USERS.build,
      cwd: dir,
      envFiles: [layout.leagueEnv(lg)],
      properties: [...BUILD_PROPERTIES, reportOnStop(ctx)],
      setEnv: {
        ...(await buildUserEnv(ctx)),
        NODE_ENV: "production",
        LEAGUE_RELEASE_SHA: commit,
        GGD2L_SKIP_BUILD_TYPECHECK: "1",
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_OPTIONS: BUILD_NODE_OPTIONS,
      },
      command: BIN.node,
      args: ["scripts/vercel-build.mjs"],
    });
    const buildStarted = ctx.now();
    log.write(`== build (${new Date(buildStarted).toISOString()})`);
    const built = await runner.run(BIN.systemdRun, build, { onLine, capture: false });
    record.buildSeconds = Math.round((ctx.now() - buildStarted) / 1000);
    // The build cgroup's memory.peak; kept on a FAILED record too (an OOM kill).
    record.peakRssMb = report?.peakMb ?? null;
    log.write(memoryLine("build", report));
    if (built.code !== 0) throw new AgentError("build_failed");

    // 6. Without NODE_ENV=production both gates skip silently: require their lines.
    if (!gates.env || !gates.schema) throw new AgentError("gate_line_missing");
    const [statusCommand, statusArgs] = git(["-C", dir, "status", "--porcelain", "--untracked-files=no"]);
    if ((await must(runner, "dirty_checkout", statusCommand, statusArgs)).stdout.trim())
      throw new AgentError("dirty_checkout");

    // 7. What a linux runtime needs must be there.
    // .next/static is read here and published by root below: never through a link.
    const staticDir = path.join(dir, ".next/static");
    let staticStat = null;
    try {
      staticStat = lstatSync(staticDir);
    } catch {
      // Missing: the artifact check below reports it.
    }
    if (staticStat && !staticStat.isDirectory()) throw new AgentError("link_escapes");
    for (const artifact of REQUIRED_ARTIFACTS)
      if (!existsSync(path.join(dir, artifact))) throw new AgentError("artifact_missing");
    if (readdirSync(staticDir).length === 0) throw new AgentError("artifact_missing");

    // 8. Root owns the release; the league user can read it and write only
    // the folders `next start` writes. The build makes no route-cache, and
    // without it every response-cache write fails on the read-only tree.
    const leagueUser = USERS.league(lg);
    await lockDownTree(runner, dir, leagueUser, "lockdown_failed");
    for (const relative of RELEASE_WRITABLE_DIRS) requireRealDirs(dir, relative);
    for (const relative of RELEASE_WRITABLE_DIRS) {
      const writable = path.join(dir, relative);
      await must(runner, "lockdown_failed", BIN.install, ["-d", "-o", leagueUser, "-g", leagueUser, "-m", "0700", writable]);
      await must(runner, "lockdown_failed", BIN.chown, ["-R", "-P", "-h", `${leagueUser}:${leagueUser}`, writable]);
    }

    // 9. Add (never replace) this build's chunks to the union dir Caddy serves.
    // World-readable: Caddy runs as caddy, and these files are public anyway.
    mkdirSync(layout.staticDir(lg), { recursive: true });
    await must(runner, "publish_failed", BIN.rsync, [
      "-a",
      "--no-links",
      "--no-owner",
      "--no-group",
      "--chmod=D0755,F0644",
      `${path.join(dir, ".next/static")}/`,
      `${layout.staticDir(lg)}/`,
    ]);

    // 10. Record.
    writeFileSync(path.join(dir, ".release.env"), `LEAGUE_RELEASE_SHA=${commit}\n`, { mode: 0o644 });
    logSha256 = await log.close();
    Object.assign(record, { state: "BUILT", builtAt: new Date(ctx.now()).toISOString(), buildLogSha256: logSha256 });
    writeJsonAtomic(path.join(dir, "release.json"), record);
    return { id, buildSeconds: record.buildSeconds, peakRssMb: record.peakRssMb };
  } catch (error) {
    if (logSha256 === null) logSha256 = await log.close();
    // Leave the folder for inspection; prune removes a FAILED release.
    if (existsSync(dir)) {
      try {
        writeJsonAtomic(path.join(dir, "release.json"), { ...record, state: "FAILED", buildLogSha256: logSha256 });
      } catch {
        // The failure itself is what the caller needs to see.
      }
    }
    throw error;
  }
}
