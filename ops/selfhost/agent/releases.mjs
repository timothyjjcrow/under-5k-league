// Blue/green slots per league (design D4, §2.1).
//
//   /srv/ggd2l/<lg>/releases/<id>/release.json   what was built, and its role
//   /srv/ggd2l/<lg>/slots/{a,b}                   symlinks into releases/
//   /var/lib/ggd2l/<lg>/live.json                 {slot, id, sha, promotedAt, previous}
//
// live.json is written last, only after Caddy has loaded the new mode file,
// so it always names what Caddy serves.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { applyCaddyFile, readModeFile, renderAllow, renderMode } from "./caddy-modes.mjs";
import { readJson, writeJsonAtomic } from "./context.mjs";
import {
  AgentError,
  BIN,
  ID_RE,
  PORTS,
  PUBLIC_HOST,
  READY_TIMEOUT_MS,
  SLOTS,
  STATIC_RETENTION_MS,
  TOOLS_KEPT,
  USERS,
  WARM_OVERLAP_MS,
  otherSlot,
  unitName,
} from "./layout.mjs";
import { asUser, must } from "./runner.mjs";

export function readLive(ctx, lg) {
  const live = readJson(ctx.layout.liveJson(lg));
  if (!live || !SLOTS.includes(live.slot) || !ID_RE.test(live.id ?? "")) return null;
  return live;
}

export function readRelease(ctx, id) {
  return readJson(path.join(ctx.layout.release(id), "release.json"));
}

function writeRelease(ctx, id, patch) {
  const file = path.join(ctx.layout.release(id), "release.json");
  const current = readJson(file);
  if (current) writeJsonAtomic(file, { ...current, ...patch });
}

/** The release id a slot symlink points at, or null. */
export function slotTarget(ctx, lg, slot) {
  try {
    const id = path.basename(readlinkSync(ctx.layout.slot(lg, slot)));
    return ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** ln -sfn ../releases/<id> slots/<slot>, atomically (symlink, then rename over). */
function pointSlot(ctx, lg, slot, id) {
  const link = ctx.layout.slot(lg, slot);
  mkdirSync(path.dirname(link), { recursive: true });
  const temporary = `${link}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(path.join("..", "releases", id), temporary);
  renameSync(temporary, link);
}

export function requireRelease(ctx, lg, id) {
  if (id.slice(0, 2) !== lg) throw new AgentError("wrong_league");
  const release = readRelease(ctx, id);
  if (!release) throw new AgentError("release_missing");
  if (release.region !== lg || release.id !== id) throw new AgentError("wrong_league");
  if (release.state !== "BUILT" && release.state !== "READY") throw new AgentError("release_not_built");
  return release;
}

function withinOverlap(ctx, live) {
  const promotedAt = Date.parse(live?.promotedAt ?? "");
  return Number.isFinite(promotedAt) && ctx.now() - promotedAt < WARM_OVERLAP_MS;
}

async function waitForHealth(ctx, lg, port, paths, timeoutCode) {
  const deadline = ctx.now() + READY_TIMEOUT_MS;
  for (;;) {
    let healthy = true;
    for (const route of paths) {
      const status = await ctx.httpGet(`http://127.0.0.1:${port}${route}`, { host: PUBLIC_HOST[lg] });
      if (status !== 200) {
        healthy = false;
        break;
      }
    }
    if (healthy) return;
    if (ctx.now() >= deadline) throw new AgentError(timeoutCode);
    await ctx.sleep(2000);
  }
}

async function restartSlot(ctx, lg, slot) {
  await must(ctx.runner, "start_failed", BIN.systemctl, ["restart", unitName(lg, slot)]);
}

/** `start <lg> <id>`: the idle slot runs the release; nothing public changes. */
export async function startRelease(ctx, lg, id) {
  requireRelease(ctx, lg, id);
  const live = readLive(ctx, lg);
  const slot = live ? otherSlot(live.slot) : "a";
  // The idle slot is the old release kept warm after the last promote.
  if (live && withinOverlap(ctx, live)) throw new AgentError("too_soon");
  pointSlot(ctx, lg, slot, id);
  await restartSlot(ctx, lg, slot);
  const port = PORTS[lg][slot];
  await waitForHealth(ctx, lg, port, ["/api/health/live"], "start_timeout");
  writeRelease(ctx, id, { state: "READY" });
  return { slot, port };
}

/**
 * `promote <lg> <id> [--mode proxy|allowlist]`: restart the target slot clean,
 * wait for live and ready, swap the mode file, reload Caddy, then record it.
 */
export async function promoteRelease(ctx, lg, id, { mode = "proxy" } = {}) {
  if (mode !== "proxy" && mode !== "allowlist") throw new AgentError("bad_mode");
  const release = requireRelease(ctx, lg, id);
  const live = readLive(ctx, lg);
  const idle = live ? otherSlot(live.slot) : "a";
  let target;
  if (slotTarget(ctx, lg, idle) === id) target = idle;
  else if (live && slotTarget(ctx, lg, live.slot) === id) target = live.slot;
  else {
    if (live && withinOverlap(ctx, live)) throw new AgentError("too_soon");
    pointSlot(ctx, lg, idle, id);
    target = idle;
  }

  await restartSlot(ctx, lg, target);
  const port = PORTS[lg][target];
  await waitForHealth(ctx, lg, port, ["/api/health/live", "/api/health/ready"], "ready_timeout");

  await applyCaddyFile({
    runner: ctx.runner,
    file: ctx.layout.modeFile(lg),
    text: renderMode(mode, { port }),
    caddyfile: ctx.layout.caddyfile,
  });

  const previous = live && live.id !== id ? live.id : (live?.previous ?? null);
  mkdirSync(ctx.layout.stateDir(lg), { recursive: true });
  writeJsonAtomic(ctx.layout.liveJson(lg), {
    slot: target,
    id,
    sha: release.sha,
    promotedAt: new Date(ctx.now()).toISOString(),
    previous,
  });
  writeRelease(ctx, id, { state: "READY", role: "live" });
  if (previous && previous !== id) writeRelease(ctx, previous, { role: "previous" });
  if (live?.previous && live.previous !== previous && live.previous !== id)
    writeRelease(ctx, live.previous, { role: "old" });

  // Only the live slot comes back after the 09:00Z reboot. The old slot keeps
  // running (warm) until retire.
  await must(ctx.runner, "systemctl_failed", BIN.systemctl, ["enable", unitName(lg, target)]);
  await must(ctx.runner, "systemctl_failed", BIN.systemctl, ["disable", unitName(lg, otherSlot(target))]);
  return { id, previous };
}

/** `rollback <lg>`: promote the previous release, restarted clean, in the current mode. */
export async function rollbackRelease(ctx, lg) {
  const live = readLive(ctx, lg);
  if (!live) throw new AgentError("no_live");
  if (!live.previous) throw new AgentError("no_previous");
  const { mode } = readModeFile(ctx.layout.modeFile(lg));
  if (mode !== "proxy" && mode !== "allowlist") throw new AgentError("mode_is_maintenance");
  const { id } = await promoteRelease(ctx, lg, live.previous, { mode });
  return { id };
}

/** `retire <lg> <id>`: stop and disable a non-live slot, after the warm overlap. */
export async function retireRelease(ctx, lg, id) {
  if (id.slice(0, 2) !== lg) throw new AgentError("wrong_league");
  const live = readLive(ctx, lg);
  if (live?.id === id) throw new AgentError("is_live");
  if (live && withinOverlap(ctx, live)) throw new AgentError("too_soon");
  const slots = SLOTS.filter((slot) => slot !== live?.slot && slotTarget(ctx, lg, slot) === id);
  for (const slot of slots) {
    await must(ctx.runner, "systemctl_failed", BIN.systemctl, ["stop", unitName(lg, slot)]);
    await must(ctx.runner, "systemctl_failed", BIN.systemctl, ["disable", unitName(lg, slot)]);
  }
  return { ok: true, slots };
}

/** `mode <lg> maintenance|allowlist|proxy`. */
export async function setMode(ctx, lg, mode) {
  let port;
  if (mode !== "maintenance") {
    const live = readLive(ctx, lg);
    if (!live) throw new AgentError("no_live");
    port = PORTS[lg][live.slot];
  }
  await applyCaddyFile({
    runner: ctx.runner,
    file: ctx.layout.modeFile(lg),
    text: renderMode(mode, { port }),
    caddyfile: ctx.layout.caddyfile,
  });
  return { ok: true, mode };
}

/** `allow <ip...>`: the rehearsal and W10a/E7a allowlist. */
export async function setAllowlist(ctx, ips) {
  const unique = [...new Set(ips)];
  mkdirSync(path.dirname(ctx.layout.allowFile), { recursive: true });
  await applyCaddyFile({
    runner: ctx.runner,
    file: ctx.layout.allowFile,
    text: renderAllow(unique),
    caddyfile: ctx.layout.caddyfile,
  });
  return { ok: true, count: unique.length };
}

/** `live <lg>`: live.json, cross-checked against the mode file and the slot. */
export function liveRelease(ctx, lg) {
  const live = readLive(ctx, lg);
  if (!live) throw new AgentError("no_live");
  const port = PORTS[lg][live.slot];
  const mode = readModeFile(ctx.layout.modeFile(lg));
  if (mode.port !== port || slotTarget(ctx, lg, live.slot) !== live.id) throw new AgentError("live_mismatch");
  return { id: live.id, sha: live.sha, slot: live.slot, port };
}

/** `deployment <id>`. */
export function describeRelease(ctx, id) {
  const lg = id.slice(0, 2);
  const release = readRelease(ctx, id);
  if (!release || release.id !== id) throw new AgentError("release_missing");
  const live = readLive(ctx, lg);
  const slots = SLOTS.filter((slot) => slotTarget(ctx, lg, slot) === id);
  const slot = live && slots.includes(live.slot) ? live.slot : (slots[0] ?? null);
  return {
    id,
    sha: release.sha,
    region: release.region,
    state: release.state,
    role: release.role,
    node: release.node,
    buildLogSha256: /^[0-9a-f]{64}$/.test(release.buildLogSha256 ?? "") ? release.buildLogSha256 : null,
    slot,
    port: slot ? PORTS[lg][slot] : null,
  };
}

/** `check <lg> <id> --expect production|staging`: the shared smoke, then the cache assertion. */
export async function checkRelease(ctx, lg, id, expect) {
  const release = requireRelease(ctx, lg, id);
  const live = readLive(ctx, lg);
  const slots = SLOTS.filter((slot) => slotTarget(ctx, lg, slot) === id);
  const slot = slots.find((candidate) => candidate !== live?.slot) ?? slots[0];
  if (!slot) throw new AgentError("not_started");
  const port = PORTS[lg][slot];
  const dir = ctx.layout.release(id);
  const host = PUBLIC_HOST[lg];
  const [command, args] = asUser(USERS.league(lg), BIN.node, [
    path.join(dir, "ops/selfhost/smoke/smoke.mjs"),
    "--base", `http://127.0.0.1:${port}`,
    "--host", host,
    "--origin", `https://${host}`,
    "--region", lg,
    "--commit", release.sha,
    "--expect", expect,
    "--public-dir", path.join(dir, "public"),
  ]);
  const result = await ctx.runner.run(command, args, { timeoutMs: 180_000 });
  let verdict;
  try {
    verdict = JSON.parse(result.stdout);
  } catch {
    throw new AgentError("smoke_failed");
  }
  // Names and verdicts only: a failure's text may quote a response body.
  const checks = Array.isArray(verdict?.checks)
    ? verdict.checks.map((check) => ({ name: String(check?.name ?? ""), ok: check?.ok === true }))
    : [];
  if (result.code !== 0 || verdict?.ok !== true || checks.length === 0)
    throw new AgentError("smoke_failed", { checks });
  if (fetchCacheTagged(path.join(dir, ".next/cache/fetch-cache")))
    throw new AgentError("fetch_cache_tagged", { checks });
  return { ok: true, checks };
}

/** True when any fetch-cache entry carries an automation-gate or result-sync tag. */
export function fetchCacheTagged(dir) {
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        let text = "";
        try {
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (/"(automation-gate|result-sync)[^"]*"/.test(text)) return true;
      }
    }
  }
  return false;
}

function listFiles(root) {
  const files = [];
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop();
    let entries;
    try {
      entries = readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) pending.push(next);
      else files.push(next);
    }
  }
  return files;
}

function removeEmptyDirs(root, relative = "") {
  const dir = path.join(root, relative);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) if (entry.isDirectory()) removeEmptyDirs(root, path.join(relative, entry.name));
  if (relative && readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * `prune <lg>`: keep the live, previous and newest built releases and anything
 * a slot points at; the 2 newest tools clones and tools/current; and static
 * files younger than 14 days or still shipped by a kept release.
 *
 * Resolves {removed: [release ids and "tools/<sha12>"], staticFilesRemoved};
 * release-box.mjs counts `removed` as an array.
 */
export function pruneLeague(ctx, lg) {
  const { layout } = ctx;
  const live = readLive(ctx, lg);
  const ids = (() => {
    try {
      return readdirSync(layout.releases(lg)).filter((name) => ID_RE.test(name) && name.startsWith(`${lg}-`));
    } catch {
      return [];
    }
  })();
  const keep = new Set([live?.id, live?.previous].filter(Boolean));
  for (const slot of SLOTS) {
    const id = slotTarget(ctx, lg, slot);
    if (id) keep.add(id);
  }
  const built = ids
    .filter((id) => ["BUILT", "READY"].includes(readRelease(ctx, id)?.state))
    .sort((a, b) => a.slice(3).localeCompare(b.slice(3)));
  if (built.length) keep.add(built.at(-1));

  const removedReleases = [];
  for (const id of ids) {
    if (keep.has(id)) continue;
    rmSync(layout.release(id), { recursive: true, force: true });
    removedReleases.push(id);
  }

  const removedTools = [];
  let current = null;
  try {
    current = path.basename(readlinkSync(layout.toolsCurrent));
  } catch {
    // No current tools clone yet.
  }
  try {
    const clones = readdirSync(layout.tools)
      .filter((name) => /^[0-9a-f]{12}$/.test(name))
      .map((name) => ({ name, mtime: statSync(path.join(layout.tools, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    clones.slice(TOOLS_KEPT).forEach(({ name }) => {
      if (name === current) return;
      rmSync(path.join(layout.tools, name), { recursive: true, force: true });
      removedTools.push(name);
    });
  } catch {
    // No tools folder yet.
  }

  const shipped = new Set();
  for (const id of keep) for (const file of listFiles(path.join(layout.release(id), ".next/static"))) shipped.add(file);
  const staticRoot = layout.staticDir(lg);
  const cutoff = ctx.now() - STATIC_RETENTION_MS;
  let removedStatic = 0;
  for (const file of listFiles(staticRoot)) {
    if (shipped.has(file)) continue;
    const full = path.join(staticRoot, file);
    try {
      if (statSync(full).mtimeMs >= cutoff) continue;
      unlinkSync(full);
      removedStatic++;
    } catch {
      // Gone already.
    }
  }
  if (existsSync(staticRoot)) removeEmptyDirs(staticRoot);
  return {
    ok: true,
    removed: [...removedReleases, ...removedTools.map((name) => `tools/${name}`)],
    staticFilesRemoved: removedStatic,
  };
}
