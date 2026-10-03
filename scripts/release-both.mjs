import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LEAGUE_TARGETS, VERCEL_TEAM_ID, VERCEL_SCOPE, RELEASE_REPOSITORY, assertDeployment, assertReleaseInfo, promotePair } from "./league-targets.mjs";
import { projectProvider } from "./release-provider.mjs";

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const CLI = "vercel@59.11.7";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --scope asks the CLI to load account-wide user/team resources. Project
// credentials deliberately cannot read those; the explicit ORG_ID/PROJECT_ID
// environment and linked checkout already select the authorized project.
export function cliScopeArgs(target, env = process.env) {
  return env[target.tokenEnv] ? [] : ["--scope", VERCEL_SCOPE];
}

export async function createReleaseDirectory(root = tmpdir()) {
  // Node resolves import.meta.url through symlinks. The trusted classifier's
  // entry-point check also needs argv[1] to use the real path (macOS /var).
  return mkdtemp(path.join(await realpath(root), "ggd2l-shared-release-"));
}

async function command(file, args, options = {}) {
  try {
    return (await exec(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000, ...options })).stdout.trim();
  } catch {
    // Provider output may contain private configuration. Report the operation,
    // never command arguments, credential values or captured response bodies.
    throw new Error(`${file} ${args[0] ?? ""} failed; inspect the provider's build or workflow logs`);
  }
}

// The CI gates a release needs beyond the ones every release needs, from each
// changed region's TRUSTED classification (the production commit's
// classifier). PostgreSQL follows the lane, as before. The mutation shards may
// be skipped only when every changed region's classification explicitly says
// needs_mutation is false; a classifier that omits the field counts as true.
export function requiredCiGates(classifications) {
  const changed = classifications.filter((c) => c.lane !== "unchanged");
  return {
    postgres: changed.some((c) => c.lane !== "ui-only"),
    mutation: changed.some((c) => c.needs_mutation !== false),
  };
}

// The four mutation shard job names: CI's, or the nightly verify's with its
// "nightly " prefix (.github/workflows/mutation-nightly.yml).
const mutationShards = (prefix = "") => [1, 2, 3, 4].map((n) => `${prefix}mutation guard ${n}/4`);
const passed = (jobs, name) => jobs.some((job) => job.name === name && job.conclusion === "success" && job.status === "completed");

export function requireSuccessfulCi(run, jobs, sha, gates) {
  if (typeof gates?.postgres !== "boolean" || typeof gates?.mutation !== "boolean")
    throw new Error("CI gate selection must say whether the PostgreSQL and mutation jobs are required");
  if (run.head_sha !== sha || run.status !== "completed" || run.conclusion !== "success")
    throw new Error("A successful completed CI run for the exact release commit is required");
  const required = ["classify release impact", "audit, lint, types, build, tests", "playwright e2e (us)", "playwright e2e (eu)"];
  if (gates.postgres) required.push("integration on postgres");
  if (gates.mutation) required.push(...mutationShards());
  for (const name of required) {
    if (!passed(jobs, name)) throw new Error(`Required CI job did not pass: ${name}`);
  }
}

// CI decides whether to run the mutation shards from the PUSH's own delta, the
// release from each region's production commit. When production lags main by
// an unpromoted commit that reaches the ratchet, a later page-only push skips
// the shards in CI although the release needs them. Its ratchet verdict is
// still known if an EARLIER main commit passed all four shards and every
// changed region's trusted classifier calls the rest of the way to the
// candidate mutation-neutral: that is the same claim CI relies on to skip, so
// nothing the ratchet reads changed since the shards passed.
//
// Only a run on main that tested its own head commit counts: a CI push run, a
// CI run dispatched on main, or the nightly verify. A pull-request run tests
// a merge commit rather than its head, so it never counts.
const COVERAGE_EVENTS = new Set(["push", "workflow_dispatch", "schedule"]);
export const MUTATION_COVERAGE_WORKFLOWS = [
  { workflow: "ci.yml", shardPrefix: "" },
  { workflow: "mutation-nightly.yml", shardPrefix: "nightly " },
];

// True when the exact commit's CI run did not run the mutation shards at all
// (CI skipped them on needs_mutation=false; a skipped matrix job may not be
// expanded into shard names). A shard that ran is that commit's own verdict,
// and nothing may stand in for it.
export function mutationShardsSkipped(jobs) {
  const names = new Set(mutationShards());
  return jobs.filter((job) => names.has(job.name)).every((job) => job.conclusion === "skipped");
}

// The newest listed run that proves the ratchet for `sha` (see above), or
// null. `runs` carry the `workflow` and `shardPrefix` of their listing;
// `neutral(base)` runs every changed region's trusted classifier from `base`
// to `sha` (it also refuses a base that is not an ancestor) and `jobsFor(run)`
// lists a run's jobs. A failure while checking a run only rules that run out.
export async function findMutationCoverage(sha, runs, { neutral, jobsFor }) {
  const settle = async (check) => { try { return await check(); } catch { return undefined; } };
  const verdicts = new Map();
  const newest = [...runs].sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
  for (const run of newest) {
    if (!SHA.test(run.head_sha ?? "") || run.head_sha === sha || !/^\d+$/.test(String(run.id))) continue;
    if (run.status !== "completed" || run.conclusion !== "success" || run.head_branch !== "main") continue;
    if (!COVERAGE_EVENTS.has(run.event) || run.head_repository?.full_name !== RELEASE_REPOSITORY) continue;
    if (!verdicts.has(run.head_sha)) verdicts.set(run.head_sha, await settle(() => neutral(run.head_sha)));
    if (verdicts.get(run.head_sha) !== true) continue;
    const jobs = await settle(() => jobsFor(run));
    if (!Array.isArray(jobs) || !mutationShards(run.shardPrefix).every((name) => passed(jobs, name))) continue;
    return { id: run.id, url: run.html_url, sha: run.head_sha, workflow: run.workflow };
  }
  return null;
}

// The CI check a release runs: requireSuccessfulCi on the exact commit's run,
// where mutation shards that run skipped may be covered by findCoverage().
// Returns the covering run, or null when none was needed.
export async function requireReleaseCi(run, jobs, sha, gates, findCoverage) {
  if (gates?.mutation !== true || !mutationShardsSkipped(jobs)) {
    requireSuccessfulCi(run, jobs, sha, gates);
    return null;
  }
  requireSuccessfulCi(run, jobs, sha, { ...gates, mutation: false });
  const coverage = await findCoverage();
  if (!coverage)
    throw new Error(
      "This release needs the mutation ratchet, but CI skipped it for this commit and no passing ratchet run on an " +
        "earlier main commit covers the change. Run the CI workflow on main with force_strict, wait for it to pass, " +
        "then run Prepare both leagues again (README, Hosting and release setup).",
    );
  return coverage;
}

export function scheduledPasses(logs, since) {
  const recent = logs.filter((log) => log.timestamp >= since);
  if (recent.some((log) => log.level === "error" || log.level === "fatal" || log.responseStatusCode >= 500))
    throw new Error("Fresh runtime errors require release review");
  // Vercel's CLI can return the same request more than once. Count distinct
  // scheduler requests, while retaining every row in the error scan above.
  const attempts = new Map();
  for (const log of recent.filter((entry) => entry.requestPath === "/api/cron/automation")) {
    const key = log.id ?? log.timestamp;
    const prior = attempts.get(key);
    attempts.set(key, {
      timestamp: log.timestamp,
      success: log.responseStatusCode === 200 && (prior?.success ?? true),
    });
  }
  const last = [...attempts.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-2);
  return last.length === 2 && last.every((log) => log.success) &&
    last[1].timestamp - last[0].timestamp >= 30_000 && last[1].timestamp - last[0].timestamp <= 90_000
    ? last.map((log) => new Date(log.timestamp).toISOString()) : null;
}

// /api/health/automation can answer 503 on a healthy league. The worker sleeps
// until its next wake, at most an hour after its last pass, and from that wake
// until the next scheduled pass finishes (up to one scheduler tick plus the
// pass) the probe reads the last success as stale. That rolled back the first
// promotion of 95dff96 (US, 2026-10-03 15:16 UTC, three 503s in 40 seconds). A
// deployment whose gate snapshot was taken mid-pass does the same until the
// pass ends (staging c6316d6, 2026-09-30). A real fault persists, so the tries
// span more than a tick plus a full pass. Live and ready get one try, as before.
export const AUTOMATION_PROBE_ATTEMPTS = 6;
export const AUTOMATION_PROBE_WAIT_MS = 30_000;

export async function requireHealthy(read, kind, failure, {
  attempts = kind === "automation" ? AUTOMATION_PROBE_ATTEMPTS : 1,
  wait = () => sleep(AUTOMATION_PROBE_WAIT_MS),
} = {}) {
  for (let attempt = 1; ; attempt++) {
    let error;
    try {
      if (JSON.parse(await read()).ok === true) return;
      error = new Error(failure);
    } catch (thrown) {
      error = thrown;
    }
    if (attempt >= attempts) throw error;
    await wait();
  }
}

export function requireMaintenanceEvidence(plan, evidence, now = Date.now()) {
  for (const target of LEAGUE_TARGETS) {
    const impact = plan.classifications[target.region];
    if (!impact.needs_db_release && !impact.needs_scheduler_pause) continue;
    const record = evidence?.regions?.[target.region];
    if (evidence?.headSha !== plan.sha || record?.baseSha !== plan.bases[target.region].sha ||
        !record?.reviewedBy || now - Date.parse(record.observedAt) > 6 * 60 * 60_000 ||
        !Number.isFinite(Date.parse(record.observedAt)) || Date.parse(record.observedAt) > now)
      throw new Error(`${target.region}: reviewed maintenance evidence for these exact commits is required; see docs/SHARED-LEAGUE-RELEASE.md`);
    if (impact.needs_db_release && (!record.backupVerified || !record.restoreRehearsed || !record.migrationReleasePassed))
      throw new Error(`${target.region}: paired database release prerequisites are incomplete`);
    if (impact.needs_scheduler_pause && (!record.zeroTriggers || !record.quietSlotsVerified || !record.noActiveLease ||
        !Number.isFinite(Date.parse(record.zeroTriggersAt)) || now - Date.parse(record.zeroTriggersAt) < 18.5 * 60_000))
      throw new Error(`${target.region}: scheduler propagation, quiet slots and lease drain must be verified`);
  }
}

export async function runRelease(argv = process.argv.slice(2)) {
  const allowed = new Set(["--apply", "--check", "--preview-only", "--stage-only", "--promote-from", "--maintenance-file", "--output"]);
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!allowed.has(key)) throw new Error(`Unknown release option: ${key}`);
    options[key] = ["--promote-from", "--maintenance-file", "--output"].includes(key) ? argv[++i] : true;
    if (!options[key]) throw new Error(`Missing value for ${key}`);
  }
  const cwd = process.cwd();
  const sha = await command("git", ["rev-parse", "HEAD"], { cwd });
  if (!SHA.test(sha)) throw new Error("Release requires a full Git commit");
  if (await command("git", ["status", "--porcelain", "--untracked-files=no"], { cwd }))
    throw new Error("Commit tracked changes before planning or releasing both leagues");
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const target of LEAGUE_TARGETS)
      if (!process.env[target.tokenEnv]) throw new Error(`Configure ${target.tokenEnv} in GitHub Actions before enabling automatic paired releases`);
    if (options["--maintenance-file"]) throw new Error("Maintenance releases require the operator workflow, not an automatic override");
    const main = await command("git", ["rev-parse", "origin/main"], { cwd });
    if (main !== sha) throw new Error("A newer main commit exists; this superseded release will not deploy");
  }
  const temporary = await createReleaseDirectory();
  const output = path.resolve(options["--output"] || "output/shared-release.json");
  const report = { sha, startedAt: new Date().toISOString(), status: "planning", bases: {}, classifications: {}, candidates: {}, previews: {}, events: [] };
  const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); };
  const envFor = (target) => ({ ...process.env, VERCEL_ORG_ID: VERCEL_TEAM_ID, VERCEL_PROJECT_ID: target.projectId,
    ...(process.env[target.tokenEnv] ? { VERCEL_TOKEN: process.env[target.tokenEnv] } : {}) });
  const providers = new Map(LEAGUE_TARGETS.filter((target) => process.env[target.tokenEnv])
    .map((target) => [target.region, projectProvider(target, process.env[target.tokenEnv])]));
  const api = async (target, endpoint) => providers.has(target.region)
    ? providers.get(target.region).api(endpoint)
    : JSON.parse(await command("npx", ["--yes", CLI, "api", `${endpoint}${endpoint.includes("?") ? "&" : "?"}teamId=${VERCEL_TEAM_ID}`], { cwd, env: envFor(target) }));
  const deployment = (target, id) => api(target, `/v13/deployments/${encodeURIComponent(id)}`);
  const readLive = async (target) => {
    const alias = await api(target, `/v4/aliases/${new URL(target.origin).hostname}`);
    if (alias.projectId !== target.projectId) throw new Error(`${target.region}: canonical domain points to an unexpected project`);
    const d = await deployment(target, alias.deploymentId ?? alias.deployment.id);
    const commit = d.meta?.gitCommitSha ?? d.meta?.githubCommitSha;
    if (!SHA.test(commit ?? "")) throw new Error(`${target.region}: canonical deployment has no immutable Git commit`);
    return { id: d.id, sha: commit, url: d.url };
  };
  const probe = async (target, url, pathname) => {
    if (providers.has(target.region)) return providers.get(target.region).probe(url, pathname);
    return command("npx", ["--yes", CLI, "curl", pathname, "--deployment", url, "--yes", "--", "--fail", "--silent", "--show-error", "--max-time", "45"], { cwd, env: envFor(target) });
  };
  const verify = async (target, d, production) => {
    const actual = await deployment(target, d.id);
    assertDeployment(target, actual, sha, production);
    if (d.url !== actual.url) throw new Error(`${target.region}: recorded deployment URL does not match its identity`);
    const url = `https://${actual.url}`;
    assertReleaseInfo(target, JSON.parse(await probe(target, url, "/api/health/release")), sha);
    for (const kind of ["live", "ready", ...(production && !report.classifications[target.region]?.needs_scheduler_pause ? ["automation"] : [])])
      await requireHealthy(() => probe(target, url, `/api/health/${kind}`), kind, `${target.region}: ${kind} health failed`);
    for (const pathname of ["/", "/schedule"])
      if (!(await probe(target, url, pathname)).includes("GGD2L"))
        throw new Error(`${target.region}: public page smoke check failed`);
  };
  const trustedClassifier = (target) => path.join(temporary, `${target.region}-trusted-classifier.mjs`);
  const coverageRuns = async () => {
    const runs = [];
    for (const { workflow, shardPrefix } of MUTATION_COVERAGE_WORKFLOWS) {
      try {
        const listed = JSON.parse(await command("gh", ["api", `repos/${RELEASE_REPOSITORY}/actions/workflows/${workflow}/runs?branch=main&status=success&per_page=30`]));
        for (const run of listed.workflow_runs ?? []) runs.push({ ...run, workflow, shardPrefix });
      } catch {
        // A workflow that cannot be listed offers no coverage; the release
        // then needs the exact commit's own shards, as it always did.
      }
    }
    return runs;
  };
  const mutationNeutralFrom = async (base) => {
    for (const target of LEAGUE_TARGETS) {
      if (report.classifications[target.region].lane === "unchanged") continue;
      const classification = JSON.parse(await command(process.execPath, [trustedClassifier(target), "--base", base, "--head", sha, "--format", "json"], { cwd }));
      if (classification.needs_mutation !== false) return false;
    }
    return true;
  };
  const worktrees = [];
  try {
    for (const target of LEAGUE_TARGETS) {
      report.bases[target.region] = await readLive(target);
      const base = report.bases[target.region].sha;
      if (base === sha) { report.classifications[target.region] = { lane: "unchanged", needs_db_release: false, needs_scheduler_pause: false }; continue; }
      const classifier = trustedClassifier(target);
      await writeFile(classifier, await command("git", ["show", `${base}:scripts/classify-release.mjs`], { cwd }));
      report.classifications[target.region] = JSON.parse(await command(process.execPath, [classifier, "--base", base, "--head", sha, "--format", "json"], { cwd }));
    }
    await save();
    if (Object.values(report.bases).every((base) => base.sha === sha)) {
      for (const target of LEAGUE_TARGETS) await verify(target, report.bases[target.region], true);
      report.status = "already-current"; await save(); return report;
    }
    let ciRunId = process.env.CI_RUN_ID;
    if (!ciRunId) {
      const runs = JSON.parse(await command("gh", ["api", `repos/${RELEASE_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=20`]));
      ciRunId = runs.workflow_runs?.find((run) => run.head_sha === sha)?.id;
    }
    if (!ciRunId || !/^\d+$/.test(String(ciRunId))) throw new Error("No passing exact-commit CI run found");
    const ciRun = JSON.parse(await command("gh", ["api", `repos/${RELEASE_REPOSITORY}/actions/runs/${ciRunId}`]));
    const ciJobs = JSON.parse(await command("gh", ["api", `repos/${RELEASE_REPOSITORY}/actions/runs/${ciRunId}/jobs?per_page=100`]));
    const gates = requiredCiGates(Object.values(report.classifications));
    const mutationCoverage = await requireReleaseCi(ciRun, ciJobs.jobs, sha, gates, async () =>
      findMutationCoverage(sha, await coverageRuns(), {
        neutral: mutationNeutralFrom,
        jobsFor: async (run) => JSON.parse(await command("gh", ["api", `repos/${RELEASE_REPOSITORY}/actions/runs/${run.id}/jobs?per_page=100`])).jobs ?? [],
      }));
    report.ci = { id: ciRunId, url: ciRun.html_url, sha, conclusion: "success", gates, ...(mutationCoverage ? { mutationCoverage } : {}) };
    report.status = "planned"; await save();
    if (!options["--apply"] && !options["--preview-only"] && !options["--stage-only"] && !options["--promote-from"]) return report;
    const maintenance = options["--maintenance-file"] ? JSON.parse(await readFile(options["--maintenance-file"], "utf8")) : undefined;
    if (maintenance) report.maintenance = maintenance;
    const stage = async (target, production) => {
      const directory = path.join(temporary, `${target.region}-${production ? "production" : "preview"}`);
      await command("git", ["worktree", "add", "--detach", directory, sha], { cwd }); worktrees.push(directory);
      await mkdir(path.join(directory, ".vercel"), { recursive: true });
      await writeFile(path.join(directory, ".vercel/project.json"), JSON.stringify({ orgId: VERCEL_TEAM_ID, projectId: target.projectId, projectName: target.name }));
      const stdout = await command("npx", ["--yes", CLI, "deploy", "--yes", ...cliScopeArgs(target),
        ...(production ? ["--prod", "--skip-domain"] : []),
        "--env", `LEAGUE_RELEASE_SHA=${sha}`, "--build-env", `LEAGUE_RELEASE_SHA=${sha}`], { cwd: directory, env: envFor(target) });
      const url = stdout.match(/https:\/\/[a-z0-9-]+\.vercel\.app\b/)?.[0];
      if (!url) throw new Error(`${target.region}: deployment did not return an address`);
      const d = await deployment(target, new URL(url).hostname);
      await verify(target, d, production);
      return { id: d.id, url: d.url, sha };
    };
    if (options["--promote-from"]) {
      requireMaintenanceEvidence(report, maintenance);
      const staged = JSON.parse(await readFile(options["--promote-from"], "utf8"));
      if (staged.sha !== sha || staged.status !== "staged") throw new Error("Promotion requires a staged paired release at this exact commit");
      for (const target of LEAGUE_TARGETS) {
        if (staged.bases[target.region].id !== report.bases[target.region].id) throw new Error("Production changed since the staged review");
        await verify(target, staged.candidates[target.region], true);
      }
      report.candidates = staged.candidates; report.previews = staged.previews;
    } else {
      // Keep all completed outcomes, even when one region fails. No partial
      // build or rehearsal is eligible for promotion.
      for (const production of [false, true]) {
        if (production) requireMaintenanceEvidence(report, maintenance);
        report.status = production ? "building-production" : "rehearsing-previews"; await save();
        console.log(production ? "Building both staged production candidates." : "Rehearsing both isolated Preview deployments.");
        const results = [];
        for (const target of LEAGUE_TARGETS) {
          try { results.push({ status: "fulfilled", value: await stage(target, production) }); }
          catch (reason) { results.push({ status: "rejected", reason }); }
        }
        results.forEach((result, index) => { if (result.status === "fulfilled") (production ? report.candidates : report.previews)[LEAGUE_TARGETS[index].region] = result.value; });
        report.buildFailures = results.flatMap((result, index) => result.status === "rejected"
          ? [{ region: LEAGUE_TARGETS[index].region, production, error: result.reason.message }] : []);
        await save();
        if (results.some((result) => result.status === "rejected")) throw new Error("A regional build or smoke check failed. Neither production domain was changed.");
        if (!production && options["--preview-only"]) { report.status = "previews-verified"; await save(); return report; }
      }
    }
    report.status = "staged"; await save();
    if (options["--stage-only"]) return report;
    if (process.env.GITHUB_ACTIONS === "true") {
      const remote = await command("git", ["ls-remote", "origin", "refs/heads/main"], { cwd });
      if (remote.split(/\s/)[0] !== sha) throw new Error("A newer main commit exists; staged candidates will not replace production");
    }
    const promote = async (target, id) => {
      if (providers.has(target.region)) await providers.get(target.region).promote(id);
      else await command("npx", ["--yes", CLI, "promote", id, "--yes", ...cliScopeArgs(target)], { cwd, env: envFor(target) });
      for (let attempt = 0; attempt < 12; attempt++) {
        if ((await readLive(target)).id === id) return;
        await sleep(5000);
      }
      throw new Error(`${target.region}: promotion did not become canonical`);
    };
    const promotedAt = Date.now();
    await promotePair({ bases: report.bases, candidates: report.candidates, readLive, promote,
      verify: async (target, d) => {
        if ((await readLive(target)).id !== d.id) throw new Error("Canonical deployment mismatch");
        assertReleaseInfo(target, await (await fetch(`${target.origin}/api/health/release`, { cache: "no-store", signal: AbortSignal.timeout(45_000) })).json(), sha);
        await verify(target, d, true);
      }, finalize: async () => {
        for (const target of LEAGUE_TARGETS) {
          if (report.classifications[target.region].needs_scheduler_pause) continue;
          console.log(`Observing two scheduled automation passes for ${target.region}.`);
          let passes = null;
          for (let attempt = 0; attempt < 12 && !passes; attempt++) {
            let logs;
            if (providers.has(target.region)) logs = await providers.get(target.region).logs(report.candidates[target.region].id, promotedAt);
            else {
              const raw = await command("npx", ["--yes", CLI, "logs", "--project", target.projectId,
                "--deployment", report.candidates[target.region].id, "--since", new Date(promotedAt).toISOString(),
                "--json", "--limit", "100"], { cwd, env: envFor(target) });
              logs = raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
            }
            passes = scheduledPasses(logs, promotedAt);
            if (!passes) await sleep(15_000);
          }
          if (!passes) throw new Error(`${target.region}: two consecutive scheduled successes were not observed`);
          await requireHealthy(() => probe(target, target.origin, "/api/health/automation"), "automation",
            `${target.region}: automation health failed after scheduled passes`);
          report.events.push({ region: target.region, action: "scheduled-passes-verified", timestamps: passes });
        }
      }, record: (event) => report.events.push({ ...event, at: new Date().toISOString() }) });
    report.status = Object.values(report.classifications).some((c) => c.needs_scheduler_pause)
      ? "promoted-awaiting-scheduler-resume" : "verified";
    report.completedAt = new Date().toISOString(); await save();
    return report;
  } catch (error) {
    report.status = "failed"; report.error = error.message; await save(); throw error;
  } finally {
    for (const directory of worktrees) await command("git", ["worktree", "remove", "--force", directory], { cwd }).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runRelease().then((report) => console.log(JSON.stringify({ status: report.status, sha: report.sha, candidates: report.candidates }, null, 2))).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}
