import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LEAGUE_TARGETS } from "./league-targets.mjs";
import { BOX_TARGETS, RELEASE_ID, releaseIdMatches } from "./box-targets.mjs";
import {
  AGENT, AGENT_VERBS, DEFAULT_BOX_SSH, agentArgv, assertBoxRelease, boxSshAlias, createEvidenceDirectory,
  parseAgentOutput, releaseWindowOpen, runBoxRelease,
} from "./release-box.mjs";

const sha = "c".repeat(40);
const baseSha = "b".repeat(40);
const T0 = Date.parse("2026-10-16T15:00:00Z");
const SECRET = "fixture-secret-0123456789abcdef";
const baseId = (lg) => `${lg}-20261015T120000Z-${baseSha.slice(0, 12)}`;
const port = (lg, slot) => BOX_TARGETS.find((t) => t.region === lg).slots[slot];
const mutationShards = [1, 2, 3, 4].map((n) => `mutation guard ${n}/4`);
const ciJobs = ["classify release impact", "audit, lint, types, build, tests", "playwright e2e (us)", "playwright e2e (eu)",
  "integration on postgres", ...mutationShards].map((name) => ({ name, status: "completed", conclusion: "success" }));
const appLane = { lane: "app", needs_postgres: true, needs_mutation: true, needs_db_release: false, needs_scheduler_pause: false };

// A box and a Cloudflare edge in memory. `ssh` calls reach a fake agent that
// follows the §2.1 verbs; `fetchText` answers the public probes from whatever
// each league's live release is, unless the scenario pins the edge.
function world({ classification = appLane, agent: overrides = {}, edge = {}, logs = {}, now = T0 } = {}) {
  let clock = now;
  const ssh = [];
  const at = [];
  const other = [];
  const live = Object.fromEntries(["us", "eu"].map((lg) => [lg, { id: baseId(lg), sha: baseSha, slot: "a", port: port(lg, "a") }]));
  const releases = new Map(["us", "eu"].map((lg) => [baseId(lg), { region: lg, sha: baseSha, slot: "a" }]));
  const json = (value) => ({ status: 0, stdout: JSON.stringify(value) + "\n" });
  const verbs = {
    status: () => json({ caddyConfigSha256: "e".repeat(64) }),
    live: (lg) => json(live[lg]),
    deployment: (id) => json({ id, sha: releases.get(id).sha, region: releases.get(id).region, state: "BUILT", role: "candidate",
      node: "v22.23.3", buildLogSha256: "d".repeat(64), slot: releases.get(id).slot ?? null, port: null }),
    build: (lg, commit) => {
      const id = `${lg}-20261016T150000Z-${commit.slice(0, 12)}`;
      releases.set(id, { region: lg, sha: commit });
      return json({ id, buildSeconds: 216, peakRssMb: 1540 });
    },
    start: (lg, id) => {
      const slot = live[lg].slot === "a" ? "b" : "a";
      releases.get(id).slot = slot;
      return json({ slot, port: port(lg, slot) });
    },
    check: () => json({ ok: true, checks: ["live", "ready", "release"] }),
    promote: (lg, id) => {
      const previous = live[lg].id;
      const release = releases.get(id);
      live[lg] = { id, sha: release.sha, slot: release.slot, port: port(lg, release.slot) };
      return json({ id, previous });
    },
    retire: () => json({ ok: true }),
    prune: () => json({ removed: [] }),
    logs: (lg, since) => json(logs[lg]?.(Number(since)) ?? [
      { id: `${lg}-1`, timestamp: Number(since) + 20_000, responseStatusCode: 200, requestPath: "/api/cron/automation", level: "info" },
      { id: `${lg}-2`, timestamp: Number(since) + 25_000, responseStatusCode: 200, requestPath: "/api/inhouse", level: "info" },
      { id: `${lg}-3`, timestamp: Number(since) + 80_000, responseStatusCode: 200, requestPath: "/api/cron/automation", level: "info" },
    ]),
    "cron-requests": () => json({ count: 0 }),
    lease: () => json({ leaseOwner: null, leaseExpiresAt: null }),
  };
  const run = async (file, args) => {
    if (file === "ssh") {
      ssh.push(args);
      at.push(clock);
      const [verb, ...rest] = args.slice(args.indexOf(AGENT) + 1);
      return (overrides[verb] ?? verbs[verb])(...rest, verbs);
    }
    other.push([file, ...args]);
    if (file === "git") {
      if (args[0] === "rev-parse") return { status: 0, stdout: `${sha}\n` };
      if (args[0] === "show") return { status: 0, stdout: "// the live commit's classifier\n" };
      return { status: 0, stdout: "" };
    }
    if (file === "gh") {
      const endpoint = args[1];
      if (endpoint.includes("/workflows/ci.yml/runs?head_sha=")) return json({ workflow_runs: [{ id: 42, head_sha: sha }] });
      if (endpoint.endsWith("/runs/42")) return json({ id: 42, head_sha: sha, status: "completed", conclusion: "success", html_url: "https://github.com/runs/42" });
      if (endpoint.includes("/runs/42/jobs")) return json({ jobs: ciJobs });
      return { status: 1, stdout: "" };
    }
    if (file === process.execPath) return json(classification);
    return { status: 127, stdout: "" };
  };
  const fetchText = async (url) => {
    const { hostname, pathname } = new URL(url);
    const lg = hostname.split(".")[0];
    if (pathname === "/api/health/release") {
      const info = { ok: true, region: lg, commit: live[lg].sha, site: `https://${hostname}`, deployEnv: "production" };
      return JSON.stringify({ ...info, ...(edge[lg]?.(live[lg]) ?? {}) });
    }
    return JSON.stringify({ ok: true });
  };
  const verbsCalled = () => ssh.map((args) => args.slice(args.indexOf(AGENT) + 1).slice(0, 2).join(" "));
  return {
    ssh, at, other, live, verbsCalled, run, fetchText,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    advance: (ms) => { clock += ms; },
  };
}

async function release(box, argv = ["--apply"], env = {}) {
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), "ggd2l-release-box-test-"));
  const deps = { run: box.run, fetchText: box.fetchText, now: box.now, sleep: box.sleep, cwd: process.cwd(),
    env: { PATH: process.env.PATH, FIXTURE_SECRET: SECRET, ...env }, log: () => {}, evidenceRoot };
  try {
    const report = await runBoxRelease(argv, deps);
    return { report, evidence: report.evidence, files: (await readdir(report.evidence)).sort(), evidenceRoot };
  } catch (error) {
    return { error, evidenceRoot };
  }
}

// Every ssh argv: the transport, the alias, sudo -n, the agent, then one
// allowlisted verb and only regions, commits, release ids, epoch ms and the
// fixed --expect literal. No env value ever reaches argv.
function assertArgvContract(box, alias = DEFAULT_BOX_SSH) {
  assert.ok(box.ssh.length > 0);
  for (const args of box.ssh) {
    assert.deepEqual(args.slice(0, 8), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", alias, "sudo", "-n", AGENT]);
    const [verb, ...rest] = args.slice(8);
    assert.ok(Object.hasOwn(AGENT_VERBS, verb), verb);
    for (const arg of rest) assert.match(arg, /^(?:us|eu|[0-9a-f]{40}|(?:us|eu)-\d{8}T\d{6}Z-[0-9a-f]{12}|\d{13}|--expect|production)$/);
    assert.ok(!args.join(" ").includes(SECRET));
  }
}

test("box targets keep the generic gates' regions and order, with the box origins and slot ports", () => {
  assert.deepEqual(BOX_TARGETS.map((t) => t.region), LEAGUE_TARGETS.map((t) => t.region));
  assert.deepEqual(BOX_TARGETS.map((t) => t.origin), ["https://us.ggd2l.com", "https://eu.ggd2l.com"]);
  assert.deepEqual(BOX_TARGETS.map((t) => t.slots), [{ a: 3001, b: 3002 }, { a: 3011, b: 3012 }]);
  assert.ok(releaseIdMatches(BOX_TARGETS[0], `us-20261016T150000Z-${sha.slice(0, 12)}`, sha));
  assert.ok(!releaseIdMatches(BOX_TARGETS[1], `us-20261016T150000Z-${sha.slice(0, 12)}`, sha));
  assert.ok(!releaseIdMatches(BOX_TARGETS[0], `us-20261016T150000Z-${baseSha.slice(0, 12)}`, sha));
  assert.ok(!RELEASE_ID.test("us-20261016T150000Z-CCCCCCCCCCCC"));
});

test("agent argv carries only the verb, region, commit, release id and fixed literals", () => {
  assert.equal(boxSshAlias({}), "ggd2l-1");
  assert.equal(boxSshAlias({ GGD2L_BOX_SSH: "ggd2l@174.138.55.81" }), "ggd2l@174.138.55.81");
  for (const alias of ["-oProxyCommand=sh", "ggd2l-1 sudo", "host;id", "a\nb"])
    assert.throws(() => boxSshAlias({ GGD2L_BOX_SSH: alias }), /plain SSH host alias/);
  const id = `eu-20261016T150000Z-${sha.slice(0, 12)}`;
  assert.deepEqual(agentArgv("ggd2l-1", "check", ["eu", id, "--expect", "production"]),
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "ggd2l-1", "sudo", "-n", AGENT, "check", "eu", id, "--expect", "production"]);
  const refused = [
    ["build", ["us"]],
    ["build", ["us", sha, "extra"]],
    ["build", ["fr", sha]],
    ["build", ["us", sha.slice(0, 39)]],
    ["build", ["us", `${sha.slice(0, 39)};`]],
    ["start", ["us", id]], // an EU release on the US league
    ["start", ["us", "us-latest"]],
    ["check", ["eu", id, "--expect", "staging"]],
    ["logs", ["us", "17"]],
    ["logs", ["us", "1760000000000; reboot"]],
    ["mode", ["us", "proxy"]],
    ["import", ["us", "/tmp/dump"]],
    ["__proto__", []],
  ];
  for (const [verb, args] of refused) assert.throws(() => agentArgv("ggd2l-1", verb, args), /outside its contract|unknown box agent verb/, `${verb} ${args}`);
});

test("agent output is one strict JSON value, and errors never repeat it", () => {
  assert.deepEqual(parseAgentOutput("live", '{"id":"x"}\n'), { id: "x" });
  assert.deepEqual(parseAgentOutput("logs", "[]"), []);
  const malformed = [
    `Welcome ${SECRET}\n{"id":"x"}`,
    `{"id":"x"}\n{"id":"${SECRET}"}`,
    `{"id":"x"} ${SECRET}`,
    "",
    "null",
    '"text"',
    "[]",
  ];
  for (const stdout of malformed) {
    assert.throws(() => parseAgentOutput("live", stdout), (error) => {
      assert.match(error.message, /^box agent live returned output outside its JSON contract$/);
      return true;
    });
  }
  assert.throws(() => parseAgentOutput("logs", '{"rows":[]}'), /outside its JSON contract/);
  // A refusal names the agent's fixed code, and only a code of that shape.
  assert.throws(() => parseAgentOutput("promote", '{"ok":false,"code":"caddy-validate"}', 1), /^Error: box agent promote refused \(caddy-validate\)$/);
  for (const code of [`postgresql://app:${SECRET}@127.0.0.1/db`, "Has Spaces", 7])
    assert.throws(() => parseAgentOutput("build", JSON.stringify({ ok: false, code })), (error) => {
      assert.equal(error.message, "box agent build refused");
      return true;
    });
  // A nonzero exit fails even with an object on stdout, without quoting it.
  assert.throws(() => parseAgentOutput("start", JSON.stringify({ slot: SECRET }), 3), (error) => {
    assert.equal(error.message, "box agent start failed (exit 3)");
    return true;
  });
  assert.throws(() => parseAgentOutput("start", SECRET, null), /^Error: box agent start failed \(no exit status\)$/);
});

test("the public probe must report the box origin and the production marker", () => {
  const [us] = BOX_TARGETS;
  const info = { ok: true, region: "us", commit: sha, site: "https://us.ggd2l.com", deployEnv: "production" };
  assertBoxRelease(us, info, sha);
  assert.throws(() => assertBoxRelease(us, { ...info, commit: baseSha }, sha), /reviewed shared version/);
  assert.throws(() => assertBoxRelease(us, { ...info, site: "https://ggd2l.vercel.app" }, sha), /canonical origin/);
  assert.throws(() => assertBoxRelease(us, { ...info, deployEnv: "staging" }, sha), /production deploy marker/);
  assert.throws(() => assertBoxRelease(us, { ...info, deployEnv: null }, sha), /production deploy marker/);
});

test("the release window is 07:00-19:00 UTC, and evidence directories never overwrite one another", async () => {
  assert.equal(releaseWindowOpen(Date.parse("2026-10-16T06:59:59Z")), false);
  assert.equal(releaseWindowOpen(Date.parse("2026-10-16T07:00:00Z")), true);
  assert.equal(releaseWindowOpen(Date.parse("2026-10-16T18:59:59Z")), true);
  assert.equal(releaseWindowOpen(Date.parse("2026-10-16T19:00:00Z")), false);
  const root = await mkdtemp(path.join(tmpdir(), "ggd2l-release-box-evidence-"));
  try {
    assert.equal(path.basename(await createEvidenceDirectory(root, T0)), "release-2026-10-16");
    assert.equal(path.basename(await createEvidenceDirectory(root, T0)), "release-2026-10-16b");
    assert.equal(path.basename(await createEvidenceDirectory(root, T0)), "release-2026-10-16c");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan reads the box and the edge, classifies from the live commit, checks CI and changes nothing", async () => {
  const box = world();
  const { report, files, evidenceRoot } = await release(box, ["--check"]);
  try {
    assert.equal(report.status, "planned");
    assert.deepEqual(box.verbsCalled(), ["live us", "live eu"]);
    assertArgvContract(box);
    // The trusted classifier is the live commit's, run base..head.
    assert.ok(box.other.some((call) => call.join(" ") === `git show ${baseSha}:scripts/classify-release.mjs`));
    assert.ok(box.other.some((call) => call[0] === process.execPath && call.slice(2).join(" ") === `--base ${baseSha} --head ${sha} --format json`));
    assert.equal(report.ci.id, 42);
    assert.deepEqual(files, ["plan.json", "record.md", "shared-release.json"]);
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test("a plan refuses a box whose public edge does not serve its live release", async () => {
  for (const edge of [{ eu: () => ({ commit: sha }) }, { us: () => ({ site: "https://ggd2l.vercel.app" }) }, { us: () => ({ deployEnv: "staging" }) }]) {
    const box = world({ edge });
    const { error, evidenceRoot } = await release(box, ["--check"]);
    await rm(evidenceRoot, { recursive: true, force: true });
    assert.ok(error, JSON.stringify(Object.keys(edge)));
    assert.ok(!box.verbsCalled().some((verb) => !verb.startsWith("live")));
  }
});

test("a release builds both leagues before starting either, checks, promotes US then Europe, and finalizes", async () => {
  const box = world();
  const { report, files, evidence, evidenceRoot } = await release(box);
  try {
    assert.equal(report.status, "verified");
    const usId = `us-20261016T150000Z-${sha.slice(0, 12)}`;
    const euId = `eu-20261016T150000Z-${sha.slice(0, 12)}`;
    const calls = box.verbsCalled().filter((call) => !call.startsWith("live"));
    assert.deepEqual(calls, [
      `build us`, `deployment ${usId}`, `build eu`, `deployment ${euId}`,
      `start us`, `check us`, `start eu`, `check eu`,
      `promote us`, `promote eu`,
      `logs us`, `logs eu`,
      `retire us`, `retire eu`, `prune us`, `prune eu`, `status`,
    ]);
    // Retire names the old ids, after the 90 s warm window.
    const retires = box.ssh.filter((args) => args.includes("retire")).map((args) => args.at(-1));
    assert.deepEqual(retires, [baseId("us"), baseId("eu")]);
    const when = (verb) => box.ssh.map((args, i) => (args.includes(verb) ? box.at[i] : null)).filter((t) => t !== null);
    assert.ok(Math.min(...when("retire")) - Math.max(...when("promote")) >= 90_000, "old slots stay warm for 90 s");
    assert.deepEqual(box.live.us, { id: usId, sha, slot: "b", port: 3002 });
    assert.deepEqual(box.live.eu, { id: euId, sha, slot: "b", port: 3012 });
    assert.deepEqual(report.events.filter((e) => e.action === "promoted").map((e) => e.region), ["us", "eu"]);
    assert.equal(report.events.filter((e) => e.action === "scheduled-passes-verified").length, 2);
    assert.deepEqual(report.cleanupProblems, []);
    assertArgvContract(box);
    assert.deepEqual(files, ["box-manifest.json", "plan.json", "record.md", "shared-release.json"]);
    const manifest = JSON.parse(await readFile(path.join(evidence, "box-manifest.json"), "utf8"));
    assert.equal(manifest.caddyConfigSha256, "e".repeat(64));
    assert.deepEqual(Object.keys(manifest.regions), ["us", "eu"]);
    assert.equal(manifest.regions.eu.candidate.buildLogSha256, "d".repeat(64));
    assert.equal(manifest.regions.eu.candidate.node, "v22.23.3");
    const recordMd = await readFile(path.join(evidence, "record.md"), "utf8");
    assert.match(recordMd, new RegExp(`\\| us \\| app \\| ${baseId("us")} \\| ${usId} \\| 216 \\| 1540 \\|`));
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test("the SSH alias comes from GGD2L_BOX_SSH", async () => {
  const box = world();
  const { report, evidenceRoot } = await release(box, ["--check"], { GGD2L_BOX_SSH: "ggd2l-staging-alias" });
  await rm(evidenceRoot, { recursive: true, force: true });
  assert.equal(report.box, "ggd2l-staging-alias");
  assertArgvContract(box, "ggd2l-staging-alias");
});

test("a canonical failure on the US restores it and never touches Europe", async () => {
  // Cloudflare keeps answering with the previous commit after the swap.
  const box = world({ edge: { us: (live) => (live.sha === sha ? { commit: baseSha } : {}) } });
  const { error, evidenceRoot } = await release(box);
  await rm(evidenceRoot, { recursive: true, force: true });
  assert.match(error.message, /^Paired promotion failed\. us: previous deployment restored$/);
  const promotes = box.ssh.filter((args) => args.includes("promote")).map((args) => args.slice(-2).join(" "));
  assert.deepEqual(promotes, [`us us-20261016T150000Z-${sha.slice(0, 12)}`, `us ${baseId("us")}`]);
  assert.equal(box.live.us.id, baseId("us"));
  assert.equal(box.live.eu.id, baseId("eu"));
  // Both idle candidates are stopped once the warm window has passed.
  assert.deepEqual(box.ssh.filter((args) => args.includes("retire")).map((args) => args.at(-1)),
    [`us-20261016T150000Z-${sha.slice(0, 12)}`, `eu-20261016T150000Z-${sha.slice(0, 12)}`]);
  assertArgvContract(box);
});

test("a failure after both promotions rolls back both leagues, Europe first", async () => {
  for (const scenario of [
    { edge: { eu: (live) => (live.sha === sha ? { deployEnv: "staging" } : {}) } },
    // A 5xx on the Europe host after its promotion fails the finalize gate.
    { logs: { eu: (since) => [
      { id: "1", timestamp: since + 20_000, responseStatusCode: 200, requestPath: "/api/cron/automation", level: "info" },
      { id: "2", timestamp: since + 50_000, responseStatusCode: 502, requestPath: "/schedule", level: "error" },
      { id: "3", timestamp: since + 80_000, responseStatusCode: 200, requestPath: "/api/cron/automation", level: "info" },
    ] } },
  ]) {
    const box = world(scenario);
    const { error, evidenceRoot } = await release(box);
    const saved = JSON.parse(await readFile(path.join(evidenceRoot, (await readdir(evidenceRoot))[0], "shared-release.json"), "utf8"));
    await rm(evidenceRoot, { recursive: true, force: true });
    assert.match(error.message, /^Paired promotion failed\. eu: previous deployment restored; us: previous deployment restored$/);
    const promotes = box.ssh.filter((args) => args.includes("promote")).map((args) => args.slice(-2).join(" "));
    assert.deepEqual(promotes, [
      `us us-20261016T150000Z-${sha.slice(0, 12)}`, `eu eu-20261016T150000Z-${sha.slice(0, 12)}`,
      `eu ${baseId("eu")}`, `us ${baseId("us")}`,
    ]);
    assert.equal(box.live.us.id, baseId("us"));
    assert.equal(box.live.eu.id, baseId("eu"));
    assert.equal(saved.status, "failed");
    assert.deepEqual(saved.events.filter((e) => e.action === "recovery").map((e) => e.message),
      ["eu: previous deployment restored", "us: previous deployment restored"]);
    assertArgvContract(box);
  }
});

test("a failed build or smoke check changes neither live slot", async () => {
  const failedBuild = world({ agent: { build: (lg, commit, verbs) => (lg === "eu" ? { status: 1, stdout: `{"ok":false,"code":"build-failed"}` } : verbs.build(lg, commit)) } });
  const built = await release(failedBuild);
  await rm(built.evidenceRoot, { recursive: true, force: true });
  assert.equal(built.error.message, "box agent build refused (build-failed)");
  assert.ok(!failedBuild.verbsCalled().some((call) => /^(start|promote|retire)/.test(call)));

  const failedCheck = world({ agent: { check: (lg) => ({ status: 0, stdout: JSON.stringify({ ok: lg === "eu" ? undefined : true, checks: [] }) }) } });
  const checked = await release(failedCheck);
  await rm(checked.evidenceRoot, { recursive: true, force: true });
  assert.equal(checked.error.message, "eu: the candidate failed the box smoke check");
  assert.ok(!failedCheck.verbsCalled().some((call) => call.startsWith("promote")));
  assert.deepEqual(failedCheck.ssh.filter((args) => args.includes("retire")).map((args) => args.at(-1)),
    [`us-20261016T150000Z-${sha.slice(0, 12)}`, `eu-20261016T150000Z-${sha.slice(0, 12)}`]);
  assert.equal(failedCheck.live.us.id, baseId("us"));
});

test("the box must build the reviewed commit and start it beside the live slot", async () => {
  for (const [id, region] of [[`us-20261016T150000Z-${baseSha.slice(0, 12)}`, "us"], [`eu-20261016T150000Z-${sha.slice(0, 12)}`, "us"]]) {
    const box = world({ agent: { build: (lg, commit, verbs) => (lg === region ? { status: 0, stdout: JSON.stringify({ id, buildSeconds: 1 }) } : verbs.build(lg, commit)) } });
    const { error, evidenceRoot } = await release(box);
    await rm(evidenceRoot, { recursive: true, force: true });
    assert.equal(error.message, "us: the box built a release outside the reviewed commit");
    assert.ok(!box.verbsCalled().some((call) => /^(build eu|start|promote)/.test(call)));
  }
  // A candidate started in the live slot would already have replaced it.
  const box = world({ agent: { start: (lg) => ({ status: 0, stdout: JSON.stringify({ slot: "a", port: port(lg, "a") }) }) } });
  const { error, evidenceRoot } = await release(box);
  await rm(evidenceRoot, { recursive: true, force: true });
  assert.equal(error.message, "us: the candidate did not start in the idle slot");
  assert.ok(!box.verbsCalled().some((call) => /^(check|promote)/.test(call)));
});

test("command output never reaches an error, the evidence or the console", async () => {
  const box = world({ agent: { build: () => ({ status: 0, stdout: `npm ERR! DATABASE_URL=postgresql://app:${SECRET}@127.0.0.1\n` }) } });
  const { error, evidenceRoot } = await release(box);
  const directory = path.join(evidenceRoot, (await readdir(evidenceRoot))[0]);
  const written = await Promise.all((await readdir(directory)).map((file) => readFile(path.join(directory, file), "utf8")));
  await rm(evidenceRoot, { recursive: true, force: true });
  assert.equal(error.message, "box agent build returned output outside its JSON contract");
  for (const text of written) assert.ok(!text.includes(SECRET));

  const gh = world();
  const run = gh.run;
  gh.run = async (file, args, options) => file === "gh" ? { status: 1, stdout: `token ${SECRET}` } : run(file, args, options);
  const failed = await release(gh, ["--check"]);
  await rm(failed.evidenceRoot, { recursive: true, force: true });
  assert.equal(failed.error.message, "gh api failed");
  gh.run = async (file, args, options) => file === "gh" ? { status: 0, stdout: `not json ${SECRET}` } : run(file, args, options);
  const garbled = await release(gh, ["--check"]);
  await rm(garbled.evidenceRoot, { recursive: true, force: true });
  assert.equal(garbled.error.message, "gh api did not return JSON");
});

test("maintenance lanes need reviewed evidence and the agent's quiet-window and lease proof", async () => {
  const pause = { ...appLane, lane: "strict", needs_scheduler_pause: true };
  const noFile = world({ classification: pause });
  const refused = await release(noFile);
  await rm(refused.evidenceRoot, { recursive: true, force: true });
  assert.match(refused.error.message, /reviewed maintenance evidence/);
  assert.ok(!noFile.verbsCalled().some((call) => call.startsWith("build")));

  const dir = await mkdtemp(path.join(tmpdir(), "ggd2l-release-box-maintenance-"));
  const file = path.join(dir, "maintenance.json");
  const region = { baseSha, reviewedBy: "Tim", observedAt: new Date(T0 - 60_000).toISOString(), zeroTriggers: true,
    quietSlotsVerified: true, noActiveLease: true, zeroTriggersAt: new Date(T0 - 20 * 60_000).toISOString() };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, JSON.stringify({ headSha: sha, regions: { us: region, eu: region } }));
  try {
    const busy = world({ classification: pause, agent: { "cron-requests": () => ({ status: 0, stdout: '{"count":1}' }) } });
    const loud = await release(busy, ["--apply", "--maintenance-file", file]);
    await rm(loud.evidenceRoot, { recursive: true, force: true });
    assert.equal(loud.error.message, "us: the paused scheduler still reached the site");
    assert.ok(!busy.verbsCalled().some((call) => call.startsWith("build")));

    const leased = world({ classification: pause, agent: { lease: () => ({ status: 0, stdout: '{"leaseOwner":"set","leaseExpiresAt":"set"}' }) } });
    const held = await release(leased, ["--apply", "--maintenance-file", file]);
    await rm(held.evidenceRoot, { recursive: true, force: true });
    assert.equal(held.error.message, "us: an automation lease is still held");

    // With the proof, the release promotes and skips the scheduler gates.
    const quiet = world({ classification: pause });
    const { report, evidenceRoot } = await release(quiet, ["--apply", "--maintenance-file", file]);
    await rm(evidenceRoot, { recursive: true, force: true });
    assert.equal(report.status, "promoted-awaiting-scheduler-resume");
    assert.ok(!quiet.verbsCalled().some((call) => call.startsWith("logs")));
    const since = quiet.ssh.find((args) => args.includes("cron-requests")).at(-1);
    assert.equal(Number(since), T0 - 120_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a release outside 07:00-19:00 UTC is refused unless reviewed as an emergency", async () => {
  const late = world({ now: Date.parse("2026-10-16T20:00:00Z") });
  const refused = await release(late);
  await rm(refused.evidenceRoot, { recursive: true, force: true });
  assert.match(refused.error.message, /07:00-19:00 UTC/);
  assert.ok(!late.verbsCalled().some((call) => call.startsWith("build")));
  const emergency = world({ now: Date.parse("2026-10-16T20:00:00Z") });
  const allowed = await release(emergency, ["--apply", "--outside-window"]);
  await rm(allowed.evidenceRoot, { recursive: true, force: true });
  assert.equal(allowed.report.status, "verified");
});

test("a league already at the commit is neither rebuilt nor restarted", async () => {
  const box = world();
  box.live.us = { id: `us-20261016T090000Z-${sha.slice(0, 12)}`, sha, slot: "b", port: 3002 };
  const { report, evidenceRoot } = await release(box);
  await rm(evidenceRoot, { recursive: true, force: true });
  assert.equal(report.status, "verified");
  assert.equal(report.classifications.us.lane, "unchanged");
  assert.ok(!box.verbsCalled().some((call) => / us$/.test(call) && !call.startsWith("live")));
  // Both current: nothing to build, CI is not consulted.
  const current = world();
  current.live.us = { id: `us-20261016T090000Z-${sha.slice(0, 12)}`, sha, slot: "b", port: 3002 };
  current.live.eu = { id: `eu-20261016T090000Z-${sha.slice(0, 12)}`, sha, slot: "b", port: 3012 };
  const done = await release(current);
  await rm(done.evidenceRoot, { recursive: true, force: true });
  assert.equal(done.report.status, "already-current");
  assert.deepEqual(current.verbsCalled(), ["live us", "live eu"]);
  assert.ok(!current.other.some((call) => call[0] === "gh"));
});

test("release:both runs release-box, and test:release runs its tests with the agent's and the smoke's", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(scripts["release:both"], "node scripts/release-box.mjs");
  const tested = scripts["test:release"].split(/\s+/);
  for (const file of ["scripts/shared-release.test.mjs", "scripts/release-box.test.mjs", "ops/selfhost/agent/*.test.mjs", "ops/selfhost/smoke/*.test.mjs"])
    assert.ok(tested.includes(file), file);
});
