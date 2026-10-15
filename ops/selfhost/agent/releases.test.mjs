import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readMode, renderAllow, renderMode } from "./caddy-modes.mjs";
import { SHA2, T0, addRelease, isCaddyValidate, isReload, makeBox } from "./harness.test.mjs";
import {
  describeRelease,
  fetchCacheTagged,
  liveRelease,
  promoteRelease,
  pruneLeague,
  retireRelease,
  rollbackRelease,
  setAllowlist,
  setMode,
  startRelease,
} from "./releases.mjs";

const OLD = "us-20261015T120000Z-0123456789ab";
const NEW = "us-20261016T140000Z-fedcba987654";
const NEWER = "us-20261016T150000Z-fedcba987654";

function liveBox() {
  const box = makeBox();
  addRelease(box, OLD, { state: "READY" });
  addRelease(box, NEW, { sha: SHA2 });
  return box;
}

const read = (file) => readFileSync(file, "utf8");
const liveJson = (box) => JSON.parse(read(box.layout.liveJson("us")));

async function goLive(box, id = OLD) {
  await promoteRelease(box.ctx, "us", id);
  box.clock.t += 120_000;
}

test("the three mode files render as the design's Caddy blocks", () => {
  const proxy = renderMode("proxy", { port: 3001 });
  assert.match(proxy, /reverse_proxy 127\.0\.0\.1:3001 \{/);
  for (const line of ["header_up -X-Vercel-Forwarded-For", "header_up -X-Real-IP", "header_up -X-Middleware-Subrequest", "header_up X-Forwarded-Proto https", "header_up X-Forwarded-For {client_ip}", "flush_interval -1", "keepalive 60s"])
    assert.ok(proxy.includes(line), line);
  assert.ok(!/import/.test(proxy.replace(/^#.*$/gm, "")));
  assert.deepEqual(readMode(proxy), { mode: "proxy", port: 3001 });

  const allow = renderMode("allowlist", { port: 3012 });
  assert.match(allow, /import \/etc\/caddy\/ggd2l\/allow\.caddy\nhandle @allowed \{/);
  assert.match(allow, /header X-Robots-Tag "noindex, nofollow"/);
  assert.match(allow, /handle \{\n\theader Retry-After 600/);
  assert.deepEqual(readMode(allow), { mode: "allowlist", port: 3012 });

  const maintenance = renderMode("maintenance");
  for (const line of ["header Retry-After 600", "header Cache-Control no-store", "root * /srv/ggd2l/www", "rewrite * /maintenance.html", "status 503"])
    assert.ok(maintenance.includes(line), line);
  assert.deepEqual(readMode(maintenance), { mode: "maintenance", port: null });

  assert.equal(renderAllow(["203.0.113.7", "2001:db8::1"]).split("\n")[1], "@allowed client_ip 203.0.113.7 2001:db8::1");
});

test("promote restarts the target clean, swaps the mode file, reloads Caddy, then records live", async () => {
  const box = liveBox();
  await goLive(box);
  assert.equal(liveJson(box).slot, "a");
  assert.equal(readlinkSync(box.layout.slot("us", "a")), path.join("..", "releases", OLD));

  const before = box.calls.length;
  const result = await promoteRelease(box.ctx, "us", NEW);
  assert.deepEqual(result, { id: NEW, previous: OLD });
  const steps = box.calls.slice(before).map((call) => [path.basename(call.command), ...call.args].join(" "));
  assert.deepEqual(steps, [
    "systemctl restart ggd2l-us@b.service",
    "chown root:caddy " + box.layout.modeFile("us") + ".new",
    `runuser -u caddy -- /usr/bin/env HOME=/var/lib/caddy /usr/bin/caddy validate --config ${box.layout.caddyfile} --adapter caddyfile`,
    "systemctl reload caddy.service",
    "systemctl enable ggd2l-us@b.service",
    "systemctl disable ggd2l-us@a.service",
  ]);
  assert.deepEqual(readMode(read(box.layout.modeFile("us"))), { mode: "proxy", port: 3002 });
  const validate = box.calls.slice(before).find((call) => isCaddyValidate(call.command, call.args));
  assert.equal(validate.cwd, "/", "validated from a directory caddy can read");
  const live = liveJson(box);
  assert.equal(live.id, NEW);
  assert.equal(live.slot, "b");
  assert.equal(live.sha, SHA2);
  assert.equal(live.previous, OLD);
  assert.equal(JSON.parse(read(path.join(box.layout.release(OLD), "release.json"))).role, "previous");
  assert.deepEqual(liveRelease(box.ctx, "us"), { id: NEW, sha: SHA2, slot: "b", port: 3002 });
  // The old slot still points at the old release (warm for rollback).
  assert.equal(readlinkSync(box.layout.slot("us", "a")), path.join("..", "releases", OLD));
});

test("a failed caddy validate leaves the mode file and live.json unchanged", async () => {
  const box = liveBox();
  await goLive(box);
  const modeBefore = read(box.layout.modeFile("us"));
  const liveBefore = read(box.layout.liveJson("us"));
  box.on((command, args) => (isCaddyValidate(command, args) ? { code: 1, stdout: "Error: secret-looking caddy output" } : undefined));

  await assert.rejects(promoteRelease(box.ctx, "us", NEW), (error) => {
    assert.equal(error.code, "caddy_invalid");
    assert.ok(!error.message.includes("caddy output"));
    return true;
  });
  assert.equal(read(box.layout.modeFile("us")), modeBefore);
  assert.equal(read(box.layout.liveJson("us")), liveBefore);
  assert.equal(box.calls.filter((call) => isReload(call.command, call.args)).length, 1, "only the first promote reloaded");

  await assert.rejects(setMode(box.ctx, "us", "maintenance"), { code: "caddy_invalid" });
  assert.equal(read(box.layout.modeFile("us")), modeBefore);
  assert.equal(read(box.layout.liveJson("us")), liveBefore);
});

test("a failed reload restores the old file and reloads it again", async () => {
  const box = liveBox();
  await goLive(box);
  const modeBefore = read(box.layout.modeFile("us"));
  let reloads = 0;
  box.on((command, args) => (isReload(command, args) && reloads++ === 0 ? { code: 1 } : undefined));
  await assert.rejects(setMode(box.ctx, "us", "maintenance"), { code: "caddy_reload_failed" });
  assert.equal(read(box.layout.modeFile("us")), modeBefore);
  assert.equal(reloads, 2);
});

test("mode switches between maintenance, allowlist and proxy on the live slot", async () => {
  const box = liveBox();
  await assert.rejects(setMode(box.ctx, "us", "proxy"), { code: "no_live" });
  await setMode(box.ctx, "us", "maintenance");
  assert.equal(readMode(read(box.layout.modeFile("us"))).mode, "maintenance");
  await promoteRelease(box.ctx, "us", OLD, { mode: "allowlist" });
  assert.deepEqual(readMode(read(box.layout.modeFile("us"))), { mode: "allowlist", port: 3001 });
  await setMode(box.ctx, "us", "proxy");
  assert.deepEqual(readMode(read(box.layout.modeFile("us"))), { mode: "proxy", port: 3001 });
  await setAllowlist(box.ctx, ["203.0.113.7", "203.0.113.7", "2001:db8::1"]);
  assert.match(read(box.layout.allowFile), /^@allowed client_ip 203\.0\.113\.7 2001:db8::1$/m);
});

test("live refuses when live.json, the mode file and the slot disagree", async () => {
  const box = liveBox();
  await goLive(box);
  writeFileSync(box.layout.modeFile("us"), renderMode("proxy", { port: 3002 }));
  assert.throws(() => liveRelease(box.ctx, "us"), { code: "live_mismatch" });
  writeFileSync(box.layout.modeFile("us"), renderMode("maintenance"));
  assert.throws(() => liveRelease(box.ctx, "us"), { code: "live_mismatch" });
});

test("start uses the idle slot and waits for live; it refuses inside the warm overlap", async () => {
  const box = liveBox();
  await promoteRelease(box.ctx, "us", OLD);
  await assert.rejects(startRelease(box.ctx, "us", NEW), { code: "too_soon" });
  box.clock.t += 91_000;
  assert.deepEqual(await startRelease(box.ctx, "us", NEW), { slot: "b", port: 3002 });
  assert.equal(JSON.parse(read(path.join(box.layout.release(NEW), "release.json"))).state, "READY");
  assert.equal(describeRelease(box.ctx, NEW).slot, "b");

  box.health = () => 503;
  addRelease(box, NEWER);
  await assert.rejects(startRelease(box.ctx, "us", NEWER), { code: "start_timeout" });
});

test("deployment reports the release record, its build log hash and its slot", async () => {
  const box = liveBox();
  await goLive(box);
  const file = path.join(box.layout.release(OLD), "release.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(read(file)), buildLogSha256: "d".repeat(64) }));
  assert.deepEqual(describeRelease(box.ctx, OLD), {
    id: OLD,
    sha: JSON.parse(read(file)).sha,
    region: "us",
    state: "READY",
    role: "live",
    node: "v22.23.3",
    buildLogSha256: "d".repeat(64),
    slot: "a",
    port: 3001,
  });
  // A release built before the field existed, or a malformed one, says null.
  assert.equal(describeRelease(box.ctx, NEW).buildLogSha256, null);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(read(file)), buildLogSha256: "../../etc" }));
  assert.equal(describeRelease(box.ctx, OLD).buildLogSha256, null);
});

test("retire refuses the live id and anything within 90 s of a promote", async () => {
  const box = liveBox();
  await goLive(box);
  await startRelease(box.ctx, "us", NEW);
  await promoteRelease(box.ctx, "us", NEW);

  await assert.rejects(retireRelease(box.ctx, "us", NEW), { code: "is_live" });
  box.clock.t += 89_000;
  await assert.rejects(retireRelease(box.ctx, "us", OLD), { code: "too_soon" });
  const before = box.calls.length;
  box.clock.t += 1_000;
  assert.deepEqual(await retireRelease(box.ctx, "us", OLD), { ok: true, slots: ["a"] });
  assert.deepEqual(
    box.calls.slice(before).map((call) => call.args.join(" ")),
    ["stop ggd2l-us@a.service", "disable ggd2l-us@a.service"],
  );
  await assert.rejects(retireRelease(box.ctx, "us", NEW), { code: "is_live" });
});

test("rollback promotes the previous release in the current mode and refuses in maintenance", async () => {
  const box = liveBox();
  await goLive(box);
  await assert.rejects(rollbackRelease(box.ctx, "us"), { code: "no_previous" });
  await startRelease(box.ctx, "us", NEW);
  await promoteRelease(box.ctx, "us", NEW, { mode: "allowlist" });
  const restarts = box.commandsMatching(/systemctl restart ggd2l-us@a/).length;
  assert.deepEqual(await rollbackRelease(box.ctx, "us"), { id: OLD });
  assert.equal(box.commandsMatching(/systemctl restart ggd2l-us@a/).length, restarts + 1, "restarted clean");
  assert.deepEqual(readMode(read(box.layout.modeFile("us"))), { mode: "allowlist", port: 3001 });
  assert.equal(liveJson(box).previous, NEW);

  await setMode(box.ctx, "us", "maintenance");
  await assert.rejects(rollbackRelease(box.ctx, "us"), { code: "mode_is_maintenance" });
});

test("promote can re-promote the live release onto the slot start put it on (cutover W9-W10a)", async () => {
  const box = liveBox();
  await goLive(box);
  await startRelease(box.ctx, "us", OLD);
  assert.deepEqual(await promoteRelease(box.ctx, "us", OLD, { mode: "allowlist" }), { id: OLD, previous: null });
  assert.equal(liveJson(box).slot, "b");
});

test("prune keeps live, previous and the newest build, and every slot's release", async () => {
  const box = liveBox();
  const ancient = "us-20261001T000000Z-aaaaaaaaaaaa";
  const failed = "us-20261017T000000Z-bbbbbbbbbbbb";
  const newest = "us-20261016T200000Z-cccccccccccc";
  addRelease(box, ancient, { staticFiles: ["chunks/ancient.js"] });
  addRelease(box, failed, { state: "FAILED" });
  addRelease(box, newest);
  await goLive(box);
  await startRelease(box.ctx, "us", NEW);
  await promoteRelease(box.ctx, "us", NEW);
  // Point slot a back at the old release explicitly: still referenced.
  const result = pruneLeague(box.ctx, "us");
  assert.deepEqual([...result.removed].sort(), [ancient, failed].sort());
  assert.equal(result.ok, true);
  for (const id of [OLD, NEW, newest]) assert.ok(existsSync(box.layout.release(id)), id);
  for (const id of [ancient, failed]) assert.ok(!existsSync(box.layout.release(id)), id);
});

test("prune keeps the previous release for rollback even when no slot points at it", async () => {
  const box = liveBox();
  const ancient = "us-20261001T000000Z-aaaaaaaaaaaa";
  addRelease(box, ancient);
  addRelease(box, NEWER);
  await goLive(box);
  await startRelease(box.ctx, "us", NEW);
  await promoteRelease(box.ctx, "us", NEW);
  box.clock.t += 91_000;
  // The next candidate takes slot a, so the previous release is on no slot.
  await startRelease(box.ctx, "us", NEWER);
  assert.equal(liveJson(box).previous, OLD);
  assert.deepEqual(pruneLeague(box.ctx, "us").removed, [ancient]);
  for (const id of [OLD, NEW, NEWER]) assert.ok(existsSync(box.layout.release(id)), id);
});

test("prune removes static files older than 14 days unless a kept release still ships them", async () => {
  const box = liveBox();
  await goLive(box);
  const root = box.layout.staticDir("us");
  const old = (T0 - 15 * 24 * 60 * 60_000) / 1000;
  for (const [file, mtime] of [["chunks/app.js", old], ["chunks/gone.js", old], ["chunks/recent.js", T0 / 1000]]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "x");
    utimesSync(path.join(root, file), mtime, mtime);
  }
  // Tools: three clones, current on the oldest.
  for (const [name, age] of [["111111111111", 3], ["222222222222", 2], ["333333333333", 1]]) {
    mkdirSync(path.join(box.layout.tools, name));
    const time = (T0 - age * 1000) / 1000;
    utimesSync(path.join(box.layout.tools, name), time, time);
  }
  symlinkSync("111111111111", box.layout.toolsCurrent);
  const result = pruneLeague(box.ctx, "us");
  assert.equal(result.staticFilesRemoved, 1);
  assert.ok(existsSync(path.join(root, "chunks/app.js")), "shipped by the live release");
  assert.ok(existsSync(path.join(root, "chunks/recent.js")));
  assert.ok(!existsSync(path.join(root, "chunks/gone.js")));
  assert.deepEqual(result.removed, [], "two newest plus current are all kept");
  // A fourth, older clone goes, by its tools/ name; current stays however old.
  mkdirSync(path.join(box.layout.tools, "000000000000"));
  utimesSync(path.join(box.layout.tools, "000000000000"), (T0 - 9000) / 1000, (T0 - 9000) / 1000);
  assert.deepEqual(pruneLeague(box.ctx, "us").removed, ["tools/000000000000"]);
  assert.ok(existsSync(path.join(box.layout.tools, "111111111111")));
});

test("the fetch-cache assertion finds gate and result-sync tags", () => {
  const box = makeBox();
  const dir = path.join(box.root, "fetch-cache");
  mkdirSync(path.join(dir, "x"), { recursive: true });
  writeFileSync(path.join(dir, "x", "a"), JSON.stringify({ kind: "FETCH", tags: ["games"] }));
  assert.equal(fetchCacheTagged(dir), false);
  writeFileSync(path.join(dir, "x", "b"), JSON.stringify({ kind: "FETCH", tags: ["automation-gate:v12"] }));
  assert.equal(fetchCacheTagged(dir), true);
  assert.equal(fetchCacheTagged(path.join(box.root, "missing")), false);
});
