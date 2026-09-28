import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LEAGUE_TARGETS, RELEASE_REPOSITORY, assertDeployment, assertReleaseInfo, promotePair } from "./league-targets.mjs";
import { requireSuccessfulCi, requiredCiGates, requireReleaseCi, findMutationCoverage, mutationShardsSkipped, MUTATION_COVERAGE_WORKFLOWS, requireMaintenanceEvidence, scheduledPasses, cliScopeArgs, createReleaseDirectory } from "./release-both.mjs";
import { hostedReleaseInputs } from "./hosted-migration-release.mjs";
import { projectProvider } from "./release-provider.mjs";
import { classifyEntries } from "./classify-release.mjs";

const sha = "a".repeat(40);
const baseSha = "b".repeat(40);
test("provider requests isolate project credentials, protection headers, and promotion targets", async () => {
  for (const target of LEAGUE_TARGETS) {
    const calls = [];
    const request = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/v9/projects/'))
        return Response.json({ id: target.projectId, protectionBypass: { "fixture-bypass": { scope: "automation-bypass" } } });
      if (String(url).includes('/promote/')) return new Response(null, { status: 204 });
      return Response.json({ ok: true });
    };
    const provider = projectProvider(target, "fixture-access", request);
    await provider.probe(target.origin, "/api/health/live");
    await provider.promote("dpl_fixture123");
    assert.equal(calls[0].init.headers.Authorization, "Bearer fixture-access");
    assert.equal(calls[1].init.headers.Authorization, undefined);
    assert.equal(calls[1].init.headers["x-vercel-protection-bypass"], "fixture-bypass");
    assert.ok(calls.every((call) => call.init.redirect === "error"));
    assert.ok(calls[2].url.includes(`/projects/${target.projectId}/promote/dpl_fixture123`));
    assert.equal(calls[2].init.method, "POST");
    assert.equal(calls[2].init.body, "{}");
    await assert.rejects(provider.probe("https://example.com", "/"), /unexpected deployment/);
    await assert.rejects(provider.probe(target.origin, "//example.com"), /invalid probe/);
    assert.equal(calls.length, 3);
  }
});
test("provider errors never include returned credentials or response bodies", async () => {
  const target = LEAGUE_TARGETS[0];
  const provider = projectProvider(target, "fixture-access", async () => new Response("private-provider-body", { status: 403 }));
  await assert.rejects(provider.api(`/v9/projects/${target.projectId}`), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /fixture-access|private-provider-body/);
    return true;
  });
});
test("runtime logs are paginated, include nested failures, and reject mixed deployments", async () => {
  const target = LEAGUE_TARGETS[0];
  let page = 0;
  const provider = projectProvider(target, "fixture-access", async (url) => {
    assert.equal(new URL(url).searchParams.get("teamId"), "team_AAPVeTcNEWDyESODtRIjzyry");
    return Response.json({
    rows: [{ deploymentId: "dpl_fixture123", timestamp: `2026-09-12T10:0${page}:00Z`, statusCode: 200, requestPath: "/api/cron/automation", logs: page ? [{ level: "error" }] : [] }],
    hasMoreRows: page++ === 0,
    });
  });
  const logs = await provider.logs("dpl_fixture123", 0);
  assert.equal(logs.length, 2);
  assert.throws(() => scheduledPasses(logs, 0), /runtime errors/);
  const mixed = projectProvider(target, "fixture-access", async () => Response.json({ rows: [{ deploymentId: "dpl_wrong" }] }));
  await assert.rejects(mixed.logs("dpl_fixture123", 0), /unexpected deployment/);
  const malformed = projectProvider(target, "fixture-access", async () => Response.json({}));
  await assert.rejects(malformed.logs("dpl_fixture123", 0), /invalid runtime log/);
});
test("project credentials use linked project context without account-wide CLI scope lookup", () => {
  for (const target of LEAGUE_TARGETS) {
    assert.deepEqual(cliScopeArgs(target, { [target.tokenEnv]: "fixture-token" }), []);
    assert.deepEqual(cliScopeArgs(target, {}), ["--scope", "timothyjjcrows-projects"]);
    const other = LEAGUE_TARGETS.find((candidate) => candidate !== target);
    assert.equal(cliScopeArgs(target, { [other.tokenEnv]: "fixture-token" })[0], "--scope");
  }
});
test("temporary classifier paths resolve symlinks before Node entry-point checks", async () => {
  const temporary = await mkdtemp(path.join(await realpath(tmpdir()), "release-path-test-"));
  try {
    await mkdir(path.join(temporary, "actual"));
    await symlink(path.join(temporary, "actual"), path.join(temporary, "alias"), "dir");
    const directory = await createReleaseDirectory(path.join(temporary, "alias"));
    assert.equal(directory, await realpath(directory));
    assert.equal(path.dirname(directory), path.join(temporary, "actual"));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
test("hosted migration jobs require a full approved commit, production validation and temporary URLs", () => {
  const env = { VERCEL_ENV: "production", HOSTED_MIGRATION_RELEASE_SHA: sha, HOSTED_MIGRATION_DATABASE_URL: "postgresql://fixture", HOSTED_MIGRATION_DIRECT_URL: "postgresql://fixture" };
  assert.equal(hostedReleaseInputs(env).sha, sha);
  for (const patch of [{ VERCEL_ENV: "preview" }, { HOSTED_MIGRATION_RELEASE_SHA: "main" }, { HOSTED_MIGRATION_DIRECT_URL: undefined }, { HOSTED_MIGRATION_DATABASE_URL: "file:./fixture.db" }])
    assert.throws(() => hostedReleaseInputs({ ...env, ...patch }));
});
test("scheduler verification requires two consecutive successful minute slots and clean logs", () => {
  const log = (timestamp, responseStatusCode = 200) => ({ timestamp, responseStatusCode, requestPath: "/api/cron/automation" });
  assert.equal(scheduledPasses([log(60_000)], 0), null);
  assert.equal(scheduledPasses([log(60_000), log(60_001)], 0), null);
  assert.equal(scheduledPasses([log(60_000), log(120_000, 202)], 0), null);
  assert.equal(scheduledPasses([log(60_000), log(180_000)], 0), null);
  assert.equal(scheduledPasses([log(60_000), log(120_000)], 0).length, 2);
  assert.throws(() => scheduledPasses([log(60_000), log(120_000, 500)], 0));
});
test("scheduler verification counts duplicate provider rows once without hiding failures", () => {
  const first = { id: "request-one", timestamp: 60_000, responseStatusCode: 200, requestPath: "/api/cron/automation" };
  const second = { id: "request-two", timestamp: 120_000, responseStatusCode: 200, requestPath: "/api/cron/automation" };
  assert.deepEqual(scheduledPasses([first, second, first, second], 0), [
    new Date(first.timestamp).toISOString(), new Date(second.timestamp).toISOString(),
  ]);
  assert.deepEqual(scheduledPasses([
    { ...first, id: undefined }, { ...second, id: undefined },
    { ...first, id: undefined }, { ...second, id: undefined },
  ], 0), [new Date(first.timestamp).toISOString(), new Date(second.timestamp).toISOString()]);
  assert.equal(scheduledPasses([first, first], 0), null);
  assert.equal(scheduledPasses([first, second, { ...second, responseStatusCode: 202 }], 0), null);
  assert.throws(() => scheduledPasses([first, second, { ...second, responseStatusCode: 500 }], 0), /runtime errors/);
});
const ciRun = { head_sha: sha, status: "completed", conclusion: "success" };
const mutationShards = [1, 2, 3, 4].map((n) => `mutation guard ${n}/4`);
const ciJobs = ["classify release impact", "audit, lint, types, build, tests", "playwright e2e (us)", "playwright e2e (eu)", "integration on postgres", ...mutationShards].map((name) => ({ name, status: "completed", conclusion: "success" }));
const skipped = (names) => ciJobs.map((j) => names.includes(j.name) ? { ...j, conclusion: "skipped" } : j);
const allGates = { postgres: true, mutation: true };
test("CI must cover the exact commit and both regional browser suites", () => {
  requireSuccessfulCi(ciRun, ciJobs, sha, allGates);
  assert.throws(() => requireSuccessfulCi({ ...ciRun, head_sha: baseSha }, ciJobs, sha, allGates));
  assert.throws(() => requireSuccessfulCi({ ...ciRun, conclusion: "failure" }, ciJobs, sha, allGates));
  assert.throws(() => requireSuccessfulCi(ciRun, ciJobs.filter((j) => j.name !== "playwright e2e (eu)"), sha, { postgres: false, mutation: false }));
  assert.throws(() => requireSuccessfulCi(ciRun, skipped(["integration on postgres"]), sha, allGates), /integration on postgres/);
});
test("CI gate selection must be explicit", () => {
  for (const gates of [true, false, undefined, {}, { postgres: true }, { postgres: true, mutation: "false" }])
    assert.throws(() => requireSuccessfulCi(ciRun, ciJobs, sha, gates), /gate selection/);
});
test("skipped mutation shards pass only when the release does not need the ratchet", () => {
  for (const shard of mutationShards) {
    assert.throws(() => requireSuccessfulCi(ciRun, skipped([shard]), sha, allGates), new RegExp(shard));
    assert.throws(() => requireSuccessfulCi(ciRun, ciJobs.filter((j) => j.name !== shard), sha, allGates), new RegExp(shard));
  }
  requireSuccessfulCi(ciRun, skipped(mutationShards), sha, { postgres: true, mutation: false });
  // A skipped matrix job may not be expanded into shard names at all.
  requireSuccessfulCi(ciRun, ciJobs.filter((j) => !mutationShards.includes(j.name)), sha, { postgres: true, mutation: false });
  assert.throws(() => requireSuccessfulCi(ciRun, skipped([...mutationShards, "integration on postgres"]), sha, { postgres: true, mutation: false }), /integration on postgres/);
});
test("the trusted classification decides which CI gates a release needs", () => {
  const modified = (file) => ({ status: "M", code: "M", oldPath: null, path: file, oldMode: "100644", newMode: "100644" });
  const unchanged = { lane: "unchanged", needs_db_release: false, needs_scheduler_pause: false };
  const gates = (...classifications) => requiredCiGates(classifications);
  assert.deepEqual(gates(unchanged, unchanged), { postgres: false, mutation: false });
  assert.deepEqual(gates(classifyEntries([modified("public/logo.png")]), unchanged), { postgres: false, mutation: false });
  // A page or wording change still runs PostgreSQL, but not the ratchet.
  assert.deepEqual(gates(classifyEntries([modified("src/app/schedule/page.tsx")]), unchanged), { postgres: true, mutation: false });
  assert.deepEqual(gates(classifyEntries([modified("CLAUDE.md")]), classifyEntries([modified("CLAUDE.md")])), { postgres: true, mutation: false });
  for (const file of ["src/lib/draft-service.ts", "src/app/actions/admin.ts", "test/integration/draft.itest.ts", "test/mutation-baseline.json", "scripts/mutation-guard.mjs", "prisma/schema.prisma", "package.json"])
    assert.deepEqual(gates(classifyEntries([modified(file)]), unchanged), { postgres: true, mutation: true }, file);
  // Either region needing the ratchet makes the release need it.
  assert.deepEqual(gates(classifyEntries([modified("src/app/schedule/page.tsx")]), classifyEntries([modified("src/lib/draft-service.ts")])), { postgres: true, mutation: true });
  // An older production classifier that lacks the field requires the ratchet.
  assert.deepEqual(gates({ lane: "app", needs_postgres: true }, unchanged), { postgres: true, mutation: true });
  assert.deepEqual(gates({ lane: "ui-only", needs_postgres: false }, unchanged), { postgres: false, mutation: true });
  assert.deepEqual(gates({ lane: "app", needs_mutation: "false" }, unchanged), { postgres: true, mutation: true });
});
test("the release knows when the exact commit's CI run skipped the mutation shards", () => {
  assert.equal(mutationShardsSkipped(skipped(mutationShards)), true);
  // A skipped matrix job may not be expanded into shard names at all.
  assert.equal(mutationShardsSkipped(ciJobs.filter((j) => !mutationShards.includes(j.name))), true);
  assert.equal(mutationShardsSkipped(ciJobs), false);
  // A shard that ran is the commit's own verdict, even beside skipped ones.
  assert.equal(mutationShardsSkipped(skipped(mutationShards.slice(1))), false);
  assert.equal(mutationShardsSkipped(ciJobs.map((j) => mutationShards.includes(j.name) ? { ...j, conclusion: "failure" } : j)), false);
});
const coveringRun = { id: 71, html_url: "https://github.com/runs/71", workflow: "ci.yml", shardPrefix: "" };
test("skipped mutation shards need an earlier passing ratchet run when the release needs one", async () => {
  let asked = 0;
  const finds = (result) => async () => { asked++; return result; };
  // The exact commit ran the shards, or the release does not need them.
  assert.equal(await requireReleaseCi(ciRun, ciJobs, sha, allGates, finds(coveringRun)), null);
  assert.equal(await requireReleaseCi(ciRun, skipped(mutationShards), sha, { postgres: true, mutation: false }, finds(coveringRun)), null);
  assert.equal(asked, 0);
  // Skipped but needed: an earlier run covers it, or the release stops and
  // says what to do.
  assert.equal(await requireReleaseCi(ciRun, skipped(mutationShards), sha, allGates, finds(coveringRun)), coveringRun);
  assert.equal(asked, 1);
  await assert.rejects(requireReleaseCi(ciRun, skipped(mutationShards), sha, allGates, finds(null)), /force_strict[\s\S]*Prepare both leagues/);
  // The exact run's own checks come first and nothing covers them.
  asked = 0;
  await assert.rejects(requireReleaseCi({ ...ciRun, head_sha: baseSha }, skipped(mutationShards), sha, allGates, finds(coveringRun)), /exact release commit/);
  await assert.rejects(requireReleaseCi(ciRun, skipped([...mutationShards, "integration on postgres"]), sha, allGates, finds(coveringRun)), /integration on postgres/);
  assert.equal(asked, 0);
  // A shard that failed on the exact commit is never covered by another run.
  const failed = ciJobs.map((j) => j.name === mutationShards[0] ? { ...j, conclusion: "failure" } : j);
  await assert.rejects(requireReleaseCi(ciRun, failed, sha, allGates, finds(coveringRun)), new RegExp(mutationShards[0]));
  await assert.rejects(requireReleaseCi(ciRun, ciJobs, sha, { postgres: true }, finds(coveringRun)), /gate selection/);
  assert.equal(asked, 0);
});
test("only a passing ratchet run on an ancestor with a mutation-neutral delta covers skipped shards", async () => {
  const ancestor = "c".repeat(40);
  const older = "d".repeat(40);
  const sensitive = "e".repeat(40);
  const shardJobs = (prefix) => [1, 2, 3, 4].map((n) => ({ name: `${prefix}mutation guard ${n}/4`, status: "completed", conclusion: "success" }));
  const run = (id, patch = {}) => ({
    id, html_url: `https://github.com/runs/${id}`, head_sha: ancestor, head_branch: "main", event: "push",
    status: "completed", conclusion: "success", head_repository: { full_name: RELEASE_REPOSITORY },
    created_at: `2026-09-${String(10 + id).padStart(2, "0")}T07:00:00Z`, workflow: "ci.yml", shardPrefix: "", ...patch,
  });
  const neutralChecks = [];
  const deps = (jobsById = {}) => ({
    neutral: async (base) => { neutralChecks.push(base); return base !== sensitive; },
    jobsFor: async (r) => jobsById[r.id] ?? shardJobs(r.shardPrefix),
  });
  const find = (runs, jobsById) => findMutationCoverage(sha, runs, deps(jobsById));
  // Runs that did not test their own main commit, or did not pass, never count.
  for (const patch of [{ event: "pull_request" }, { head_branch: "feature" }, { head_repository: { full_name: "someone/fork" } },
    { conclusion: "failure" }, { status: "in_progress" }, { head_sha: sha }, { head_sha: "main" }, { id: "../1" }])
    assert.equal(await find([run(1, patch)]), null, JSON.stringify(patch));
  // A delta that reaches the ratchet (or a base that is no ancestor) is not covered.
  assert.equal(await find([run(1, { head_sha: sensitive })]), null);
  // A green run whose shards were skipped proves nothing about the ratchet.
  assert.equal(await find([run(1)], { 1: skipped(mutationShards) }), null);
  assert.equal(await find([run(1)], { 1: [] }), null);
  // Shard names must be the ones that run's workflow uses.
  assert.equal(await find([run(1, { workflow: "mutation-nightly.yml", shardPrefix: "nightly " })], { 1: shardJobs("") }), null);
  assert.deepEqual(await find([run(2, { workflow: "mutation-nightly.yml", shardPrefix: "nightly ", event: "schedule", head_sha: older })]),
    { id: 2, url: "https://github.com/runs/2", sha: older, workflow: "mutation-nightly.yml" });
  // The newest covering run wins, and each commit is classified once.
  neutralChecks.length = 0;
  assert.deepEqual(await find([run(1, { head_sha: older }), run(3, { event: "workflow_dispatch" }), run(4), run(5, { head_sha: sensitive })], { 4: skipped(mutationShards) }),
    { id: 3, url: "https://github.com/runs/3", sha: ancestor, workflow: "ci.yml" });
  assert.deepEqual(neutralChecks, [sensitive, ancestor]);
  // A check that fails rules out only that run.
  const flaky = { neutral: async (base) => { if (base === ancestor) throw new Error("classifier failed"); return true; }, jobsFor: async (r) => { if (r.id === 2) throw new Error("gh failed"); return shardJobs(""); } };
  assert.deepEqual(await findMutationCoverage(sha, [run(3), run(2, { head_sha: older }), run(1, { head_sha: sensitive })], flaky),
    { id: 1, url: "https://github.com/runs/1", sha: sensitive, workflow: "ci.yml" });
});
test("the CI mutation job matches the release gate and the nightly verify runs the same steps", () => {
  const read = (file) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
  const ci = read("ci.yml");
  const nightly = read("mutation-nightly.yml");
  const job = /\n  mutation:\n([\s\S]*?)\n  e2e:\n/.exec(ci)?.[1];
  assert.ok(job, "ci.yml has a mutation job followed by the e2e job");
  // requireSuccessfulCi names these four shards; the job skips only on the
  // classifier's explicit needs_mutation=false.
  assert.match(job, /^    name: mutation guard \$\{\{ matrix\.shard \}\}\/4\n/);
  assert.match(job, /\n        shard: \[1, 2, 3, 4\]\n/);
  assert.match(job, /needs\.classify\.result != 'success' \|\| needs\.classify\.outputs\.needs_mutation != 'false'/);
  // When the shards skip, the always-required test job still checks that every
  // claim-bearing file is in the guard's FILES and every claim is classified.
  const testJob = /\n  test:\n([\s\S]*?)\n  postgres:\n/.exec(ci)?.[1];
  assert.match(testJob ?? "", /\n        run: node scripts\/mutation-guard\.mjs --static\n/);
  // The nightly: scheduled on main, never on pull requests or pushes, and
  // the same verification steps as CI.
  assert.match(nightly, /\n  schedule:\n    - cron: "0 7 \* \* \*"\n/);
  assert.doesNotMatch(nightly, /\n  (?:pull_request|pull_request_target|push|workflow_run):/);
  assert.match(nightly, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}\n/);
  assert.match(nightly, /\n        shard: \[1, 2, 3, 4\]\n/);
  const steps = (text) => text.slice(text.indexOf("\n    steps:\n")).trimEnd();
  assert.equal(steps(nightly), steps(job));
  // release:both may accept these runs' shards for a later commit, so the
  // listed workflows and their shard names must be the real ones, and the
  // release workflow must be allowed to read them.
  assert.deepEqual(MUTATION_COVERAGE_WORKFLOWS.map((w) => w.workflow), ["ci.yml", "mutation-nightly.yml"]);
  assert.match(nightly, /\n    name: nightly mutation guard \$\{\{ matrix\.shard \}\}\/4\n/);
  assert.equal(MUTATION_COVERAGE_WORKFLOWS[1].shardPrefix, "nightly ");
  assert.match(read("release.yml"), /\npermissions:\n  contents: read\n  actions: read\n/);
});
test("maintenance evidence cannot waive an affected database or scheduler", () => {
  const now = Date.now();
  const plan = { sha, bases: { us: { sha: baseSha } }, classifications: { us: { needs_db_release: true, needs_scheduler_pause: true }, eu: {} } };
  const record = { baseSha, reviewedBy: "release owner", observedAt: new Date(now).toISOString(), backupVerified: true, restoreRehearsed: true, migrationReleasePassed: true, zeroTriggers: true, quietSlotsVerified: true, noActiveLease: true, zeroTriggersAt: new Date(now - 20 * 60_000).toISOString() };
  const evidence = { headSha: sha, regions: { us: record } };
  requireMaintenanceEvidence(plan, evidence, now);
  assert.throws(() => requireMaintenanceEvidence(plan, undefined, now));
  for (const patch of [{ backupVerified: false }, { restoreRehearsed: false }, { migrationReleasePassed: false }, { noActiveLease: false }, { baseSha: sha }, { zeroTriggersAt: new Date(now).toISOString() }, { observedAt: "invalid" }])
    assert.throws(() => requireMaintenanceEvidence(plan, { ...evidence, regions: { us: { ...record, ...patch } } }, now));
  requireMaintenanceEvidence({ classifications: { us: {}, eu: {} } }, undefined, now);
});
test("cleanup deletions need no maintenance evidence; schema and scheduler deletions still do", () => {
  const deleted = (file) => ({ status: "D", code: "D", oldPath: null, path: file, oldMode: "100644", newMode: "000000" });
  const modified = (file) => ({ status: "M", code: "M", oldPath: null, path: file, oldMode: "100644", newMode: "100644" });
  const plan = (entries) => ({ sha, bases: { us: { sha: baseSha }, eu: { sha: baseSha } }, classifications: { us: classifyEntries(entries), eu: classifyEntries(entries) } });
  const now = Date.now();
  requireMaintenanceEvidence(plan([deleted("docs/TIEBREAKER-WEEK.md")]), undefined, now);
  requireMaintenanceEvidence(plan([deleted("src/app/actions/match-lineups.ts"), deleted("src/components/match-lineups.tsx")]), undefined, now);
  requireMaintenanceEvidence(plan([modified("ops/dota-lobby-bot/server.mjs"), deleted("ops/dota-lobby-relay/src/protocol.mjs")]), undefined, now);
  for (const file of ["prisma/migrations/20990101000000_example/migration.sql", "ops/cloudflare-automation-worker/src/index.ts", "ops/scheduler-backup/cron.mjs", "src/app/api/cron/automation/route.ts", "src/lib/automation-service.ts", "unknown.txt"])
    assert.throws(() => requireMaintenanceEvidence(plan([deleted(file)]), undefined, now), /maintenance evidence/);
  assert.throws(() => requireMaintenanceEvidence(plan([modified("ops/cloudflare-automation-worker/wrangler.jsonc")]), undefined, now), /maintenance evidence/);
});
test("the shared targets retain separate projects, origins and deployment credentials", () => {
  for (const key of ["projectId", "origin", "tokenEnv", "functionRegion"])
    assert.equal(new Set(LEAGUE_TARGETS.map((target) => target[key])).size, 2);
});
test("a swapped project, region, commit or preview cannot pass a production check", () => {
  const target = LEAGUE_TARGETS[0];
  const good = { projectId: target.projectId, meta: { gitCommitSha: sha }, readyState: "READY", target: "production", regions: [target.functionRegion] };
  assertDeployment(target, good, sha);
  for (const patch of [{ projectId: LEAGUE_TARGETS[1].projectId }, { regions: ["fra1"] }, { meta: { gitCommitSha: "b".repeat(40) } }, { target: null }, { readyState: "ERROR" }])
    assert.throws(() => assertDeployment(target, { ...good, ...patch }, sha));
  assert.throws(() => assertReleaseInfo(target, { ok: true, region: "eu", commit: sha }, sha));
});

function simulation() {
  const bases = { us: { id: "us-old" }, eu: { id: "eu-old" } };
  const candidates = { us: { id: "us-new" }, eu: { id: "eu-new" } };
  const live = { ...bases };
  const actions = [];
  return { bases, candidates, live, actions,
    readLive: async (t) => live[t.region],
    promote: async (t, id) => { actions.push([t.region, id]); live[t.region] = { id }; },
    verify: async (t, d) => assert.equal(live[t.region].id, d.id) };
}
test("a successful release promotes and verifies both leagues", async () => {
  const s = simulation(); await promotePair(s);
  assert.deepEqual(s.live, s.candidates);
});
test("post-promotion automation failure restores both candidates", async () => {
  const s = simulation();
  await assert.rejects(promotePair({ ...s, finalize: async () => { throw new Error("automation failure"); } }));
  assert.deepEqual(s.live, s.bases);
});
test("an external deployment during staging prevents any promotion", async () => {
  const s = simulation(); s.live.eu = { id: "external" };
  await assert.rejects(promotePair(s), /production changed/);
  assert.deepEqual(s.actions, []);
});
test("a failed second promotion restores the first region", async () => {
  const s = simulation(); const promote = s.promote;
  s.promote = async (t, id) => { if (id === "eu-new") throw new Error("provider failure"); await promote(t, id); };
  await assert.rejects(promotePair(s), /previous deployment restored/);
  assert.deepEqual(s.live, s.bases);
});
test("an uncertain promotion that landed is also rolled back", async () => {
  const s = simulation(); const promote = s.promote;
  s.promote = async (t, id) => { await promote(t, id); if (id === "eu-new") throw new Error("response lost"); };
  await assert.rejects(promotePair(s), /Paired promotion failed/);
  assert.deepEqual(s.live, s.bases);
});
test("a failed health check rolls both regions back", async () => {
  const s = simulation(); s.verify = async (t) => { if (t.region === "eu") throw new Error("bad health"); };
  await assert.rejects(promotePair(s), /Paired promotion failed/);
  assert.deepEqual(s.live, s.bases);
});
test("recovery never overwrites another release", async () => {
  const s = simulation(); s.verify = async () => { s.live.us = { id: "external" }; throw new Error("changed"); };
  await assert.rejects(promotePair(s), /external deployment left untouched/);
  assert.equal(s.live.us.id, "external");
});
test("rollback failure is reported instead of claiming a paired release", async () => {
  const s = simulation(); const promote = s.promote;
  s.promote = async (t, id) => { if (id === "eu-new" || id === "us-old") throw new Error("provider unavailable"); await promote(t, id); };
  await assert.rejects(promotePair(s), /rollback needs operator review/);
});
