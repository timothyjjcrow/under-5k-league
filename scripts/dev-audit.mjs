// CI's full (dev-inclusive) dependency audit at high and critical, with a
// short checked-in list of advisories it tolerates.
//
//   node scripts/dev-audit.mjs
//
// The "Full dependency audit (high and critical)" step in ci.yml runs this in
// place of `npm audit --audit-level=high`. It runs `npm audit --json` once
// over the whole tree and fails when:
//   - a high or critical advisory is reported that DEV_AUDIT_EXCEPTIONS does
//     not list (matched on its GHSA id AND the package it is in);
//   - a listed advisory now names a vulnerable range other than the one it
//     was judged on (the advisory was edited, often because a fix shipped);
//   - a listed advisory is no longer reported at high or critical, so an
//     exception can't outlive the problem: delete its entry;
//   - npm audit fails, or prints a report this script can't read.
// Lower severities never block here, exactly as with --audit-level=high.
//
// It never covers shipped code. The "Production dependency audit" step runs
// before it, at every severity and with no exceptions, so a listed package
// that reaches a production dependency still fails CI there. The weekly
// dependency-audit.yml run keeps reporting listed advisories too.
//
// An entry is for a dev-only advisory with no patched release, and each one
// has a row in docs/DECISIONS.md. When one goes, move its row to Closed since.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Advisories the dev audit tolerates. Each is matched on `id` and `package`
 * and must still report exactly `range`.
 */
export const DEV_AUDIT_EXCEPTIONS = Object.freeze([
  // Empty since 2026-11-20: GHSA-fc5q-39xc-vjpf (picomatch, listed
  // 2026-11-18) was withdrawn by GitHub on 2026-11-18 and stopped being
  // reported. Its row is in docs/DECISIONS.md under Closed since.
]);

/** Severities that fail this audit, as `--audit-level=high` does. */
export const BLOCKING_SEVERITIES = Object.freeze(["high", "critical"]);
const SEVERITY_ORDER = Object.freeze(["info", "low", "moderate", ...BLOCKING_SEVERITIES]);
const GHSA_IN_URL = /GHSA(?:-[0-9a-z]{4}){3}/i;
// GitHub's own spelling, as advisory URLs print it: GHSA-fc5q-39xc-vjpf.
const GHSA_ID = /^GHSA(?:-[0-9a-z]{4}){3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const blocks = (severity) => BLOCKING_SEVERITIES.includes(severity);
const rank = (severity) => SEVERITY_ORDER.indexOf(severity);
const keyOf = (id, pkg) => `${id} ${pkg}`;

/** Throws unless every exception is complete and listed once. */
export function assertExceptions(exceptions) {
  const seen = new Set();
  for (const entry of exceptions) {
    const where = `DEV_AUDIT_EXCEPTIONS entry ${JSON.stringify(entry?.id ?? null)}`;
    if (typeof entry?.id !== "string" || !GHSA_ID.test(entry.id)) {
      throw new Error(`${where} needs a GHSA id spelled as GitHub does (GHSA-xxxx-xxxx-xxxx, lower case after GHSA).`);
    }
    for (const field of ["package", "range", "reason", "removeWhen"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) throw new Error(`${where} needs a ${field}.`);
    }
    if (typeof entry.added !== "string" || !DATE.test(entry.added)) throw new Error(`${where} needs an added date (YYYY-MM-DD).`);
    const key = keyOf(entry.id, entry.package);
    if (seen.has(key)) throw new Error(`${where} is listed twice for ${entry.package}.`);
    seen.add(key);
  }
}

/**
 * Reads an `npm audit --json` report (auditReportVersion 2) into its
 * advisories, one per advisory and package. Throws on an npm error or a shape
 * it doesn't know, so an unreadable report fails rather than passes.
 */
export function advisoriesIn(report) {
  if (report && typeof report === "object" && report.error) {
    const { code, summary } = report.error;
    throw new Error(`npm audit failed${code ? ` (${code})` : ""}: ${summary || "no summary"}`);
  }
  if (!report || typeof report !== "object" || report.auditReportVersion !== 2) {
    throw new Error(`Not an npm audit report this script can read (auditReportVersion ${JSON.stringify(report?.auditReportVersion ?? null)}, expected 2).`);
  }
  const vulnerabilities = report.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object" || Array.isArray(vulnerabilities)) {
    throw new Error("The npm audit report has no vulnerabilities object.");
  }

  const advisories = new Map();
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!entry || !Array.isArray(entry.via) || rank(entry.severity) < 0) {
      throw new Error(`The npm audit report's entry for ${name} has no severity or via list.`);
    }
    for (const via of entry.via) {
      if (typeof via === "string") continue; // reached through another vulnerable package
      if (!via || typeof via !== "object" || typeof via.name !== "string" || rank(via.severity) < 0) {
        throw new Error(`The npm audit report's entry for ${name} has an advisory without a package or severity.`);
      }
      const ghsa = String(via.url ?? "").match(GHSA_IN_URL)?.[0];
      // An advisory without a GHSA id can't be listed, so it can only block.
      const id = ghsa ? `GHSA${ghsa.slice(4).toLowerCase()}` : `npm advisory ${via.source ?? via.url ?? "(no id)"}`;
      const key = keyOf(id, via.name);
      if (advisories.has(key)) continue;
      advisories.set(key, {
        id,
        package: via.name,
        severity: via.severity,
        range: String(via.range ?? ""),
        title: String(via.title ?? ""),
        url: String(via.url ?? ""),
      });
    }
  }

  // Every package npm rates high or critical must trace back, through the
  // packages it is reached by, to an advisory at that severity. If one
  // doesn't, npm's report has changed under this script: fail closed.
  const highestAdvisoryBehind = (root) => {
    let highest = -1;
    const seen = new Set([root]);
    const queue = [root];
    while (queue.length > 0) {
      for (const via of vulnerabilities[queue.pop()]?.via ?? []) {
        if (typeof via !== "string") highest = Math.max(highest, rank(via.severity));
        else if (!seen.has(via)) {
          seen.add(via);
          queue.push(via);
        }
      }
    }
    return highest;
  };
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (blocks(entry.severity) && highestAdvisoryBehind(name) < rank(entry.severity)) {
      throw new Error(`npm audit rates ${name} ${entry.severity}, but no ${entry.severity} advisory leads to it; this script can't read the report.`);
    }
  }

  return [...advisories.values()].sort((a, b) => keyOf(a.id, a.package).localeCompare(keyOf(b.id, b.package)));
}

/**
 * The audit's verdict over a report. `ok` only when nothing blocks, no listed
 * advisory changed range, and every listed advisory is still reported at high
 * or critical.
 */
export function evaluateDevAudit(report, exceptions = DEV_AUDIT_EXCEPTIONS) {
  assertExceptions(exceptions);
  const advisories = advisoriesIn(report);
  const listed = new Map(exceptions.map((entry) => [keyOf(entry.id, entry.package), entry]));
  const blocking = [];
  const tolerated = [];
  const rangeChanged = [];
  const stillReported = new Set();
  let belowThreshold = 0;
  for (const advisory of advisories) {
    if (!blocks(advisory.severity)) {
      belowThreshold += 1;
      continue;
    }
    const key = keyOf(advisory.id, advisory.package);
    const exception = listed.get(key);
    if (!exception) {
      blocking.push(advisory);
      continue;
    }
    stillReported.add(key);
    if (advisory.range !== exception.range) rangeChanged.push({ advisory, exception });
    else tolerated.push({ advisory, exception });
  }
  const stale = exceptions.filter((entry) => !stillReported.has(keyOf(entry.id, entry.package)));
  return {
    ok: blocking.length === 0 && rangeChanged.length === 0 && stale.length === 0,
    blocking,
    tolerated,
    rangeChanged,
    stale,
    belowThreshold,
  };
}

function annotation(level, message) {
  return `::${level}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;
}

/** The lines the CI step prints for a verdict. */
export function formatDevAudit(result) {
  const lines = [];
  for (const { advisory, exception } of result.tolerated) {
    lines.push(annotation(
      "warning",
      `Tolerated ${advisory.id} (${advisory.severity}) in ${advisory.package} ${advisory.range}, listed ${exception.added} in ` +
        `scripts/dev-audit.mjs. Remove it when ${exception.removeWhen}`,
    ));
  }
  for (const advisory of result.blocking) {
    lines.push(annotation(
      "error",
      `${advisory.id} (${advisory.severity}) in ${advisory.package} ${advisory.range}: ${advisory.title} ${advisory.url}`.trim(),
    ));
  }
  for (const { advisory, exception } of result.rangeChanged) {
    lines.push(annotation(
      "error",
      `${advisory.id} in ${advisory.package} now reports ${advisory.range || "no range"}, not the ${exception.range} it was ` +
        `listed for. Check whether ${advisory.package} has shipped a fix (then update to it and delete the entry); if not, ` +
        `review the advisory and update the entry's range in scripts/dev-audit.mjs.`,
    ));
  }
  for (const exception of result.stale) {
    lines.push(annotation(
      "error",
      `${exception.id} in ${exception.package} is no longer reported at high or critical. Delete its DEV_AUDIT_EXCEPTIONS ` +
        `entry in scripts/dev-audit.mjs and move its docs/DECISIONS.md row to Closed since.`,
    ));
  }
  if (result.blocking.length > 0) {
    lines.push(
      "Fix each advisory above (npm audit shows the paths). Only a dev-only advisory with no patched release may be " +
        "listed in DEV_AUDIT_EXCEPTIONS, with a docs/DECISIONS.md row.",
    );
  }
  const highOrCritical = result.blocking.length + result.tolerated.length + result.rangeChanged.length;
  lines.push(
    `Dev audit: ${highOrCritical} high or critical advisor${highOrCritical === 1 ? "y" : "ies"} ` +
      `(${result.tolerated.length} tolerated), ${result.belowThreshold} lower that don't block here ` +
      `(dependency-audit.yml reports them weekly). ${result.ok ? "Passed." : "Failed."}`,
  );
  return lines;
}

/** Runs `npm audit --json` over the whole tree and returns its parsed report. */
export function runNpmAudit({ spawn = spawnSync } = {}) {
  const run = spawn("npm", ["audit", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  if (run.error) throw new Error(`npm audit could not run: ${run.error.message}`);
  // npm exits 1 whenever it reports anything, so the report, not the status,
  // carries the verdict.
  try {
    return JSON.parse(run.stdout);
  } catch {
    const said = String(run.stderr ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "no output";
    throw new Error(`npm audit printed no JSON report (exit ${run.status ?? run.signal}): ${said}`);
  }
}

function main() {
  try {
    const result = evaluateDevAudit(runNpmAudit());
    for (const line of formatDevAudit(result)) console.log(line);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(annotation("error", error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
