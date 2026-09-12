import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LEAGUE_TARGETS, VERCEL_TEAM_ID, VERCEL_SCOPE, RELEASE_REPOSITORY, assertDeployment, assertReleaseInfo, promotePair } from "./league-targets.mjs";

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const CLI = "vercel@59.11.7";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(file, args, options = {}) {
  try {
    return (await exec(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000, ...options })).stdout.trim();
  } catch {
    // Provider output may contain private configuration. Report the operation,
    // never command arguments, credential values or captured response bodies.
    throw new Error(`${file} ${args[0] ?? ""} failed; inspect the provider's build or workflow logs`);
  }
}

export function requireSuccessfulCi(run, jobs, sha, strict) {
  if (run.head_sha !== sha || run.status !== "completed" || run.conclusion !== "success")
    throw new Error("A successful completed CI run for the exact release commit is required");
  const required = ["classify release impact", "audit, lint, types, build, tests", "playwright e2e (us)", "playwright e2e (eu)"];
  if (strict) required.push("integration on postgres", ...[1, 2, 3, 4].map((n) => `mutation guard ${n}/4`));
  for (const name of required) {
    if (!jobs.some((job) => job.name === name && job.conclusion === "success" && job.status === "completed"))
      throw new Error(`Required CI job did not pass: ${name}`);
  }
}

export function scheduledPasses(logs, since) {
  const recent = logs.filter((log) => log.timestamp >= since);
  if (recent.some((log) => log.level === "error" || log.level === "fatal" || log.responseStatusCode >= 500))
    throw new Error("Fresh runtime errors require release review");
  const attempts = recent.filter((log) => log.requestPath === "/api/cron/automation")
    .sort((a, b) => a.timestamp - b.timestamp);
  const last = attempts.slice(-2);
  return last.length === 2 && last.every((log) => log.responseStatusCode === 200) &&
    last[1].timestamp - last[0].timestamp >= 30_000 && last[1].timestamp - last[0].timestamp <= 90_000
    ? last.map((log) => new Date(log.timestamp).toISOString()) : null;
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
  const temporary = await mkdtemp(path.join(tmpdir(), "ggd2l-shared-release-"));
  const output = path.resolve(options["--output"] || "output/shared-release.json");
  const report = { sha, startedAt: new Date().toISOString(), status: "planning", bases: {}, classifications: {}, candidates: {}, previews: {}, events: [] };
  const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); };
  const envFor = (target) => ({ ...process.env, VERCEL_ORG_ID: VERCEL_TEAM_ID, VERCEL_PROJECT_ID: target.projectId,
    ...(process.env[target.tokenEnv] ? { VERCEL_TOKEN: process.env[target.tokenEnv] } : {}) });
  const api = async (target, endpoint) => JSON.parse(await command("npx", ["--yes", CLI, "api", `${endpoint}${endpoint.includes("?") ? "&" : "?"}teamId=${VERCEL_TEAM_ID}`], { cwd, env: envFor(target) }));
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
    return command("npx", ["--yes", CLI, "curl", pathname, "--deployment", url, "--yes", "--", "--fail", "--silent", "--show-error", "--max-time", "45"], { cwd, env: envFor(target) });
  };
  const verify = async (target, d, production) => {
    assertDeployment(target, await deployment(target, d.id), sha, production);
    const url = `https://${d.url}`;
    assertReleaseInfo(target, JSON.parse(await probe(target, url, "/api/health/release")), sha);
    for (const kind of ["live", "ready", ...(production && !report.classifications[target.region]?.needs_scheduler_pause ? ["automation"] : [])])
      if (JSON.parse(await probe(target, url, `/api/health/${kind}`)).ok !== true)
        throw new Error(`${target.region}: ${kind} health failed`);
    for (const pathname of ["/", "/schedule"])
      if (!(await probe(target, url, pathname)).includes("GGD2L"))
        throw new Error(`${target.region}: public page smoke check failed`);
  };
  const worktrees = [];
  try {
    for (const target of LEAGUE_TARGETS) {
      report.bases[target.region] = await readLive(target);
      const base = report.bases[target.region].sha;
      if (base === sha) { report.classifications[target.region] = { lane: "unchanged", needs_db_release: false, needs_scheduler_pause: false }; continue; }
      const classifier = path.join(temporary, `${target.region}-trusted-classifier.mjs`);
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
    requireSuccessfulCi(ciRun, ciJobs.jobs, sha, Object.values(report.classifications).some((c) => c.lane !== "ui-only" && c.lane !== "unchanged"));
    report.ci = { id: ciRunId, url: ciRun.html_url, sha, conclusion: "success" };
    report.status = "planned"; await save();
    if (!options["--apply"] && !options["--preview-only"] && !options["--stage-only"] && !options["--promote-from"]) return report;
    const maintenance = options["--maintenance-file"] ? JSON.parse(await readFile(options["--maintenance-file"], "utf8")) : undefined;
    if (maintenance) report.maintenance = maintenance;
    const stage = async (target, production) => {
      const directory = path.join(temporary, `${target.region}-${production ? "production" : "preview"}`);
      await command("git", ["worktree", "add", "--detach", directory, sha], { cwd }); worktrees.push(directory);
      await mkdir(path.join(directory, ".vercel"), { recursive: true });
      await writeFile(path.join(directory, ".vercel/project.json"), JSON.stringify({ orgId: VERCEL_TEAM_ID, projectId: target.projectId, projectName: target.name }));
      const stdout = await command("npx", ["--yes", CLI, "deploy", "--yes", "--scope", VERCEL_SCOPE,
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
      await command("npx", ["--yes", CLI, "promote", id, "--yes", "--scope", VERCEL_SCOPE], { cwd, env: envFor(target) });
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
            const raw = await command("npx", ["--yes", CLI, "logs", "--project", target.projectId,
              "--deployment", report.candidates[target.region].id, "--since", new Date(promotedAt).toISOString(),
              "--json", "--limit", "100"], { cwd, env: envFor(target) });
            const logs = raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
            passes = scheduledPasses(logs, promotedAt);
            if (!passes) await sleep(15_000);
          }
          if (!passes) throw new Error(`${target.region}: two consecutive scheduled successes were not observed`);
          if (JSON.parse(await probe(target, target.origin, "/api/health/automation")).ok !== true)
            throw new Error(`${target.region}: automation health failed after scheduled passes`);
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
