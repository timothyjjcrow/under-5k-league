import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEV_AUDIT_EXCEPTIONS,
  advisoriesIn,
  assertExceptions,
  evaluateDevAudit,
  formatDevAudit,
  runNpmAudit,
} from "./dev-audit.mjs";

// `npm audit --json` for main at cc0c45ed, captured 2026-11-18: picomatch's
// GHSA-fc5q-39xc-vjpf is the one high advisory, and eight more packages are
// rated high only because they reach picomatch.
const CAPTURED = JSON.parse(readFileSync(new URL("./dev-audit.fixture.json", import.meta.url), "utf8"));
const PICOMATCH = "GHSA-fc5q-39xc-vjpf";
const report = () => structuredClone(CAPTURED);

// The entry the shipped list held for that advisory from 2026-11-18 until
// GitHub withdrew it (the list is empty since 2026-11-20). The tests judge
// the captured report against it, so they keep covering a listed advisory
// whatever the shipped list holds.
const PICOMATCH_EXCEPTION = Object.freeze({
  id: PICOMATCH,
  package: "picomatch",
  range: "<=4.0.7",
  added: "2026-11-18",
  reason: "ReDoS in a glob pattern; picomatch reaches the repo only through dev tooling.",
  removeWhen: "picomatch ships a version outside <=4.0.7.",
});
const LISTED = Object.freeze([PICOMATCH_EXCEPTION]);

const advisory = ({ name, url, severity, range = "<1.0.0", source = 1 }) => ({
  source,
  name,
  dependency: name,
  title: `${name} advisory`,
  url,
  severity,
  range,
});

/** Adds a package with its own advisory to a report, as npm prints one. */
function withAdvisory(base, { name, url, severity, range }) {
  base.vulnerabilities[name] = {
    name,
    severity,
    isDirect: false,
    via: [advisory({ name, url, severity, range })],
    effects: [],
    range: "*",
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
  };
  return base;
}

/** The captured report with picomatch's advisory fixed: nothing leads to it. */
function withoutPicomatch() {
  const base = report();
  const reaches = new Set(["picomatch"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, entry] of Object.entries(base.vulnerabilities)) {
      if (!reaches.has(name) && entry.via.some((via) => typeof via === "string" && reaches.has(via))) {
        reaches.add(name);
        grew = true;
      }
    }
  }
  for (const name of reaches) {
    const entry = base.vulnerabilities[name];
    if (!entry) continue;
    entry.via = entry.via.filter((via) => typeof via !== "string" ? via.name !== "picomatch" : !reaches.has(via));
    if (entry.via.length === 0) delete base.vulnerabilities[name];
    else entry.severity = "moderate"; // only moderate advisories are left behind it
  }
  return base;
}

test("the captured report passes with its advisory listed: picomatch tolerated, moderates below the bar", () => {
  const result = evaluateDevAudit(report(), LISTED);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.rangeChanged, []);
  assert.deepEqual(result.tolerated.map(({ advisory: a }) => [a.id, a.package, a.severity, a.range]), [
    [PICOMATCH, "picomatch", "high", "<=4.0.7"],
  ]);
  // @vitest/mocker's two and minimatch's one.
  assert.equal(result.belowThreshold, 3);
  const lines = formatDevAudit(result);
  assert.match(lines[0], /^::warning::Tolerated GHSA-fc5q-39xc-vjpf \(high\) in picomatch <=4\.0\.7, listed 2026-11-18/);
  assert.match(lines.at(-1), /Passed\.$/);
});

test("without the list the captured report fails, as npm audit --audit-level=high does", () => {
  const result = evaluateDevAudit(report(), []);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocking.map((a) => [a.id, a.package]), [[PICOMATCH, "picomatch"]]);
  const lines = formatDevAudit(result);
  assert.ok(lines.some((line) => line.startsWith(`::error::${PICOMATCH} (high) in picomatch <=4.0.7: `)));
  assert.match(lines.at(-1), /Failed\.$/);
});

// GitHub withdrew GHSA-fc5q-39xc-vjpf on 2026-11-18, so the shipped list
// tolerates nothing: a clean report passes, and the captured one fails.
test("the shipped list tolerates nothing a report doesn't need", () => {
  assert.equal(evaluateDevAudit({ ...report(), vulnerabilities: {} }).ok, true);
  const captured = evaluateDevAudit(report());
  assert.equal(captured.ok, false);
  assert.deepEqual(captured.stale, []);
  assert.deepEqual(captured.blocking.map((a) => [a.id, a.package]), [[PICOMATCH, "picomatch"]]);
});

test("a new high or critical advisory anywhere else blocks, while the listed one stays tolerated", () => {
  for (const severity of ["high", "critical"]) {
    const result = evaluateDevAudit(withAdvisory(report(), {
      name: "left-pad",
      url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      severity,
    }), LISTED);
    assert.equal(result.ok, false, severity);
    assert.deepEqual(result.blocking.map((a) => [a.id, a.package, a.severity]), [["GHSA-aaaa-bbbb-cccc", "left-pad", severity]]);
    assert.deepEqual(result.tolerated.map(({ advisory: a }) => a.id), [PICOMATCH]);
  }
});

test("a new low or moderate advisory doesn't block, as with --audit-level=high", () => {
  for (const severity of ["info", "low", "moderate"]) {
    const result = evaluateDevAudit(withAdvisory(report(), {
      name: "left-pad",
      url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      severity,
    }), LISTED);
    assert.equal(result.ok, true, severity);
    assert.equal(result.belowThreshold, 4, severity);
  }
});

test("an exception covers its GHSA id in its package only", () => {
  // A second advisory in picomatch itself.
  const another = report();
  another.vulnerabilities.picomatch.via.push(advisory({
    name: "picomatch",
    url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
    severity: "critical",
    source: 2,
  }));
  another.vulnerabilities.picomatch.severity = "critical";
  const second = evaluateDevAudit(another, LISTED);
  assert.equal(second.ok, false);
  assert.deepEqual(second.blocking.map((a) => [a.id, a.package]), [["GHSA-dddd-eeee-ffff", "picomatch"]]);
  assert.deepEqual(second.tolerated.map(({ advisory: a }) => a.id), [PICOMATCH]);

  // The listed id reported in another package.
  const elsewhere = evaluateDevAudit(withAdvisory(withoutPicomatch(), {
    name: "micromatch",
    url: `https://github.com/advisories/${PICOMATCH}`,
    severity: "high",
    range: "<=4.0.7",
  }), LISTED);
  assert.equal(elsewhere.ok, false);
  assert.deepEqual(elsewhere.blocking.map((a) => [a.id, a.package]), [[PICOMATCH, "micromatch"]]);
  assert.deepEqual(elsewhere.stale.map((entry) => entry.package), ["picomatch"]);
});

test("a listed advisory that is no longer reported fails until its entry is deleted", () => {
  const fixed = withoutPicomatch();
  assert.equal(advisoriesIn(fixed).some((a) => a.package === "picomatch"), false);
  const result = evaluateDevAudit(fixed, LISTED);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.stale.map((entry) => entry.id), [PICOMATCH]);
  assert.ok(formatDevAudit(result).some((line) =>
    line.startsWith(`::error::${PICOMATCH} in picomatch is no longer reported at high or critical.`)));
  // With the entry gone, the same report passes.
  assert.equal(evaluateDevAudit(fixed, []).ok, true);

  // A clean audit is the same case.
  const clean = { ...report(), vulnerabilities: {} };
  assert.deepEqual(evaluateDevAudit(clean, LISTED).stale.map((entry) => entry.id), [PICOMATCH]);
  assert.equal(evaluateDevAudit(clean, []).ok, true);
});

test("a listed advisory downgraded below high is stale too: the gate passes without it", () => {
  const downgraded = report();
  for (const entry of Object.values(downgraded.vulnerabilities)) {
    if (entry.severity === "high") entry.severity = "moderate";
    for (const via of entry.via) if (typeof via !== "string") via.severity = via.severity === "high" ? "moderate" : via.severity;
  }
  const result = evaluateDevAudit(downgraded, LISTED);
  assert.equal(result.ok, false);
  assert.deepEqual(result.stale.map((entry) => entry.id), [PICOMATCH]);
  assert.equal(result.belowThreshold, 4);
});

test("a listed advisory whose vulnerable range changed fails for a review", () => {
  const edited = report();
  edited.vulnerabilities.picomatch.via[0].range = "<4.0.8";
  const result = evaluateDevAudit(edited, LISTED);
  assert.equal(result.ok, false);
  assert.deepEqual(result.tolerated, []);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.rangeChanged.map(({ advisory: a, exception }) => [a.id, a.range, exception.range]), [
    [PICOMATCH, "<4.0.8", "<=4.0.7"],
  ]);
  assert.ok(formatDevAudit(result).some((line) => line.includes("now reports <4.0.8, not the <=4.0.7 it was listed for")));
});

test("a high advisory without a GHSA id can't be listed, so it blocks", () => {
  const result = evaluateDevAudit(withAdvisory(report(), {
    name: "left-pad",
    url: "https://www.npmjs.com/advisories/1234",
    severity: "high",
  }), LISTED);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocking.map((a) => a.id), ["npm advisory 1"]);
});

test("ids read from an advisory URL are compared in GitHub's spelling", () => {
  const shouted = report();
  shouted.vulnerabilities.picomatch.via[0].url = "https://github.com/advisories/GHSA-FC5Q-39XC-VJPF";
  assert.equal(evaluateDevAudit(shouted, LISTED).ok, true);
});

test("an npm error or a report it can't read fails rather than passes", () => {
  assert.throws(
    () => evaluateDevAudit({ error: { code: "ENOTFOUND", summary: "request to https://registry.npmjs.org failed" } }, LISTED),
    /npm audit failed \(ENOTFOUND\): request to https:\/\/registry\.npmjs\.org failed/,
  );
  assert.throws(() => evaluateDevAudit(null, LISTED), /Not an npm audit report/);
  assert.throws(() => evaluateDevAudit({ ...report(), auditReportVersion: 3 }, LISTED), /auditReportVersion 3, expected 2/);
  assert.throws(() => evaluateDevAudit({ auditReportVersion: 2 }, LISTED), /no vulnerabilities object/);

  const noSeverity = report();
  delete noSeverity.vulnerabilities.vite.severity;
  assert.throws(() => evaluateDevAudit(noSeverity, LISTED), /entry for vite has no severity/);

  const unnamed = report();
  delete unnamed.vulnerabilities.picomatch.via[0].name;
  assert.throws(() => evaluateDevAudit(unnamed, LISTED), /entry for picomatch has an advisory without a package/);

  // A package rated critical with nothing critical behind it: npm's report
  // changed under the script.
  const unexplained = report();
  unexplained.vulnerabilities.vite.severity = "critical";
  assert.throws(() => evaluateDevAudit(unexplained, LISTED), /rates vite critical, but no critical advisory leads to it/);

  // A cycle of packages with no advisory behind them.
  const cycle = report();
  cycle.vulnerabilities.a = { name: "a", severity: "high", via: ["b"], effects: ["b"], range: "*", nodes: [], fixAvailable: false };
  cycle.vulnerabilities.b = { name: "b", severity: "high", via: ["a"], effects: ["a"], range: "*", nodes: [], fixAvailable: false };
  assert.throws(() => evaluateDevAudit(cycle, LISTED), /rates a high, but no high advisory leads to it/);
});

test("every shipped exception is complete, and malformed or doubled ones are refused", () => {
  assert.doesNotThrow(() => assertExceptions(DEV_AUDIT_EXCEPTIONS));
  assert.doesNotThrow(() => assertExceptions(LISTED));
  for (const entry of DEV_AUDIT_EXCEPTIONS) {
    assert.ok(Object.isFrozen(entry));
    assert.match(entry.reason, /dev/i, `${entry.id} says why it is dev-only`);
    assert.match(entry.removeWhen, new RegExp(entry.package), `${entry.id} names what ends it`);
  }
  assert.ok(Object.isFrozen(DEV_AUDIT_EXCEPTIONS));

  const good = PICOMATCH_EXCEPTION;
  assert.throws(() => assertExceptions([{ ...good, id: "GHSA-FC5Q-39XC-VJPF" }]), /needs a GHSA id spelled as GitHub does/);
  assert.throws(() => assertExceptions([{ ...good, id: "CVE-2026-0001" }]), /needs a GHSA id/);
  for (const field of ["package", "range", "reason", "removeWhen"]) {
    assert.throws(() => assertExceptions([{ ...good, [field]: " " }]), new RegExp(`needs a ${field}`));
  }
  assert.throws(() => assertExceptions([{ ...good, added: "18 Nov" }]), /needs an added date/);
  assert.throws(() => assertExceptions([good, { ...good }]), /listed twice for picomatch/);
  assert.doesNotThrow(() => assertExceptions([good, { ...good, package: "micromatch" }]));
});

test("it runs npm audit --json once and reads the report whatever npm's exit status", () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 1, stdout: JSON.stringify(CAPTURED), stderr: "" };
  };
  assert.deepEqual(runNpmAudit({ spawn }), CAPTURED);
  assert.deepEqual(calls.map((call) => [call.command, call.args]), [["npm", ["audit", "--json"]]]);

  assert.throws(
    () => runNpmAudit({ spawn: () => ({ status: 1, stdout: "", stderr: "\nnpm error code EAI_AGAIN\n" }) }),
    /npm audit printed no JSON report \(exit 1\): npm error code EAI_AGAIN/,
  );
  assert.throws(
    () => runNpmAudit({ spawn: () => ({ error: new Error("spawn npm ENOENT"), status: null, stdout: null }) }),
    /npm audit could not run: spawn npm ENOENT/,
  );
});
