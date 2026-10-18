import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AUTOLOADED_DOTENV_RE, BUILD_NODE_OPTIONS, ENV_GATE_LINE, REQUIRED_ARTIFACTS, SCHEMA_GATE_LINE, buildRelease } from "./build.mjs";
import { SHA, T0, TRACKED_DOTENV_EXAMPLES, leagueEnv, makeBox } from "./harness.test.mjs";
import { RELEASE_WRITABLE_DIRS } from "./layout.mjs";
import { describeRelease } from "./releases.mjs";

const ID = "us-20261016T150000Z-0123456789ab";

/**
 * What systemd-run --wait prints once a unit is gone, as systemd 255 does on
 * the box: a right CPU total, and a memory peak read as the unit started.
 */
const staleSummary = ({ result = "success", main = "code=exited/status=0" } = {}) => [
  `Finished with result: ${result}`,
  `Main processes terminated with: ${main}`,
  "Service runtime: 2min 31.112s",
  "CPU time consumed: 1min 58.036s",
  "Memory peak: 2.4M",
  "Memory swap peak: 0B",
];
// What cgroup-report.mjs prints as the build unit stops: 1240 MB, 300 MB swapped.
const BUILD_REPORT =
  "ggd2l cgroup: memory.peak=1300234240 memory.swap.peak=314572800 memory.high=1258291200 memory.max=1887436800 cpu.weight=20 events.high=4182 events.max=0 events.oom_kill=0";
const INSTALL_REPORT =
  "ggd2l cgroup: memory.peak=524288000 memory.swap.peak=0 memory.high=max memory.max=max cpu.weight=20 events.high=0 events.max=0 events.oom_kill=0";

/** A box whose git, npm and build behave like the real ones, as files. */
function buildBox({ buildLines, buildCode = 0, artifacts = REQUIRED_ARTIFACTS, onMain = true, dotenv = null, plant = null } = {}) {
  const box = makeBox();
  const env = box.writeEnv("us");
  const dir = box.layout.release(ID);
  const lines = buildLines ?? [
    "Vercel build: validate-environment",
    ENV_GATE_LINE,
    `connecting with ${env.DATABASE_URL}`,
    `password alone ${env.DATABASE_URL.split(":")[2].split("@")[0]}`,
    `AUTH_SECRET=${env.AUTH_SECRET} CRON=${env.CRON_SECRET}`,
    `site ${env.APP_URL} and key ${env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY}`,
    `${SCHEMA_GATE_LINE} in schema public: 16 migrations and 17 native objects verified.`,
    BUILD_REPORT,
    ...staleSummary(),
  ];
  box.on((command, args) => {
    const line = args.join(" ");
    if (command.endsWith("/runuser") && args.includes("merge-base")) return { code: onMain ? 0 : 1 };
    if (command.endsWith("/runuser") && line.includes("rev-parse refs/remotes/origin/main")) return { stdout: `${SHA}\n` };
    if (command.endsWith("/runuser") && line.includes("rev-parse HEAD")) return { stdout: `${SHA}\n` };
    if (command.endsWith("/install") && args.at(-1) === dir) {
      mkdirSync(dir, { recursive: true });
      return { code: 0 };
    }
    if (command.endsWith("/runuser") && args.includes("checkout")) {
      mkdirSync(path.join(dir, "prisma"), { recursive: true });
      writeFileSync(path.join(dir, "package.json"), "{}");
      // Every real checkout holds the tracked examples beside package.json.
      for (const name of TRACKED_DOTENV_EXAMPLES) writeFileSync(path.join(dir, name), "APP_URL=\n");
      if (dotenv) writeFileSync(path.join(dir, dotenv), "X=1");
      return { code: 0 };
    }
    if (command.endsWith("/systemd-run") && args.includes("scripts/vercel-build.mjs")) {
      for (const artifact of artifacts) {
        const target = path.join(dir, artifact);
        if (/\.\w+$/.test(artifact) || artifact.endsWith("BUILD_ID")) {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, "x");
        } else mkdirSync(target, { recursive: true });
      }
      if (artifacts.includes(".next/static")) {
        mkdirSync(path.join(dir, ".next/static/chunks"), { recursive: true });
        writeFileSync(path.join(dir, ".next/static/chunks/app.js"), "x");
      }
      // A normal npm tree links inside itself.
      mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
      symlinkSync("../next/dist/bin/next", path.join(dir, "node_modules/.bin/next"));
      if (plant) plant(dir);
      return { lines, code: buildCode };
    }
    if (command.endsWith("/systemd-run") && args.includes("ci"))
      return { lines: [`npm: cache ${box.layout.npmCache}`, INSTALL_REPORT, ...staleSummary()] };
    return undefined;
  });
  return { box, env, dir };
}

const argsOf = (box, pattern) => box.calls.find((call) => pattern.test([call.command, ...call.args].join(" ")))?.args;

test("build installs with dev dependencies and NODE_ENV unset, then builds with the league env file", async () => {
  const { box, dir } = buildBox();
  box.clock.t = T0;
  const result = await buildRelease(box.ctx, "us", SHA);
  assert.equal(result.id, ID);
  assert.equal(result.peakRssMb, 1240);

  const install = argsOf(box, /systemd-run .* ci /);
  assert.ok(install.includes("User=ggd2l-build"));
  assert.ok(install.includes("UnsetEnvironment=NODE_ENV"));
  assert.ok(install.join(" ").endsWith("/usr/bin/npm ci --include=dev --no-audit --no-fund --prefer-offline"));
  assert.ok(!install.some((arg) => arg.startsWith("EnvironmentFile=") || arg.startsWith("NODE_ENV=")));
  assert.ok(install.includes(`HOME=${box.layout.buildHome}`));
  assert.ok(install.includes(`npm_config_cache=${box.layout.npmCache}`));

  const build = argsOf(box, /scripts\/vercel-build\.mjs/);
  for (const expected of [
    "User=ggd2l-build",
    `WorkingDirectory=${dir}`,
    `EnvironmentFile=${box.layout.leagueEnv("us")}`,
    "CPUWeight=20",
    "IOWeight=20",
    "Nice=10",
    "MemoryHigh=1200M",
    "MemoryMax=1800M",
    "OOMScoreAdjust=600",
    "NODE_ENV=production",
    `LEAGUE_RELEASE_SHA=${SHA}`,
    "GGD2L_SKIP_BUILD_TYPECHECK=1",
    "NEXT_TELEMETRY_DISABLED=1",
    `NODE_OPTIONS=${BUILD_NODE_OPTIONS}`,
    `HOME=${box.layout.buildHome}`,
  ])
    assert.ok(build.includes(expected), expected);
  assert.equal(BUILD_NODE_OPTIONS, "--max-old-space-size=3072");
  assert.deepEqual(build.slice(-2), ["/usr/bin/node", "scripts/vercel-build.mjs"]);

  const record = JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8"));
  assert.equal(record.state, "BUILT");
  assert.equal(record.sha, SHA);
  assert.equal(record.role, "candidate");
  assert.match(record.buildLogSha256, /^[0-9a-f]{64}$/);
  // The hash is of the log as written, and `deployment` hands it to release-box.
  assert.equal(record.buildLogSha256, createHash("sha256").update(readFileSync(box.layout.buildLog(ID))).digest("hex"));
  assert.equal(describeRelease(box.ctx, ID).buildLogSha256, record.buildLogSha256);
  for (const name of TRACKED_DOTENV_EXAMPLES) assert.ok(existsSync(path.join(dir, name)), `${name} is part of a real checkout`);
  assert.equal(readFileSync(path.join(dir, ".release.env"), "utf8"), `LEAGUE_RELEASE_SHA=${SHA}\n`);

  const commands = box.calls.map((call) => [path.basename(call.command), ...call.args].join(" "));
  assert.ok(commands.includes(`chmod 0700 ${dir}`), "nobody else reads the tree while the build writes the action key");
  assert.ok(commands.includes(`chown -R -P -h root:ggd2l-us ${dir}`));
  assert.ok(commands.includes(`chmod -R g+rX,g-w,o-rwx ${dir}`));
  // The league user owns exactly the folders `next start` writes, each made
  // after the tree is locked down so the chmod cannot take them back.
  const lockdown = commands.indexOf(`chmod -R g+rX,g-w,o-rwx ${dir}`);
  assert.deepEqual(RELEASE_WRITABLE_DIRS, [".next/cache", ".next/server/route-cache"]);
  for (const writable of RELEASE_WRITABLE_DIRS) {
    const made = commands.indexOf(`install -d -o ggd2l-us -g ggd2l-us -m 0700 ${dir}/${writable}`);
    const owned = commands.indexOf(`chown -R -P -h ggd2l-us:ggd2l-us ${dir}/${writable}`);
    assert.ok(made > lockdown && owned > made, `${writable} is created, then owned, after the lockdown`);
  }
  assert.equal(commands.filter((line) => line.startsWith("install -d -o ggd2l-us ")).length, RELEASE_WRITABLE_DIRS.length);
  assert.ok(commands.includes(`rsync -a --no-links --no-owner --no-group --chmod=D0755,F0644 ${dir}/.next/static/ ${box.layout.staticDir("us")}/`));
  assert.ok(commands.some((line) => line.includes("merge-base --is-ancestor " + SHA)));
});

test("the build log has every env value of 8 or more characters redacted", async () => {
  const { box, env } = buildBox();
  await buildRelease(box.ctx, "us", SHA);
  const log = readFileSync(box.layout.buildLog(ID), "utf8");
  for (const [key, value] of Object.entries(env))
    if (value.length >= 8) assert.ok(!log.includes(value), `${key} leaked into the build log`);
  const password = env.DATABASE_URL.split(":")[2].split("@")[0];
  assert.ok(!log.includes(password));
  assert.match(log, /connecting with \[redacted\]/);
  assert.match(log, /password alone \[redacted\]/);
  assert.match(log, /site \[redacted\] and key \[redacted\]/);
  assert.ok(log.includes(ENV_GATE_LINE), "gate lines stay readable");
});

test("a build without both gate lines fails and is recorded FAILED", async () => {
  const { box, dir } = buildBox({ buildLines: [ENV_GATE_LINE, "Production schema attestation skipped for VERCEL_ENV=(unset)."] });
  await assert.rejects(buildRelease(box.ctx, "us", SHA), { code: "gate_line_missing" });
  assert.equal(JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8")).state, "FAILED");
  assert.ok(!box.calls.some((call) => call.command.endsWith("/rsync")), "nothing published");
});

test("a build missing a linux artifact fails", async () => {
  for (const missing of ["node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node", "node_modules/@img/sharp-linux-x64", ".next/BUILD_ID"]) {
    const { box } = buildBox({ artifacts: REQUIRED_ARTIFACTS.filter((artifact) => artifact !== missing) });
    await assert.rejects(buildRelease(box.ctx, "us", SHA), { code: "artifact_missing" }, missing);
  }
});

test("build refuses a sha that is not on origin/main, before cloning", async () => {
  const { box, dir } = buildBox({ onMain: false });
  await assert.rejects(buildRelease(box.ctx, "us", SHA), { code: "not_on_main" });
  assert.ok(!existsSync(dir));
  assert.ok(!box.calls.some((call) => call.args.includes("clone")));
});

test("build refuses a checkout holding a dotenv file Next or Prisma would load", async () => {
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.test.local", "prisma/.env"]) {
    const { box } = buildBox({ dotenv: name });
    await assert.rejects(buildRelease(box.ctx, "us", SHA), { code: "dotenv_present" }, name);
    assert.ok(!box.calls.some((call) => call.args.includes("ci")), `${name}: nothing installed`);
  }
});

test("only the dotenv names Next and Prisma load are refused", () => {
  for (const name of [".env", ".env.local", ".env.production", ".env.development", ".env.test", ".env.production.local", ".env.development.local", ".env.test.local"])
    assert.ok(AUTOLOADED_DOTENV_RE.test(name), name);
  for (const name of [...TRACKED_DOTENV_EXAMPLES, ".env.europe.discord.local", ".envrc", "env", ".env.production.bak", ".env.staging"])
    assert.ok(!AUTOLOADED_DOTENV_RE.test(name), name);
});

test("build refuses an env file that breaks the contract, and low disk, before any command", async () => {
  const { box } = buildBox();
  box.writeEnv("us", leagueEnv("us", { VERCEL_ENV: "production" }));
  await assert.rejects(buildRelease(box.ctx, "us", SHA), (error) => {
    assert.equal(error.code, "env_contract");
    assert.deepEqual(error.extra.problems, ["VERCEL_ENV: not allowed on the box"]);
    return true;
  });
  box.writeEnv("us");
  box.free = 4 * 1024 ** 3;
  await assert.rejects(buildRelease(box.ctx, "us", SHA), { code: "disk_low" });
  rmSync(box.layout.leagueEnv("us"));
  await assert.rejects(buildRelease(box.ctx, "us", SHA), { code: "env_missing" });
  assert.equal(box.calls.length, 0);
});

test("both units report their own cgroup as they stop, and the record takes the build's peak from it", async () => {
  const { box, dir } = buildBox();
  const result = await buildRelease(box.ctx, "us", SHA);
  const stopPost = `ExecStopPost=-/usr/bin/node ${box.layout.helper("cgroup-report.mjs")}`;
  for (const [pattern, command] of [[/systemd-run .* ci /, "/usr/bin/npm"], [/scripts\/vercel-build\.mjs/, "/usr/bin/node"]]) {
    const args = argsOf(box, pattern);
    const at = args.indexOf(stopPost);
    // A unit property ahead of the command; "-" keeps a failed report from failing the unit.
    assert.ok(at > 0 && args[at - 1] === "-p" && at < args.indexOf(command), pattern.source);
  }
  // Not systemd-run's "Memory peak: 2.4M", read before the build used anything.
  assert.equal(result.peakRssMb, 1240);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8")).peakRssMb, 1240);
  const log = readFileSync(box.layout.buildLog(ID), "utf8").split("\n");
  for (const [report, summary] of [
    [INSTALL_REPORT, "== npm ci memory peak 500 MB, swap peak 0 MB"],
    [BUILD_REPORT, "== build memory peak 1240 MB, swap peak 300 MB"],
  ]) {
    assert.ok(log.includes(report), "the unit's own line stays in the log");
    const at = log.findIndex((line) => line.startsWith(summary));
    // The agent's summary follows systemd-run's own, whatever that says.
    assert.ok(at > log.indexOf(report) && log[at - 1] === "Memory swap peak: 0B", summary);
    assert.ok(log[at].endsWith("read from the unit's cgroup as it stopped"), log[at]);
  }
});

test("a build with no cgroup report records no peak, never systemd-run's", async () => {
  const lines = [ENV_GATE_LINE, `${SCHEMA_GATE_LINE} in schema public.`, ...staleSummary()];
  const { box, dir } = buildBox({ buildLines: lines });
  assert.equal((await buildRelease(box.ctx, "us", SHA)).peakRssMb, null);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8")).peakRssMb, null);
  assert.ok(readFileSync(box.layout.buildLog(ID), "utf8").includes("== build memory peak unknown (no cgroup report)"));
});

test("a build the kernel killed keeps its cgroup's peak on the FAILED record", async () => {
  const killed = BUILD_REPORT.replace("memory.peak=1300234240", "memory.peak=1887436800").replace("events.oom_kill=0", "events.oom_kill=1");
  const summary = staleSummary({ result: "oom-kill", main: "code=killed/status=KILL" });
  const { box, dir } = buildBox({ buildLines: [ENV_GATE_LINE, killed, ...summary], buildCode: 1 });
  await assert.rejects(buildRelease(box.ctx, "us", SHA), { code: "build_failed" });
  const record = JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8"));
  assert.equal(record.state, "FAILED");
  assert.equal(record.peakRssMb, 1800);
  assert.ok(readFileSync(box.layout.buildLog(ID), "utf8").includes("== build memory peak 1800 MB, swap peak 300 MB"));
});

test("a link the build planted outside the release stops the lockdown before root uses it", async () => {
  for (const plant of [
    (dir) => symlinkSync("/etc/ggd2l", path.join(dir, ".next/static/chunks/leak")),
    (dir) => symlinkSync("../../../../../etc", path.join(dir, "node_modules/escape")),
    (dir) => {
      rmSync(path.join(dir, ".next/static"), { recursive: true, force: true });
      symlinkSync("/etc/ggd2l", path.join(dir, ".next/static"));
    },
  ]) {
    const { box } = buildBox({ plant });
    await assert.rejects(buildRelease(box.ctx, "us", SHA), (error) => error.code === "link_escapes");
    const commands = box.calls.map((call) => path.basename(call.command));
    assert.ok(!commands.includes("rsync"), "nothing is published");
    assert.ok(!box.calls.some((call) => call.args.includes("g+rX,g-w,o-rwx")), "no chmod follows the refusal");
  }
});

test("a link or file the build left where a league-writable folder goes is never handed to the league user", async () => {
  for (const plant of [
    // Inside the release, so the link check passes: the folder check must not.
    (dir) => {
      mkdirSync(path.join(dir, ".next/server"), { recursive: true });
      symlinkSync("../static", path.join(dir, ".next/server/route-cache"));
    },
    (dir) => symlinkSync("../node_modules", path.join(dir, ".next/server")),
    (dir) => {
      mkdirSync(path.join(dir, ".next"), { recursive: true });
      symlinkSync("../prisma", path.join(dir, ".next/cache"));
    },
    (dir) => {
      mkdirSync(path.join(dir, ".next/server"), { recursive: true });
      writeFileSync(path.join(dir, ".next/server/route-cache"), "x");
    },
  ]) {
    const { box, dir } = buildBox({ plant });
    await assert.rejects(buildRelease(box.ctx, "us", SHA), { code: "lockdown_failed" });
    const commands = box.calls.map((call) => [path.basename(call.command), ...call.args].join(" "));
    assert.ok(!commands.some((line) => line.startsWith("install -d -o ggd2l-us ")), "no folder is made the league user's");
    assert.ok(!commands.some((line) => line.startsWith("chown -R -P -h ggd2l-us:")), "nothing is re-owned");
    assert.ok(!commands.some((line) => line.startsWith("rsync ")), "nothing is published");
    assert.equal(JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8")).state, "FAILED");
  }
});
