import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AUTOLOADED_DOTENV_RE, BUILD_NODE_OPTIONS, ENV_GATE_LINE, REQUIRED_ARTIFACTS, SCHEMA_GATE_LINE, buildRelease, parseMemoryPeak } from "./build.mjs";
import { SHA, T0, TRACKED_DOTENV_EXAMPLES, leagueEnv, makeBox } from "./harness.test.mjs";
import { describeRelease } from "./releases.mjs";

const ID = "us-20261016T150000Z-0123456789ab";

/** A box whose git, npm and build behave like the real ones, as files. */
function buildBox({ buildLines, artifacts = REQUIRED_ARTIFACTS, onMain = true, dotenv = null } = {}) {
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
    "Memory peak: 1.5G",
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
      return { lines };
    }
    if (command.endsWith("/systemd-run") && args.includes("ci")) return { lines: [`npm: cache ${box.layout.npmCache}`] };
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
  assert.equal(result.peakRssMb, 1536);

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
  assert.ok(commands.includes(`chown -R root:ggd2l-us ${dir}`));
  assert.ok(commands.includes(`chmod -R g-w,o-rwx ${dir}`));
  assert.ok(commands.includes(`install -d -o ggd2l-us -g ggd2l-us -m 0700 ${dir}/.next/cache`));
  assert.ok(commands.includes(`rsync -a --no-owner --no-group --chmod=D0755,F0644 ${dir}/.next/static/ ${box.layout.staticDir("us")}/`));
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

test("systemd's memory summary parses to MB", () => {
  assert.equal(parseMemoryPeak("Memory peak: 1.5G"), 1536);
  assert.equal(parseMemoryPeak("Memory peak: 812.4M"), 812);
  assert.equal(parseMemoryPeak("nothing here"), null);
});
