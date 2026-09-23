import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LEAGUE_TARGETS, assertDeployment, assertReleaseInfo, promotePair } from "./league-targets.mjs";
import { requireSuccessfulCi, requireMaintenanceEvidence, scheduledPasses, cliScopeArgs, createReleaseDirectory } from "./release-both.mjs";
import { hostedReleaseInputs } from "./hosted-migration-release.mjs";
import { projectProvider } from "./release-provider.mjs";

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
test("CI must cover the exact commit and both regional browser suites", () => {
  const run = { head_sha: sha, status: "completed", conclusion: "success" };
  const jobs = ["classify release impact", "audit, lint, types, build, tests", "playwright e2e (us)", "playwright e2e (eu)", "integration on postgres", ...[1, 2, 3, 4].map((n) => `mutation guard ${n}/4`)].map((name) => ({ name, status: "completed", conclusion: "success" }));
  requireSuccessfulCi(run, jobs, sha, true);
  assert.throws(() => requireSuccessfulCi({ ...run, head_sha: baseSha }, jobs, sha, true));
  assert.throws(() => requireSuccessfulCi(run, jobs.filter((j) => j.name !== "playwright e2e (eu)"), sha, false));
  assert.throws(() => requireSuccessfulCi(run, jobs.map((j) => j.name === "integration on postgres" ? { ...j, conclusion: "skipped" } : j), sha, true));
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
