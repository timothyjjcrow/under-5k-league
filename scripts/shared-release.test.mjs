import { test } from "node:test";
import assert from "node:assert/strict";
import { LEAGUE_TARGETS, assertDeployment, assertReleaseInfo, promotePair } from "./league-targets.mjs";
import { requireSuccessfulCi, requireMaintenanceEvidence, scheduledPasses } from "./release-both.mjs";
import { hostedReleaseInputs } from "./hosted-migration-release.mjs";

const sha = "a".repeat(40);
const baseSha = "b".repeat(40);
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
