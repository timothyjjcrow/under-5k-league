// `status`: the monthly one-liner (design §5.2). Read-only.
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { caddyConfigSha256, readModeFile } from "./caddy-modes.mjs";
import { BIN, LEAGUES, SLOTS, unitName } from "./layout.mjs";
import { serverErrorCount } from "./logs.mjs";
import { readLive, slotTarget } from "./releases.mjs";
import { newestDump, readBackupRecord } from "./tools.mjs";

const DAY_MS = 24 * 60 * 60_000;

export const STATUS_UNITS = Object.freeze([
  ...LEAGUES.flatMap((lg) => SLOTS.map((slot) => unitName(lg, slot))),
  "caddy.service",
  "cloudflared-ggd2l.service",
  "postgresql@18-main.service",
  "ggd2l-bot.service",
  "ggd2l-heartbeat.timer",
  ...LEAGUES.flatMap((lg) => [
    `ggd2l-backup@${lg}.timer`,
    `ggd2l-backup@${lg}.service`,
    `ggd2l-drill@${lg}.timer`,
    `ggd2l-drill@${lg}.service`,
  ]),
]);

/** Parse `systemctl show` output for several units (blank-line separated blocks). */
export function parseShow(text) {
  const units = {};
  for (const block of text.split(/\n\s*\n/)) {
    const props = {};
    for (const line of block.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (props.Id) units[props.Id] = props;
  }
  return units;
}

export function parseMeminfo(text) {
  const kb = (key) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  const mb = (value) => (value === null ? null : Math.round(value / 1024));
  const swapTotal = kb("SwapTotal");
  const swapFree = kb("SwapFree");
  return {
    totalMb: mb(kb("MemTotal")),
    availableMb: mb(kb("MemAvailable")),
    swapTotalMb: mb(swapTotal),
    swapUsedMb: swapTotal === null || swapFree === null ? null : mb(swapTotal - swapFree),
  };
}

export async function status(ctx, { meminfo = "/proc/meminfo" } = {}) {
  const { layout, runner } = ctx;
  const shown = await runner.run(BIN.systemctl, [
    "show",
    "--property=Id,ActiveState,UnitFileState,Result,ExecMainExitTimestamp",
    ...STATUS_UNITS,
  ]);
  const units = parseShow(shown.stdout);
  const unitStates = Object.fromEntries(
    STATUS_UNITS.map((name) => [name, { active: units[name]?.ActiveState ?? "unknown", enabled: units[name]?.UnitFileState || "unknown" }]),
  );

  const leagues = {};
  for (const lg of LEAGUES) {
    const live = readLive(ctx, lg);
    const backup = readBackupRecord(ctx, lg);
    const dump = newestDump(ctx, lg);
    const drillUnit = units[`ggd2l-drill@${lg}.service`];
    leagues[lg] = {
      live: live ? { id: live.id, sha: live.sha, slot: live.slot, promotedAt: live.promotedAt } : null,
      previous: live?.previous ?? null,
      mode: readModeFile(layout.modeFile(lg)).mode,
      slots: Object.fromEntries(SLOTS.map((slot) => [slot, slotTarget(ctx, lg, slot)])),
      lastBackupAt: backup?.finishedAt ?? (dump ? new Date(dump.mtimeMs).toISOString() : null),
      lastDrill: drillUnit?.ExecMainExitTimestamp
        ? { result: drillUnit.Result || "unknown", at: drillUnit.ExecMainExitTimestamp }
        : null,
    };
  }

  let disk = null;
  try {
    const fs = statfsSync(existsSync(layout.srv) ? layout.srv : layout.root);
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    disk = { freeBytes: free, totalBytes: total, usedPct: total ? Math.round((1 - free / total) * 100) : null };
  } catch {
    // Reported as unknown.
  }
  let memory = null;
  try {
    memory = parseMeminfo(readFileSync(meminfo, "utf8"));
  } catch {
    // Not Linux (tests).
  }
  const failed = await runner.run(BIN.systemctl, ["--failed", "--plain", "--no-legend", "--no-pager"]);
  const failedUnits = failed.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && /^[\w@.:-]+$/.test(name));

  return {
    ok: true,
    units: unitStates,
    leagues,
    disk,
    memory,
    caddyConfigSha256: caddyConfigSha256(layout),
    pendingReboot: existsSync(layout.rebootRequired),
    failedUnits,
    serverErrors24h: serverErrorCount({ layout, sinceMs: ctx.now() - DAY_MS }),
  };
}
