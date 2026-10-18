import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CGROUP_REPORT_PREFIX, cgroupReport, ownCgroupDir, parseCgroupReport } from "./cgroup-report.mjs";

/** A build unit's cgroup folder as the kernel shows it, values as systemd wrote them. */
function fakeCgroup(files) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "ggd2l-cgroup-")), "system.slice", "run-u7.service");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

const BUILD_FILES = {
  "memory.peak": "1300234240\n",
  "memory.swap.peak": "314572800\n",
  "memory.high": "1258291200\n",
  "memory.max": "1887436800\n",
  "cpu.weight": "20\n",
  "memory.events": "low 0\nhigh 4182\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
};

test("the unit's cgroup folder comes from the cgroup v2 line of /proc/self/cgroup", () => {
  assert.equal(ownCgroupDir("0::/system.slice/run-u7.service\n"), "/sys/fs/cgroup/system.slice/run-u7.service");
  assert.equal(ownCgroupDir("1:name=systemd:/system.slice/x.service\n0::/system.slice/run-u7.service\n", "/cg"), "/cg/system.slice/run-u7.service");
  assert.equal(ownCgroupDir("12:memory:/system.slice/run-u7.service\n"), null, "cgroup v1 only");
});

test("the report is one line of the kernel's own values", () => {
  assert.equal(
    cgroupReport(fakeCgroup(BUILD_FILES)),
    "ggd2l cgroup: memory.peak=1300234240 memory.swap.peak=314572800 memory.high=1258291200 memory.max=1887436800 cpu.weight=20 events.high=4182 events.max=0 events.oom_kill=0",
  );
  // npm ci has no memory limit; a kernel before 6.5 has no memory.swap.peak.
  const { "memory.swap.peak": _, ...older } = BUILD_FILES;
  const line = cgroupReport(fakeCgroup({ ...older, "memory.high": "max\n", "memory.max": "max\n" }));
  assert.match(line, / memory.swap.peak=- memory.high=max memory.max=max /);
  assert.equal(cgroupReport(fakeCgroup({})), `${CGROUP_REPORT_PREFIX} memory.peak=- memory.swap.peak=- memory.high=- memory.max=- cpu.weight=- events.high=- events.max=- events.oom_kill=-`);
});

test("a report parses to MB, and nothing else parses", () => {
  assert.deepEqual(parseCgroupReport(cgroupReport(fakeCgroup(BUILD_FILES))), { peakMb: 1240, swapPeakMb: 300 });
  assert.deepEqual(parseCgroupReport(cgroupReport(fakeCgroup({}))), { peakMb: null, swapPeakMb: null });
  assert.deepEqual(parseCgroupReport(`${CGROUP_REPORT_PREFIX} unreadable`), { peakMb: null, swapPeakMb: null });
  for (const line of ["Memory peak: 2.4M", "Memory peak: 1.5G", `build says ${CGROUP_REPORT_PREFIX} memory.peak=1`, "ggd2l cgroup:memory.peak=1"])
    assert.equal(parseCgroupReport(line), null, line);
});

test("run directly, it prints one report line and exits 0, even with no /proc", () => {
  const script = fileURLToPath(new URL("./cgroup-report.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.ok(parseCgroupReport(lines[0]), lines[0]);
});
