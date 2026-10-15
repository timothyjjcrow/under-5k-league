import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const usId = `us-20261016T150000Z-${sha.slice(0, 12)}`;
const euId = `eu-20261016T150000Z-${sha.slice(0, 12)}`;
const port = (lg, slot) => BOX_TARGETS.find((t) => t.region === lg).slots[slot];
const mutationShards = [1, 2, 3, 4].map((n) => `mutation guard ${n}/4`);
const ciJobs = ["classify release impact", "audit, lint, types, build, tests", "playwright e2e (us)", "playwright e2e (eu)",
  "integration on postgres", ...mutationShards].map((name) => ({ name, status: "completed", conclusion: "success" }));
const appLane = { lane: "app", needs_postgres: true, needs_mutation: true, needs_db_release: false, needs_scheduler_pause: false };
const pauseLane = { ...appLane, lane: "strict", needs_scheduler_pause: true };
const json = (value) => ({ status: 0, stdout: JSON.stringify(value) + "\n" });
const refusal = (code) => ({ status: 1, stdout: JSON.stringify({ ok: false, code }) + "\n" });
const lost = () => ({ status: 255, stdout: "" });
/** An agent answer with some fields replaced. */
const answer = (result, patch) => json({ ...JSON.parse(result.stdout), ...patch });

// A box and a Cloudflare edge in memory. `ssh` calls reach a fake agent whose
// answers and state follow the real one (ops/selfhost/agent: status.mjs and
// releases.mjs's describeRelease, startRelease, promoteRelease, retireRelease
// and pruneLeague): slot symlinks, the units that run, and each league's last
// promote, within 90 s of which `retire` is refused. `fetchText` answers the
// public probes from whatever each league's live release is, unless the
// scenario pins the edge or a health route.
function world({
  classification = appLane, agent: overrides = {}, edge = {}, health = {}, logs = {}, modes = {}, git = {}, now = T0,
} = {}) {
  let clock = now;
  const ssh = [];
  const at = [];
  const other = [];
  // After each agent call: the call and how many Next units then run.
  const timeline = [];
  const live = Object.fromEntries(["us", "eu"].map((lg) => [lg, { id: baseId(lg), sha: baseSha, slot: "a", port: port(lg, "a") }]));
  const releases = new Map(["us", "eu"].map((lg) => [baseId(lg), { region: lg, sha: baseSha, state: "READY", role: "live" }]));
  const links = { "us:a": baseId("us"), "eu:a": baseId("eu") };
  const running = new Set(["us:a", "eu:a"]);
  const promotedAt = {};
  const idle = (lg) => (live[lg].slot === "a" ? "b" : "a");
  const linked = (lg, id) => ["a", "b"].filter((slot) => links[`${lg}:${slot}`] === id);
  const verbs = {
    status: () => json({
      ok: true, units: {}, disk: null, memory: null, pendingReboot: false, failedUnits: [], serverErrors24h: 0,
      leagues: Object.fromEntries(["us", "eu"].map((lg) => [lg, {
        live: { id: live[lg].id, sha: live[lg].sha, slot: live[lg].slot, promotedAt: null }, previous: null,
        mode: Object.hasOwn(modes, lg) ? modes[lg] : "proxy",
        slots: { a: links[`${lg}:a`] ?? null, b: links[`${lg}:b`] ?? null }, lastBackupAt: null, lastDrill: null,
      }])),
    }),
    live: (lg) => json(live[lg]),
    deployment: (id) => {
      const release = releases.get(id);
      const lg = id.slice(0, 2);
      const slots = linked(lg, id);
      const slot = slots.includes(live[lg].slot) ? live[lg].slot : (slots[0] ?? null);
      return json({ id, sha: release.sha, region: release.region, state: release.state, role: release.role, node: "v22.23.3",
        slot, port: slot ? port(lg, slot) : null });
    },
    build: (lg, commit) => {
      const id = `${lg}-20261016T150000Z-${commit.slice(0, 12)}`;
      releases.set(id, { region: lg, sha: commit, state: "BUILT", role: "candidate" });
      return json({ id, buildSeconds: 216, peakRssMb: 1540 });
    },
    start: (lg, id) => {
      const slot = idle(lg);
      links[`${lg}:${slot}`] = id;
      running.add(`${lg}:${slot}`);
      releases.get(id).state = "READY";
      return json({ slot, port: port(lg, slot) });
    },
    check: () => json({ ok: true, checks: [{ name: "release", ok: true }] }),
    // The target slot is restarted clean, then Caddy swaps to it.
    promote: (lg, id) => {
      const spare = idle(lg);
      const slot = links[`${lg}:${spare}`] === id ? spare : links[`${lg}:${live[lg].slot}`] === id ? live[lg].slot : spare;
      links[`${lg}:${slot}`] = id;
      running.add(`${lg}:${slot}`);
      const previous = live[lg].id;
      live[lg] = { id, sha: releases.get(id).sha, slot, port: port(lg, slot) };
      promotedAt[lg] = clock;
      return json({ id, previous });
    },
    retire: (lg, id) => {
      if (live[lg].id === id) return refusal("is_live");
      if (promotedAt[lg] !== undefined && clock - promotedAt[lg] < 90_000) return refusal("too_soon");
      const slots = linked(lg, id).filter((slot) => slot !== live[lg].slot);
      for (const slot of slots) running.delete(`${lg}:${slot}`);
      return json({ ok: true, slots });
    },
    prune: (lg) => json({ removed: { releases: [`${lg}-20261001T120000Z-${"a".repeat(12)}`], tools: [], staticFiles: 0 } }),
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
      const result = await (overrides[verb] ?? verbs[verb])(...rest, verbs);
      timeline.push({ call: [verb, ...rest.slice(0, 1)].join(" "), running: running.size });
      return result;
    }
    other.push([file, ...args]);
    if (file === "git") {
      if (Object.hasOwn(git, args[0])) return git[args[0]](args);
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
    return JSON.stringify(health[lg]?.(pathname.split("/").at(-1), live[lg]) ?? { ok: true });
  };
  const verbsCalled = () => ssh.map((args) => args.slice(args.indexOf(AGENT) + 1).slice(0, 2).join(" "));
  // Each agent call as [verb, ...args] with the fake clock when it was made.
  const calls = () => ssh.map((args, i) => ({ args: args.slice(args.indexOf(AGENT) + 1), at: at[i] }));
  return {
    ssh, at, other, live, running, timeline, verbsCalled, calls, run, fetchText,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    advance: (ms) => { clock += ms; },
  };
}

async function release(box, argv = ["--apply"], env = {}) {
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), "ggd2l-release-box-test-"));
  const logged = [];
  const deps = { run: box.run, fetchText: box.fetchText, now: box.now, sleep: box.sleep, cwd: process.cwd(),
    env: { PATH: process.env.PATH, FIXTURE_SECRET: SECRET, ...env }, log: (line) => logged.push(line), evidenceRoot };
  try {
    const report = await runBoxRelease(argv, deps);
    return { report, logged, evidence: report.evidence, files: (await readdir(report.evidence)).sort(), evidenceRoot };
  } catch (error) {
    // What the failed run saved, when it got far enough to save anything.
    let saved = null;
    try {
      const [directory] = await readdir(evidenceRoot);
      saved = JSON.parse(await readFile(path.join(evidenceRoot, directory, "shared-release.json"), "utf8"));
    } catch {
      // Refused before the first save.
    }
    return { error, saved, logged, evidenceRoot };
  }
}

/** A release whose evidence is removed once its report is read. */
async function released(box, argv, env) {
  const result = await release(box, argv, env);
  await rm(result.evidenceRoot, { recursive: true, force: true });
  return result;
}

/** The agent's promote calls as "<lg> <id>". */
const promotes = (box) => box.calls().filter((call) => call.args[0] === "promote").map((call) => call.args.slice(1).join(" "));
/** The ids the agent was asked to retire, in order. */
const retired = (box) => box.calls().filter((call) => call.args[0] === "retire").map((call) => call.args[2]);
/** The Next units still running: only the two live slots once a release has settled. */
const runningUnits = (box) => [...box.running].sort();

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
  const { report, files, logged, evidenceRoot } = await release(box, ["--check"]);
  try {
    assert.equal(report.status, "planned");
    assert.deepEqual(box.verbsCalled(), ["live us", "live eu", "status"]);
    assertArgvContract(box);
    // The trusted classifier is the live commit's, run base..head.
    assert.ok(box.other.some((call) => call.join(" ") === `git show ${baseSha}:scripts/classify-release.mjs`));
    assert.ok(box.other.some((call) => call[0] === process.execPath && call.slice(2).join(" ") === `--base ${baseSha} --head ${sha} --format json`));
    assert.equal(report.ci.id, 42);
    assert.deepEqual(files, ["plan.json", "record.md", "shared-release.json"]);
    assert.deepEqual(report.events.map((event) => event.action), ["proxy-mode-verified"]);
    // A plan says how to release, since nothing on the box changed.
    assert.ok(logged.some((line) => line.includes("npm run release:both -- --apply")));
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

test("a plan refuses a live pointer outside the agent's contract", async () => {
  for (const pointer of [
    { port: 3002 }, // slot a on slot b's port
    { slot: "c" },
    { slot: undefined, port: undefined }, // neither named, so the port comparison alone would match
    { id: baseId("eu") }, // another league's release
    { id: `us-20261015T120000Z-${"a".repeat(12)}` }, // another commit's release
    { sha: baseSha.slice(0, 12) }, // not a full commit, though the id ends with it
  ]) {
    const box = world();
    Object.assign(box.live.us, pointer);
    const { error } = await released(box, ["--check"]);
    assert.equal(error?.message, "us: the box's live pointer is outside its contract", JSON.stringify(pointer));
    assert.deepEqual(box.verbsCalled(), ["live us"]);
    assert.ok(!box.other.some((call) => call[1] === "show"), "no classifier is read for an unverified commit");
  }
});

test("a release builds both leagues before starting either, checks, promotes US then Europe, and finalizes", async () => {
  const box = world();
  const { report, files, evidence, evidenceRoot } = await release(box);
  try {
    assert.equal(report.status, "verified");
    const calls = box.verbsCalled().filter((call) => !call.startsWith("live"));
    assert.deepEqual(calls, [
      "status",
      `build us`, `deployment ${usId}`, `build eu`, `deployment ${euId}`,
      `start us`, `check us`, `retire us`, `start eu`, `check eu`, `retire eu`, "status",
      `promote us`, `promote eu`,
      `logs us`, `logs eu`,
      `retire us`, `retire eu`, `prune us`, `prune eu`, `status`,
    ]);
    // Each checked candidate stops before the next league's starts; the old
    // releases retire after the 90 s warm window.
    assert.deepEqual(retired(box), [usId, euId, baseId("us"), baseId("eu")]);
    const when = (verb, ids) => box.calls().filter((call) => call.args[0] === verb && (!ids || ids.includes(call.args[2]))).map((call) => call.at);
    assert.ok(Math.min(...when("retire", [baseId("us"), baseId("eu")])) - Math.max(...when("promote")) >= 90_000, "old slots stay warm for 90 s");
    assert.deepEqual(box.live.us, { id: usId, sha, slot: "b", port: 3002 });
    assert.deepEqual(box.live.eu, { id: euId, sha, slot: "b", port: 3012 });
    assert.deepEqual(runningUnits(box), ["eu:b", "us:b"]);
    assert.deepEqual(report.events.filter((e) => e.action === "promoted").map((e) => e.region), ["us", "eu"]);
    assert.equal(report.events.filter((e) => e.action === "scheduled-passes-verified").length, 2);
    // pruneLeague reports {removed: {releases, tools, staticFiles}}.
    assert.deepEqual(report.events.filter((e) => e.action === "pruned").map((e) => e.message), ["1 old release removed", "1 old release removed"]);
    assert.deepEqual(report.cleanupProblems, []);
    assertArgvContract(box);
    assert.deepEqual(files, ["box-manifest.json", "plan.json", "record.md", "shared-release.json"]);
    const manifest = JSON.parse(await readFile(path.join(evidence, "box-manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.regions), ["us", "eu"]);
    assert.equal(manifest.regions.eu.candidate.node, "v22.23.3");
    // The agent's deployment and status answers carry no build-log or Caddy
    // hash, so the manifest records none rather than inventing one.
    assert.equal(manifest.regions.eu.candidate.buildLogSha256, null);
    assert.equal(manifest.caddyConfigSha256, null);
    const recordMd = await readFile(path.join(evidence, "record.md"), "utf8");
    assert.match(recordMd, new RegExp(`\\| us \\| app \\| ${baseId("us")} \\| ${usId} \\| 216 \\| 1540 \\|`));
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test("at most three Next processes run until the promotions; the warm old slots make four only after the Europe promote", async () => {
  const box = world();
  const { report } = await released(box);
  assert.equal(report.status, "verified");
  const index = (call, from = 0) => box.timeline.findIndex((entry, i) => i >= from && entry.call === call);
  const promoteEu = index("promote eu");
  // Two live slots plus one candidate at a time, through the US promote.
  assert.equal(Math.max(...box.timeline.slice(0, promoteEu).map((entry) => entry.running)), 3);
  // Then both previous slots stay warm until they retire.
  const retireOld = index("retire us", promoteEu);
  assert.deepEqual([...new Set(box.timeline.slice(promoteEu, retireOld).map((entry) => entry.running))], [4]);
  assert.equal(box.timeline.at(-1).running, 2);
});

test("the manifest records the build-log and Caddy hashes once the agent reports them", async () => {
  const box = world({ agent: {
    deployment: (id, verbs) => answer(verbs.deployment(id), { buildLogSha256: id.startsWith("us-") ? "d".repeat(64) : "not a hash" }),
    status: (verbs) => answer(verbs.status(), { caddyConfigSha256: "e".repeat(64) }),
  } });
  const { report, evidence, evidenceRoot } = await release(box);
  try {
    assert.equal(report.status, "verified");
    const manifest = JSON.parse(await readFile(path.join(evidence, "box-manifest.json"), "utf8"));
    assert.equal(manifest.caddyConfigSha256, "e".repeat(64));
    assert.equal(manifest.regions.us.candidate.buildLogSha256, "d".repeat(64));
    assert.equal(manifest.regions.eu.candidate.buildLogSha256, null);
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
  const garbled = world({ agent: { status: (verbs) => answer(verbs.status(), { caddyConfigSha256: `${"e".repeat(63)}\n` }) } });
  const second = await release(garbled);
  try {
    const manifest = JSON.parse(await readFile(path.join(second.evidence, "box-manifest.json"), "utf8"));
    assert.equal(manifest.caddyConfigSha256, null);
  } finally {
    await rm(second.evidenceRoot, { recursive: true, force: true });
  }
});

test("the SSH alias comes from GGD2L_BOX_SSH", async () => {
  const box = world();
  const { report } = await released(box, ["--check"], { GGD2L_BOX_SSH: "ggd2l-staging-alias" });
  assert.equal(report.box, "ggd2l-staging-alias");
  assertArgvContract(box, "ggd2l-staging-alias");
});

test("release-box runs only from a clean operator checkout of a commit on origin/main", async () => {
  const actions = world();
  const inCi = await released(actions, ["--check"], { GITHUB_ACTIONS: "true" });
  assert.equal(inCi.error?.message, "release-box runs from the operator's machine, never from a workflow");
  assert.deepEqual([actions.ssh.length, actions.other.length], [0, 0]);

  const dirty = world({ git: { status: () => ({ status: 0, stdout: " M src/app/page.tsx\n" }) } });
  const uncommitted = await released(dirty, ["--check"]);
  assert.equal(uncommitted.error?.message, "Commit tracked changes before planning or releasing both leagues");
  assert.equal(dirty.ssh.length, 0);

  const local = world({ git: { "merge-base": () => ({ status: 1, stdout: "" }) } });
  const unmerged = await released(local, ["--check"]);
  assert.equal(unmerged.error?.message, "Release requires a commit on origin/main");
  assert.equal(local.ssh.length, 0);
});

test("a release never changes who can reach a league: allowlist and maintenance modes are refused", async () => {
  for (const mode of ["allowlist", "maintenance", null]) {
    const box = world({ modes: { eu: mode } });
    const { error } = await released(box, ["--check"]);
    assert.equal(error?.message, "eu: the box is not serving the league in proxy mode; release:both never changes who can reach a league", String(mode));
    assert.deepEqual(box.verbsCalled(), ["live us", "live eu", "status"]);
  }
  // The mode is read again right before promotion: an operator may have put
  // a league behind the allowlist while the candidates built.
  let reads = 0;
  const box = world({ agent: { status: (verbs) => (++reads === 1 ? verbs.status()
    : answer(verbs.status(), { leagues: { us: { mode: "allowlist" }, eu: { mode: "proxy" } } })) } });
  const { error } = await released(box);
  assert.equal(error?.message, "us: the box is not serving the league in proxy mode; release:both never changes who can reach a league");
  assert.deepEqual(promotes(box), []);
  assert.deepEqual(runningUnits(box), ["eu:a", "us:a"]);
});

test("a canonical failure on the US restores it and never touches Europe", async () => {
  // Cloudflare keeps answering with the previous commit after the swap.
  const box = world({ edge: { us: (live) => (live.sha === sha ? { commit: baseSha } : {}) } });
  const { error } = await released(box);
  assert.match(error.message, /^Paired promotion failed\. us: previous deployment restored$/);
  assert.deepEqual(promotes(box), [`us ${usId}`, `us ${baseId("us")}`]);
  assert.equal(box.live.us.id, baseId("us"));
  assert.equal(box.live.eu.id, baseId("eu"));
  // Each candidate stopped after its check; the US one, restarted by its
  // promote, stops again once the warm window has passed.
  assert.deepEqual(retired(box), [usId, euId, usId]);
  assert.deepEqual(runningUnits(box), ["eu:a", "us:a"]);
  assertArgvContract(box);
});

test("a promote must answer with the candidate, and the box must then serve it", async () => {
  // The agent swaps but names another release.
  const misnamed = world({ agent: { promote: (lg, id, verbs) => {
    const result = verbs.promote(lg, id);
    return id === usId ? answer(result, { id: baseId("us") }) : result;
  } } });
  const wrongAnswer = await released(misnamed);
  assert.equal(wrongAnswer.error?.message, "Paired promotion failed. us: previous deployment restored");
  assert.deepEqual(promotes(misnamed), [`us ${usId}`, `us ${baseId("us")}`]);

  // The agent answers with the candidate but never swaps, while the edge
  // already reports the new commit: the box's live pointer is the proof.
  let claimed = false;
  const unswapped = world({
    edge: { us: () => (claimed ? { commit: sha } : {}) },
    agent: { promote: (lg, id, verbs) => {
      if (id !== usId) return verbs.promote(lg, id);
      claimed = true;
      return json({ id, previous: baseId("us") });
    } },
  });
  const notLive = await released(unswapped);
  assert.equal(notLive.error?.message, "Paired promotion failed. us: previous deployment unchanged");
  assert.deepEqual(promotes(unswapped), [`us ${usId}`]);
  assert.equal(unswapped.live.eu.id, baseId("eu"));
});

test("an automation probe that fails after the US promote rolls back the US before Europe is touched", async () => {
  const box = world({ health: { us: (kind, live) => (kind === "automation" && live.sha === sha ? { ok: false } : undefined) } });
  const { error } = await released(box);
  assert.equal(error?.message, "Paired promotion failed. us: previous deployment restored");
  assert.deepEqual(promotes(box), [`us ${usId}`, `us ${baseId("us")}`]);
  assert.equal(box.live.eu.id, baseId("eu"));
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
    const { error, saved } = await released(box);
    assert.match(error.message, /^Paired promotion failed\. eu: previous deployment restored; us: previous deployment restored$/);
    assert.deepEqual(promotes(box), [`us ${usId}`, `eu ${euId}`, `eu ${baseId("eu")}`, `us ${baseId("us")}`]);
    assert.equal(box.live.us.id, baseId("us"));
    assert.equal(box.live.eu.id, baseId("eu"));
    assert.equal(saved.status, "failed");
    assert.deepEqual(saved.events.filter((e) => e.action === "recovery").map((e) => e.message),
      ["eu: previous deployment restored", "us: previous deployment restored"]);
    assert.deepEqual(saved.cleanupProblems, []);
    assert.deepEqual(runningUnits(box), ["eu:a", "us:a"]);
    assertArgvContract(box);
  }
});

test("log rows outside the agent's contract fail the finalize gate instead of reading as clean", async () => {
  // Each row would slip past scheduledPasses: a 5xx it never compares, an
  // error it cannot see, or a row it silently dedupes or ignores.
  for (const [name, row] of [
    ["a 5xx row with a text timestamp", (since) => ({ id: "x", timestamp: new Date(since + 50_000).toISOString(), responseStatusCode: 502, requestPath: "/schedule", level: "error" })],
    ["an error row whose level is renamed", (since) => ({ id: "x", timestamp: since + 50_000, responseStatusCode: null, requestPath: null, severity: "error" })],
    ["a row with no id", (since) => ({ timestamp: since + 50_000, responseStatusCode: 200, requestPath: "/", level: "info" })],
    ["a row whose status is text", (since) => ({ id: "x", timestamp: since + 50_000, responseStatusCode: "200", requestPath: "/", level: "info" })],
    ["a row whose path is not text", (since) => ({ id: "x", timestamp: since + 50_000, responseStatusCode: 200, requestPath: 7, level: "info" })],
  ]) {
    const box = world({ logs: { us: (since) => [
      { id: "1", timestamp: since + 20_000, responseStatusCode: 200, requestPath: "/api/cron/automation", level: "info" },
      row(since),
      { id: "3", timestamp: since + 80_000, responseStatusCode: 200, requestPath: "/api/cron/automation", level: "info" },
    ] } });
    const { error } = await released(box);
    assert.equal(error?.message, "Paired promotion failed. eu: previous deployment restored; us: previous deployment restored", name);
    assert.equal(box.live.us.id, baseId("us"), name);
  }
});

test("a rollback whose answer is lost still counts in the retire window", async () => {
  // The US edge never serves the new commit, so the US rolls back; the
  // rollback swaps on the box, but its answer never arrives.
  const box = world({
    edge: { us: (live) => (live.sha === sha ? { commit: baseSha } : {}) },
    agent: { promote: (lg, id, verbs) => {
      const result = verbs.promote(lg, id);
      return id === baseId("us") ? lost() : result;
    } },
  });
  const { error, saved } = await released(box);
  assert.equal(error?.message, "Paired promotion failed. us: rollback needs operator review");
  assert.equal(box.live.us.id, baseId("us"));
  const rollback = box.calls().find((call) => call.args[0] === "promote" && call.args[2] === baseId("us"));
  const cleanup = box.calls().findLast((call) => call.args[0] === "retire");
  assert.deepEqual(cleanup.args.slice(1), ["us", usId]);
  assert.ok(cleanup.at - rollback.at >= 90_000, "the candidate retires 90 s after the rollback that swapped");
  assert.deepEqual(saved.cleanupProblems, []);
  assert.deepEqual(runningUnits(box), ["eu:a", "us:a"]);
});

test("a candidate left live by a refused rollback is reported for review, never retired", async () => {
  const box = world({
    edge: { us: (live) => (live.sha === sha ? { commit: baseSha } : {}) },
    agent: { promote: (lg, id, verbs) => (id === baseId("us") ? refusal("ready_timeout") : verbs.promote(lg, id)) },
  });
  const { error, saved } = await released(box);
  assert.equal(error?.message, "Paired promotion failed. us: rollback needs operator review");
  assert.equal(box.live.us.id, usId);
  assert.deepEqual(saved.cleanupProblems, [`us: candidate ${usId} is live; operator review required`]);
  assert.deepEqual(retired(box), [usId, euId]);
});

test("a failed build or smoke check changes neither live slot", async () => {
  const failedBuild = world({ agent: { build: (lg, commit, verbs) => (lg === "eu" ? refusal("build-failed") : verbs.build(lg, commit)) } });
  const built = await released(failedBuild);
  assert.equal(built.error.message, "box agent build refused (build-failed)");
  assert.ok(!failedBuild.verbsCalled().some((call) => /^(start|promote|retire)/.test(call)));

  const failedCheck = world({ agent: { check: (lg) => json({ ok: lg === "eu" ? undefined : true, checks: [] }) } });
  const checked = await released(failedCheck);
  assert.equal(checked.error.message, "eu: the candidate failed the box smoke check");
  assert.ok(!failedCheck.verbsCalled().some((call) => call.startsWith("promote")));
  assert.deepEqual(retired(failedCheck), [usId, euId]);
  assert.deepEqual(runningUnits(failedCheck), ["eu:a", "us:a"]);
  assert.equal(failedCheck.live.us.id, baseId("us"));
});

test("a start that fails after the agent started the slot still stops the candidate", async () => {
  // A start that times out waiting for health, or whose answer is lost, may
  // already have pointed and restarted the idle slot.
  for (const [failure, message] of [[refusal("start_timeout"), "box agent start refused (start_timeout)"], [lost(), "box agent start failed (exit 255)"]]) {
    const box = world({ agent: { start: (lg, id, verbs) => {
      const result = verbs.start(lg, id);
      return lg === "eu" ? failure : result;
    } } });
    const { error, saved } = await released(box);
    assert.equal(error?.message, message);
    assert.deepEqual(retired(box), [usId, euId]);
    assert.deepEqual(runningUnits(box), ["eu:a", "us:a"]);
    assert.deepEqual(saved.cleanupProblems, []);
  }
});

test("the box must build the reviewed commit and start it beside the live slot", async () => {
  for (const [id, region] of [[`us-20261016T150000Z-${baseSha.slice(0, 12)}`, "us"], [euId, "us"]]) {
    const box = world({ agent: { build: (lg, commit, verbs) => (lg === region ? json({ id, buildSeconds: 1 }) : verbs.build(lg, commit)) } });
    const { error } = await released(box);
    assert.equal(error.message, "us: the box built a release outside the reviewed commit");
    assert.ok(!box.verbsCalled().some((call) => /^(build eu|start|promote)/.test(call)));
  }
  // The agent's record of the build must be the reviewed commit, built.
  for (const patch of [{ state: "BUILDING" }, { state: "FAILED" }, { sha: baseSha }, { region: "eu" }, { id: baseId("us") }]) {
    const box = world({ agent: { deployment: (id, verbs) => (id.startsWith("us-") ? answer(verbs.deployment(id), patch) : verbs.deployment(id)) } });
    const { error } = await released(box);
    assert.equal(error?.message, "us: the built release does not match the reviewed commit", JSON.stringify(patch));
    assert.ok(!box.verbsCalled().some((call) => /^(build eu|start|promote)/.test(call)));
  }
  // A candidate started in the live slot would already have replaced it, and
  // an answer that names no slot proves nothing.
  for (const started of [(lg) => ({ slot: "a", port: port(lg, "a") }), (lg) => ({ slot: "b", port: port(lg, "a") }), () => ({})]) {
    const box = world({ agent: { start: (lg) => json(started(lg)) } });
    const { error } = await released(box);
    assert.equal(error?.message, "us: the candidate did not start in the idle slot", JSON.stringify(started("us")));
    assert.ok(!box.verbsCalled().some((call) => /^(check|promote)/.test(call)));
  }
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
  const failed = await released(gh, ["--check"]);
  assert.equal(failed.error.message, "gh api failed");
  gh.run = async (file, args, options) => file === "gh" ? { status: 0, stdout: `not json ${SECRET}` } : run(file, args, options);
  const garbled = await released(gh, ["--check"]);
  assert.equal(garbled.error.message, "gh api did not return JSON");
});

test("maintenance lanes need reviewed evidence and the agent's quiet-window and lease proof", async () => {
  const noFile = world({ classification: pauseLane });
  const refused = await released(noFile);
  assert.match(refused.error.message, /reviewed maintenance evidence/);
  assert.ok(!noFile.verbsCalled().some((call) => call.startsWith("build")));

  const dir = await mkdtemp(path.join(tmpdir(), "ggd2l-release-box-maintenance-"));
  const file = path.join(dir, "maintenance.json");
  const region = { baseSha, reviewedBy: "Tim", observedAt: new Date(T0 - 60_000).toISOString(), zeroTriggers: true,
    quietSlotsVerified: true, noActiveLease: true, zeroTriggersAt: new Date(T0 - 20 * 60_000).toISOString() };
  await writeFile(file, JSON.stringify({ headSha: sha, regions: { us: region, eu: region } }));
  try {
    // Without --apply the run would only plan, and never read the file.
    for (const argv of [["--maintenance-file", file], ["--check", "--maintenance-file", file]]) {
      const planOnly = world({ classification: pauseLane });
      const { error } = await released(planOnly, argv);
      assert.equal(error?.message, "--maintenance-file is used only by a release: npm run release:both -- --apply --maintenance-file <file>");
      assert.equal(planOnly.ssh.length + planOnly.other.length, 0);
    }

    const busy = world({ classification: pauseLane, agent: { "cron-requests": () => json({ count: 1 }) } });
    const loud = await released(busy, ["--apply", "--maintenance-file", file]);
    assert.equal(loud.error.message, "us: the paused scheduler still reached the site");
    assert.ok(!busy.verbsCalled().some((call) => call.startsWith("build")));

    const leased = world({ classification: pauseLane, agent: { lease: () => json({ leaseOwner: "set", leaseExpiresAt: "set" }) } });
    const held = await released(leased, ["--apply", "--maintenance-file", file]);
    assert.equal(held.error.message, "us: an automation lease is still held");

    // The proof is read again right before promotion: a scheduler resumed
    // while the candidates built must stop the release.
    let built = false;
    const resumed = world({ classification: pauseLane, agent: {
      build: (lg, commit, verbs) => { built = true; return verbs.build(lg, commit); },
      "cron-requests": () => json({ count: built ? 1 : 0 }),
    } });
    const late = await released(resumed, ["--apply", "--maintenance-file", file]);
    assert.equal(late.error?.message, "us: the paused scheduler still reached the site");
    assert.ok(resumed.verbsCalled().some((call) => call.startsWith("build")));
    assert.deepEqual(promotes(resumed), []);
    assert.deepEqual(runningUnits(resumed), ["eu:a", "us:a"]);

    // With the proof, the release promotes and skips the scheduler gates.
    const quiet = world({ classification: pauseLane });
    const { report } = await released(quiet, ["--apply", "--maintenance-file", file]);
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
  const refused = await released(late);
  assert.match(refused.error.message, /07:00-19:00 UTC/);
  assert.ok(!late.verbsCalled().some((call) => call.startsWith("build")));
  const emergency = world({ now: Date.parse("2026-10-16T20:00:00Z") });
  const allowed = await released(emergency, ["--apply", "--outside-window"]);
  assert.equal(allowed.report.status, "verified");
});

test("a league already at the commit is neither rebuilt nor restarted", async () => {
  const box = world();
  box.live.us = { id: `us-20261016T090000Z-${sha.slice(0, 12)}`, sha, slot: "b", port: 3002 };
  const { report } = await released(box);
  assert.equal(report.status, "verified");
  assert.equal(report.classifications.us.lane, "unchanged");
  assert.ok(!box.verbsCalled().some((call) => / us$/.test(call) && !call.startsWith("live")));
  // Both current: nothing to build, CI is not consulted.
  const current = world();
  current.live.us = { id: `us-20261016T090000Z-${sha.slice(0, 12)}`, sha, slot: "b", port: 3002 };
  current.live.eu = { id: `eu-20261016T090000Z-${sha.slice(0, 12)}`, sha, slot: "b", port: 3012 };
  const done = await released(current);
  assert.equal(done.report.status, "already-current");
  assert.deepEqual(current.verbsCalled(), ["live us", "live eu"]);
  assert.ok(!current.other.some((call) => call[0] === "gh"));
});

// The folders of the self-hosting kit that ship node tests.
const KIT_TEST_FOLDERS = ["agent", "smoke", "caddy", "systemd", "sql", "postgres", "backup", "cutover"];

test("release:both runs release-box, and test:release runs every test in the self-hosting kit", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(scripts["release:both"], "node scripts/release-box.mjs");
  // Quoted, so Node expands the glob itself, at any depth.
  const kit = "ops/selfhost/**/*.test.mjs";
  assert.equal(scripts["test:release"], `node --test scripts/shared-release.test.mjs scripts/release-box.test.mjs "${kit}"`);
  // A glob that matches nothing passes silently, so it must match every test
  // file in the kit, and each folder that ships tests must still hold one.
  const walk = (dir) => readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".test.mjs") ? [path.join(dir, entry.name)] : []);
  const onDisk = existsSync(path.join(root, "ops/selfhost")) ? walk("ops/selfhost").sort() : [];
  const matched = globSync(kit, { cwd: root }).sort();
  assert.deepEqual(matched, onDisk);
  for (const folder of KIT_TEST_FOLDERS) {
    if (!existsSync(path.join(root, "ops/selfhost", folder))) continue;
    assert.ok(matched.some((file) => file.startsWith(`ops/selfhost/${folder}/`)), `ops/selfhost/${folder}/ has no test that test:release runs`);
  }
});
