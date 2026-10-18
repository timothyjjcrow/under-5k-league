// A systemd unit's own cgroup as one line of output. The agent's npm ci and
// build units run this as their ExecStopPost=, as the build user: after every
// process of the unit has exited and before systemd removes the cgroup, so
// memory.peak is the whole unit's high-water mark (every process, page cache
// included) and the limits are the ones the kernel actually held it to.
//
// systemd-run --wait's own "Memory peak:" can't be trusted for this on the box.
// systemd 255 (Ubuntu 24.04) saves only the CPU total when it removes a
// finished unit's cgroup (256 saves the memory peak too). After that,
// MemoryPeak, and the journal's "Consumed ..." line, repeat the last value
// anyone read over D-Bus while the cgroup existed. A unit with no stop
// commands goes from running to dead at once, so that was systemd-run's own
// read as the unit started: "Memory peak: 2.4M" for the c5de9952 build
// (2026-10-18), which was held at MemoryHigh with hundreds of MB in swap. The
// stop-post state this adds gives systemd-run one more read, but only by
// timing, so the agent reads this line instead.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CGROUP_REPORT_PREFIX = "ggd2l cgroup:";
const VALUES = Object.freeze(["memory.peak", "memory.swap.peak", "memory.high", "memory.max", "cpu.weight"]);
// memory.events counts since the cgroup was made: times it went over
// memory.high (reclaimed and throttled), times it hit memory.max, OOM kills.
const EVENTS = Object.freeze(["high", "max", "oom_kill"]);

/** The cgroup v2 folder from /proc/self/cgroup's "0::/system.slice/run-u7.service". */
export function ownCgroupDir(procSelfCgroup, root = "/sys/fs/cgroup") {
  const line = procSelfCgroup.split("\n").find((entry) => entry.startsWith("0::/"));
  return line ? path.join(root, line.slice(3)) : null;
}

/** One line, each value as the kernel wrote it ("max" is no limit, "-" unreadable). */
export function cgroupReport(dir, read = (file) => readFileSync(file, "utf8")) {
  const value = (name) => {
    try {
      return read(path.join(dir, name)).trim() || "-";
    } catch {
      return "-";
    }
  };
  const events = new Map(value("memory.events").split("\n").map((line) => line.split(" ")));
  return [
    CGROUP_REPORT_PREFIX,
    ...VALUES.map((name) => `${name}=${value(name)}`),
    ...EVENTS.map((name) => `events.${name}=${events.get(name) ?? "-"}`),
  ].join(" ");
}

/** The memory and swap peaks a report line carries, in MB (null when unknown); null for any other line. */
export function parseCgroupReport(line) {
  if (!line.startsWith(`${CGROUP_REPORT_PREFIX} `)) return null;
  const fields = new Map(line.slice(CGROUP_REPORT_PREFIX.length).trim().split(" ").map((pair) => pair.split("=")));
  const mb = (name) => (/^\d+$/.test(fields.get(name) ?? "") ? Math.round(Number(fields.get(name)) / 1024 ** 2) : null);
  return { peakMb: mb("memory.peak"), swapPeakMb: mb("memory.swap.peak") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let dir = null;
  try {
    dir = ownCgroupDir(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    // No /proc: the line below says so.
  }
  console.log(dir ? cgroupReport(dir) : `${CGROUP_REPORT_PREFIX} unreadable`);
}
