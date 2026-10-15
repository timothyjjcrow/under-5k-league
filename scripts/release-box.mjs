import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RELEASE_REPOSITORY, assertReleaseInfo, promotePair } from "./league-targets.mjs";
import {
  requiredCiGates, requireReleaseCi, findMutationCoverage, MUTATION_COVERAGE_WORKFLOWS, requireMaintenanceEvidence,
  requireHealthy, requireCanonicalRelease, scheduledPasses, createReleaseDirectory, AUTOMATION_PROBE_WAIT_MS,
  CANONICAL_RELEASE_WAIT_MS,
} from "./release-both.mjs";
import { BOX_TARGETS, RELEASE_ID, releaseIdMatches } from "./box-targets.mjs";

// The paired release of both leagues on the self-hosted box (design §2.3,
// `npm run release:both`). It holds no tokens: GitHub reads go through `gh`,
// and every box operation is one call to the box agent over SSH, whose argv
// carries only a verb, a region, a commit, a release id and fixed literals.
// The generic gates are release-both.mjs's and league-targets.mjs's, imported
// unchanged. Nothing here prints or rethrows a child's output: the agent's and
// gh's answers may name private configuration, so errors say which operation
// failed and, for an agent refusal, its fixed code.

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const AGENT = "/usr/local/sbin/ggd2l-agent";
export const DEFAULT_BOX_SSH = "ggd2l-1";
// A host alias from ~/.ssh/config (which pins the host key) or user@host.
// Never an option: a leading "-" would be read by ssh as a flag.
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const AGENT_CODE = /^[a-z][a-z0-9_-]{0,47}$/;
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The agent refuses `retire` within 90 s of a promote, so the old slot stays
// warm for tabs still finishing requests against it.
export const RETIRE_AFTER_MS = 95_000;
// A paused scheduler must leave two whole minute slots without a request.
export const QUIET_WINDOW_MS = 120_000;
export const SCHEDULED_PASS_ATTEMPTS = 12;
export const SCHEDULED_PASS_WAIT_MS = 15_000;

// Every agent call release-box makes, with its argument shapes. A named shape
// is validated; any other entry is a literal that must match exactly.
const ARG_SHAPES = {
  lg: (value) => value === "us" || value === "eu",
  sha: (value) => SHA.test(value),
  id: (value) => RELEASE_ID.test(value),
  since: (value) => /^\d{13}$/.test(value),
};
export const AGENT_VERBS = Object.freeze({
  status: [],
  live: ["lg"],
  deployment: ["id"],
  build: ["lg", "sha"],
  start: ["lg", "id"],
  check: ["lg", "id", "--expect", "production"],
  promote: ["lg", "id"],
  retire: ["lg", "id"],
  prune: ["lg"],
  logs: ["lg", "since"],
  "cron-requests": ["lg", "since"],
  lease: ["lg"],
});
// A build on the 1-vCPU box takes about 4-8 minutes; start and promote wait up
// to 90 s for a slot to come up.
const AGENT_TIMEOUT_MS = { build: 40 * 60_000, start: 5 * 60_000, check: 5 * 60_000, promote: 5 * 60_000 };

export function boxSshAlias(env = process.env) {
  const alias = env.GGD2L_BOX_SSH || DEFAULT_BOX_SSH;
  if (!SSH_ALIAS.test(alias)) throw new Error("GGD2L_BOX_SSH must be a plain SSH host alias");
  return alias;
}

export function agentArgv(alias, verb, args) {
  if (!SSH_ALIAS.test(alias)) throw new Error("GGD2L_BOX_SSH must be a plain SSH host alias");
  if (!Object.hasOwn(AGENT_VERBS, verb)) throw new Error("release-box: unknown box agent verb");
  const shape = AGENT_VERBS[verb];
  const valid = args.length === shape.length && shape.every((entry, i) =>
    typeof args[i] === "string" && (Object.hasOwn(ARG_SHAPES, entry) ? ARG_SHAPES[entry](args[i]) : args[i] === entry));
  const lg = args[shape.indexOf("lg")];
  const id = args[shape.indexOf("id")];
  if (!valid || (lg !== undefined && id !== undefined && !id.startsWith(`${lg}-`)))
    throw new Error(`release-box: box agent ${verb} was given an argument outside its contract`);
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", alias, "sudo", "-n", AGENT, verb, ...args];
}

// Exactly one JSON value on stdout: an object, or for `logs` an array. A
// refusal is {ok:false, code}; only a code of the agent's fixed shape is
// repeated. A banner, a second line or any non-JSON byte is a contract breach.
export function parseAgentOutput(verb, stdout, status = 0) {
  let value;
  try { value = JSON.parse(stdout); } catch { value = undefined; }
  const object = value !== null && typeof value === "object" && !Array.isArray(value);
  if (object && value.ok === false) {
    const code = typeof value.code === "string" && AGENT_CODE.test(value.code) ? ` (${value.code})` : "";
    throw new Error(`box agent ${verb} refused${code}`);
  }
  if (status !== 0) throw new Error(`box agent ${verb} failed (${Number.isInteger(status) ? `exit ${status}` : "no exit status"})`);
  if (verb === "logs" ? !Array.isArray(value) : !object)
    throw new Error(`box agent ${verb} returned output outside its JSON contract`);
  return value;
}

/** Runs a command and resolves {status, stdout}; never rejects, never shows stderr. */
export function spawnRunner(file, args, { cwd, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status, stdout) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ status, stdout }); } };
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) child.kill("SIGTERM");
      else chunks.push(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("error", () => finish(null, ""));
    child.on("close", (code) => finish(size > 32 * 1024 * 1024 ? null : code, Buffer.concat(chunks).toString("utf8")));
  });
}

export function createAgent(run, alias) {
  return async (verb, ...args) => {
    const argv = agentArgv(alias, verb, args.map(String));
    const { status, stdout } = await run("ssh", argv, { timeout: AGENT_TIMEOUT_MS[verb] ?? 120_000 });
    return parseAgentOutput(verb, stdout, status);
  };
}

async function command(run, file, args, options) {
  const { status, stdout } = await run(file, args, options);
  if (status !== 0) throw new Error(`${path.basename(file)} ${args[0] ?? ""} failed`);
  return stdout.trim();
}

// JSON.parse's SyntaxError quotes the input; name the source instead.
function parseJson(text, source) {
  try { return JSON.parse(text); } catch { throw new Error(`${source} did not return JSON`); }
}

/** The public release probe through Cloudflare: league, commit, origin and the production marker. */
export function assertBoxRelease(target, info, sha) {
  assertReleaseInfo(target, info, sha);
  if (info.site !== target.origin || info.deployEnv !== "production")
    throw new Error(`${target.region}: the site does not report its canonical origin and the production deploy marker`);
}

function liveRelease(target, live) {
  if (!SHA.test(live.sha ?? "") || !releaseIdMatches(target, live.id, live.sha) ||
      !Object.hasOwn(target.slots, live.slot ?? "") || target.slots[live.slot] !== live.port)
    throw new Error(`${target.region}: the box's live pointer is outside its contract`);
  return { id: live.id, sha: live.sha, slot: live.slot, port: live.port };
}

// Rows of `agent logs`: Caddy request rows (5xx as level "error") and journal
// warnings, whose status and path may be null. Timestamps are epoch ms, which
// scheduledPasses compares with numbers.
function logRows(target, rows) {
  const valid = rows.every((row) => row !== null && typeof row === "object" && typeof row.id === "string" &&
    Number.isFinite(row.timestamp) && typeof row.level === "string" &&
    (row.responseStatusCode === null || Number.isInteger(row.responseStatusCode)) &&
    (row.requestPath === null || typeof row.requestPath === "string"));
  if (!valid) throw new Error(`${target.region}: box agent logs rows are outside their contract`);
  return rows;
}

/** Design §2.3: releases run 07:00-19:00 UTC, never during a match night, inhouse night or draft. */
export function releaseWindowOpen(now) {
  const hour = new Date(now).getUTCHours();
  return hour >= 7 && hour < 19;
}

/** backups/release-<date>/, then release-<date>b, c and so on for later runs that day. */
export async function createEvidenceDirectory(root, now) {
  await mkdir(root, { recursive: true });
  const date = new Date(now).toISOString().slice(0, 10);
  for (const suffix of ["", ..."bcdefghijklmnopqrstuvwxyz"]) {
    const directory = path.join(root, `release-${date}${suffix}`);
    try {
      await mkdir(directory);
      return directory;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Too many release evidence directories for one day");
}

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--check" || key === "--apply" || key === "--outside-window") options[key] = true;
    else if (key === "--maintenance-file") {
      options[key] = argv[++i];
      if (!options[key] || options[key].startsWith("--")) throw new Error(`Missing value for ${key}`);
    } else throw new Error(`Unknown release option: ${key}`);
  }
  if (options["--check"] && options["--apply"]) throw new Error("Choose --check or --apply, not both");
  // Without --apply the run only plans, so a maintenance file would be
  // neither read nor used: a paused scheduler would wait on a release that
  // never happens.
  if (options["--maintenance-file"] && !options["--apply"])
    throw new Error("--maintenance-file is used only by a release: npm run release:both -- --apply --maintenance-file <file>");
  return options;
}

function renderRecord(report) {
  const lines = [`# Box release ${report.sha.slice(0, 12)}`, "", `- Commit: \`${report.sha}\``, `- Status: ${report.status}`,
    `- Box: ${report.box}`, `- Started: ${report.startedAt}`, ...(report.completedAt ? [`- Completed: ${report.completedAt}`] : []),
    ...(report.ci ? [`- CI: ${report.ci.url ?? report.ci.id}`] : []), ...(report.error ? [`- Error: ${report.error}`] : []),
    "", "| League | Lane | Base | Candidate | Build s | Peak RSS MB |", "| --- | --- | --- | --- | --- | --- |"];
  for (const target of BOX_TARGETS) {
    const base = report.bases[target.region];
    const candidate = report.candidates[target.region];
    lines.push(`| ${target.region} | ${report.classifications[target.region]?.lane ?? "-"} | ${base?.id ?? "-"} | ${candidate?.id ?? "-"} | ` +
      `${candidate?.buildSeconds ?? "-"} | ${candidate?.peakRssMb ?? "-"} |`);
  }
  if (report.events.length) lines.push("", "## Events", "", ...report.events.map((event) =>
    `- ${event.at ?? ""} ${event.region ?? ""} ${event.action}${event.deploymentId ? ` ${event.deploymentId}` : ""}${event.message ? `: ${event.message}` : ""}`.trim()));
  if (report.cleanupProblems.length) lines.push("", "## Cleanup to finish by hand", "", ...report.cleanupProblems.map((problem) => `- ${problem}`));
  return lines.join("\n") + "\n";
}

const defaultFetchText = async (url) =>
  (await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(45_000) })).text();

export async function runBoxRelease(argv = process.argv.slice(2), {
  run = spawnRunner, fetchText = defaultFetchText, now = Date.now, sleep = sleepFor, cwd = process.cwd(),
  env = process.env, log = console.log, evidenceRoot = path.join(cwd, "backups"),
} = {}) {
  const options = parseOptions(argv);
  if (env.GITHUB_ACTIONS === "true") throw new Error("release-box runs from the operator's machine, never from a workflow");
  const alias = boxSshAlias(env);
  const agent = createAgent(run, alias);
  const git = (...args) => command(run, "git", args, { cwd });
  const gh = async (endpoint) => parseJson(await command(run, "gh", ["api", endpoint], { cwd }), "gh api");

  const sha = await git("rev-parse", "HEAD");
  if (!SHA.test(sha)) throw new Error("Release requires a full Git commit");
  if (await git("status", "--porcelain", "--untracked-files=no"))
    throw new Error("Commit tracked changes before planning or releasing both leagues");
  await git("fetch", "--quiet", "origin", "main");
  if ((await run("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { cwd })).status !== 0)
    throw new Error("Release requires a commit on origin/main");

  const iso = (ms = now()) => new Date(ms).toISOString();
  const evidence = await createEvidenceDirectory(evidenceRoot, now());
  const report = { sha, startedAt: iso(), status: "planning", box: alias, evidence, bases: {}, classifications: {},
    candidates: {}, events: [], cleanupProblems: [] };
  const record = (event) => report.events.push({ ...event, at: iso() });
  const write = (name, value) => writeFile(path.join(evidence, name), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  const save = async () => { await write("shared-release.json", report); await write("record.md", renderRecord(report)); };
  const temporary = await createReleaseDirectory();
  const paused = (target) => report.classifications[target.region]?.needs_scheduler_pause === true;
  const readLive = async (target) => liveRelease(target, await agent("live", target.region));
  // The public probe through Cloudflare, read until it reports `expected`.
  const readRelease = (target, expected) => async () => {
    const text = await fetchText(`${target.origin}/api/health/release`);
    assertBoxRelease(target, JSON.parse(text), expected);
    return text;
  };
  // Regions whose candidate slot may be running. A region joins before
  // `start` (a start that times out or loses its answer may still have
  // started the idle slot) and before `promote` (which restarts the slot
  // clean), and leaves once its candidate is retired.
  const running = new Set();
  let lastPromoteAt = null;
  const settleRetireWindow = async () => {
    const wait = lastPromoteAt === null ? 0 : lastPromoteAt + RETIRE_AFTER_MS - now();
    if (wait > 0) { log(`Waiting ${Math.ceil(wait / 1000)} s before retiring old slots.`); await sleep(wait); }
  };
  const retire = async (target, id) => {
    try {
      await agent("retire", target.region, id);
      record({ region: target.region, action: "retired", deploymentId: id });
    } catch (error) {
      report.cleanupProblems.push(`${target.region}: retire ${id} (${error.message})`);
    }
  };
  // The agent's cron-requests and lease reads are the scheduler-pause proof:
  // nothing reached /api/cron/automation in the last two minute slots, and no
  // automation lease is held.
  const requireQuietWindows = async (targets) => {
    for (const target of targets) {
      const since = now() - QUIET_WINDOW_MS;
      const requests = await agent("cron-requests", target.region, String(since));
      if (requests.count !== 0) throw new Error(`${target.region}: the paused scheduler still reached the site`);
      const lease = await agent("lease", target.region);
      if (lease.leaseOwner !== null || lease.leaseExpiresAt !== null) throw new Error(`${target.region}: an automation lease is still held`);
      record({ region: target.region, action: "quiet-window-verified", message: `no scheduler request since ${iso(since)}; no lease` });
    }
  };
  // The agent's promote, and the rollback's, write the proxy mode file, so a
  // release would open a league held in allowlist mode (a cutover gate) or
  // close maintenance mode. A release never changes who can reach a league.
  const requireProxyMode = async (targets) => {
    const status = await agent("status");
    for (const target of targets) {
      if (status.leagues?.[target.region]?.mode !== "proxy")
        throw new Error(`${target.region}: the box is not serving the league in proxy mode; release:both never changes who can reach a league`);
    }
    record({ action: "proxy-mode-verified", message: targets.map((target) => target.region).join(", ") });
  };

  try {
    for (const target of BOX_TARGETS) {
      const base = await readLive(target);
      report.bases[target.region] = base;
      // Cloudflare must serve the box's live release, with its own origin and
      // the production marker, before anything is compared with it.
      await requireCanonicalRelease(readRelease(target, base.sha), target, base.sha, { attempts: 1, consecutive: 1 });
      if (base.sha === sha) {
        report.classifications[target.region] = { lane: "unchanged", needs_db_release: false, needs_scheduler_pause: false };
        continue;
      }
      // The classifier comes from the LIVE commit, never the candidate.
      const classifier = path.join(temporary, `${target.region}-trusted-classifier.mjs`);
      await writeFile(classifier, await git("show", `${base.sha}:scripts/classify-release.mjs`));
      report.classifications[target.region] = parseJson(await command(run, process.execPath,
        [classifier, "--base", base.sha, "--head", sha, "--format", "json"], { cwd }), "the trusted classifier");
    }
    // Only the leagues whose live commit differs are built and promoted.
    const changed = BOX_TARGETS.filter((target) => report.bases[target.region].sha !== sha);
    if (changed.length === 0) {
      report.status = "already-current"; report.completedAt = iso(); await write("plan.json", report); await save();
      return report;
    }
    await requireProxyMode(changed);

    let ciRunId = env.CI_RUN_ID;
    if (!ciRunId) {
      const runs = await gh(`repos/${RELEASE_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=20`);
      ciRunId = runs.workflow_runs?.find((r) => r.head_sha === sha)?.id;
    }
    if (!ciRunId || !/^\d+$/.test(String(ciRunId))) throw new Error("No passing exact-commit CI run found");
    const ciRun = await gh(`repos/${RELEASE_REPOSITORY}/actions/runs/${ciRunId}`);
    const ciJobs = await gh(`repos/${RELEASE_REPOSITORY}/actions/runs/${ciRunId}/jobs?per_page=100`);
    const gates = requiredCiGates(Object.values(report.classifications));
    const coverageRuns = async () => {
      const runs = [];
      for (const { workflow, shardPrefix } of MUTATION_COVERAGE_WORKFLOWS) {
        try {
          const listed = await gh(`repos/${RELEASE_REPOSITORY}/actions/workflows/${workflow}/runs?branch=main&status=success&per_page=30`);
          for (const r of listed.workflow_runs ?? []) runs.push({ ...r, workflow, shardPrefix });
        } catch {
          // A workflow that cannot be listed offers no coverage.
        }
      }
      return runs;
    };
    const mutationNeutralFrom = async (from) => {
      for (const target of changed) {
        const classification = parseJson(await command(run, process.execPath,
          [path.join(temporary, `${target.region}-trusted-classifier.mjs`), "--base", from, "--head", sha, "--format", "json"], { cwd }),
          "the trusted classifier");
        if (classification.needs_mutation !== false) return false;
      }
      return true;
    };
    const mutationCoverage = await requireReleaseCi(ciRun, ciJobs.jobs ?? [], sha, gates, async () =>
      findMutationCoverage(sha, await coverageRuns(), {
        neutral: mutationNeutralFrom,
        jobsFor: async (r) => (await gh(`repos/${RELEASE_REPOSITORY}/actions/runs/${r.id}/jobs?per_page=100`)).jobs ?? [],
      }));
    report.ci = { id: ciRunId, url: ciRun.html_url, sha, conclusion: "success", gates, ...(mutationCoverage ? { mutationCoverage } : {}) };
    report.maintenanceRegions = changed.filter((t) => report.classifications[t.region].needs_db_release || paused(t)).map((t) => t.region);
    report.status = "planned";
    await write("plan.json", report); await save();
    if (!options["--apply"]) {
      log("Planned only; nothing on the box changed. To release: npm run release:both -- --apply");
      return report;
    }

    if (!releaseWindowOpen(now()) && !options["--outside-window"])
      throw new Error("Releases run 07:00-19:00 UTC, never during a match night, inhouse night or draft; pass --outside-window only for a reviewed emergency");
    const maintenance = options["--maintenance-file"]
      ? parseJson(await readFile(options["--maintenance-file"], "utf8"), "the maintenance file") : undefined;
    requireMaintenanceEvidence(report, maintenance, now());
    if (maintenance) report.maintenance = maintenance;
    await requireQuietWindows(changed.filter(paused));

    // Memory on the 2 GB box: every changed league is built before any
    // candidate starts, and each checked candidate is stopped before the next
    // league's starts (the agent's promote restarts it clean anyway), so until
    // the promotions at most three Next processes run: the two live slots and
    // one candidate. From the Europe promote until the old slots retire, each
    // league's previous slot stays warm for in-flight requests (the agent
    // refuses retire for 90 s after a promote), so four run then, two of them
    // idle.
    report.status = "building"; await save();
    for (const target of changed) {
      log(`Building ${target.region} at ${sha.slice(0, 12)} on the box.`);
      const built = await agent("build", target.region, sha);
      if (!releaseIdMatches(target, built.id, sha)) throw new Error(`${target.region}: the box built a release outside the reviewed commit`);
      const deployment = await agent("deployment", built.id);
      if (deployment.id !== built.id || deployment.sha !== sha || deployment.region !== target.region || deployment.state !== "BUILT")
        throw new Error(`${target.region}: the built release does not match the reviewed commit`);
      // The agent's `deployment` answer carries no build-log hash yet; the
      // manifest records one only when the agent sends it.
      report.candidates[target.region] = { id: built.id, sha, buildSeconds: built.buildSeconds ?? null, peakRssMb: built.peakRssMb ?? null,
        node: deployment.node ?? null, buildLogSha256: SHA256.test(deployment.buildLogSha256 ?? "") ? deployment.buildLogSha256 : null };
      record({ region: target.region, action: "built", deploymentId: built.id });
      await save();
    }
    report.status = "checking-candidates"; await save();
    for (const target of changed) {
      const candidate = report.candidates[target.region];
      running.add(target.region);
      const slot = await agent("start", target.region, candidate.id);
      if (!Object.hasOwn(target.slots, slot.slot ?? "") || target.slots[slot.slot] !== slot.port || slot.slot === report.bases[target.region].slot)
        throw new Error(`${target.region}: the candidate did not start in the idle slot`);
      Object.assign(candidate, { slot: slot.slot, port: slot.port });
      const checked = await agent("check", target.region, candidate.id, "--expect", "production");
      if (checked.ok !== true) throw new Error(`${target.region}: the candidate failed the box smoke check`);
      record({ region: target.region, action: "candidate-checked", deploymentId: candidate.id });
      // Legal before any promote: `start` already refused the warm window.
      await agent("retire", target.region, candidate.id);
      running.delete(target.region);
      record({ region: target.region, action: "candidate-stopped", deploymentId: candidate.id });
      await save();
    }
    await requireQuietWindows(changed.filter(paused));
    await requireProxyMode(changed);

    report.status = "promoting"; await save();
    const promotedAt = {};
    await promotePair({
      targets: changed, bases: report.bases, candidates: report.candidates, readLive, record,
      promote: async (target, id) => {
        log(`Promoting ${target.region} to ${id}.`);
        // Set before the call too: a promote whose answer is lost may still
        // have swapped and restarted the slot, and the retire window and the
        // failure path's cleanup must cover it.
        running.add(target.region);
        lastPromoteAt = now();
        const result = await agent("promote", target.region, id);
        lastPromoteAt = promotedAt[target.region] = now();
        if (result.id !== id) throw new Error(`${target.region}: the box did not confirm the promotion`);
      },
      verify: async (target, candidate) => {
        if ((await readLive(target)).id !== candidate.id) throw new Error(`${target.region}: the box's live release is not the candidate`);
        await requireCanonicalRelease(readRelease(target, sha), target, sha, { wait: () => sleep(CANONICAL_RELEASE_WAIT_MS) });
        for (const kind of ["live", "ready", ...(paused(target) ? [] : ["automation"])])
          await requireHealthy(() => fetchText(`${target.origin}/api/health/${kind}`), kind, `${target.region}: ${kind} health failed`,
            { wait: () => sleep(AUTOMATION_PROBE_WAIT_MS) });
      },
      // Two scheduled passes answered 200 through Caddy, 30-90 s apart, and no
      // error row (a 5xx anywhere on the host) since this league's promote.
      finalize: async () => {
        for (const target of changed) {
          if (paused(target)) continue;
          log(`Observing two scheduled automation passes for ${target.region}.`);
          const since = promotedAt[target.region];
          let passes = null;
          for (let attempt = 0; attempt < SCHEDULED_PASS_ATTEMPTS && !passes; attempt++) {
            passes = scheduledPasses(logRows(target, await agent("logs", target.region, String(since))), since);
            if (!passes) await sleep(SCHEDULED_PASS_WAIT_MS);
          }
          if (!passes) throw new Error(`${target.region}: two consecutive scheduled successes were not observed`);
          await requireHealthy(() => fetchText(`${target.origin}/api/health/automation`), "automation",
            `${target.region}: automation health failed after scheduled passes`, { wait: () => sleep(AUTOMATION_PROBE_WAIT_MS) });
          record({ region: target.region, action: "scheduled-passes-verified", message: passes.join(", ") });
        }
      },
    });
    report.status = changed.some(paused) ? "promoted-awaiting-scheduler-resume" : "verified";
    await save();

    // The previous slots stay warm for RETIRE_AFTER_MS, then stop. Cleanup
    // failures leave the release in place and are listed for the operator.
    await settleRetireWindow();
    for (const target of changed) await retire(target, report.bases[target.region].id);
    for (const target of changed) {
      try {
        const pruned = await agent("prune", target.region);
        const removed = Array.isArray(pruned.removed?.releases) ? pruned.removed.releases.length : null;
        record({ region: target.region, action: "pruned",
          message: removed === null ? "removed releases not reported" : `${removed} old release${removed === 1 ? "" : "s"} removed` });
      } catch (error) {
        report.cleanupProblems.push(`${target.region}: prune (${error.message})`);
      }
    }
    // The agent's `status` answer carries no Caddy config hash yet; the
    // manifest records one only when the agent sends it.
    let caddyConfigSha256 = null;
    try {
      const status = await agent("status");
      if (SHA256.test(status.caddyConfigSha256 ?? "")) caddyConfigSha256 = status.caddyConfigSha256;
    } catch (error) {
      report.cleanupProblems.push(`status (${error.message})`);
    }
    await write("box-manifest.json", {
      sha, box: alias, caddyConfigSha256,
      regions: Object.fromEntries(changed.map((target) => [target.region, { base: report.bases[target.region], candidate: report.candidates[target.region] }])),
    });
    report.completedAt = iso(); await save();
    return report;
  } catch (error) {
    report.status = "failed"; report.error = error.message;
    // A candidate that is not live would hold about 0.4 GB on the 2 GB box.
    // Stop it, once any promote's warm window has passed; the journal keeps
    // its logs. A live candidate (a rollback that did not land) stays.
    const left = BOX_TARGETS.filter((target) => running.has(target.region));
    if (left.length) {
      await settleRetireWindow();
      for (const target of left) {
        const id = report.candidates[target.region].id;
        try {
          if ((await readLive(target)).id !== id) await retire(target, id);
          else report.cleanupProblems.push(`${target.region}: candidate ${id} is live; operator review required`);
        } catch (readError) {
          report.cleanupProblems.push(`${target.region}: candidate ${id} left running (${readError.message})`);
        }
      }
    }
    await save().catch(() => {});
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runBoxRelease().then((report) => {
    console.log(JSON.stringify({ status: report.status, sha: report.sha, evidence: report.evidence, candidates: report.candidates }, null, 2));
    if (report.cleanupProblems.length) console.error(`Cleanup to finish by hand: ${report.cleanupProblems.join("; ")}`);
  }).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}
