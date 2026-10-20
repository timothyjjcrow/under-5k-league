// The kit-clone trust check in install-kit.sh and provision-ggd2l.sh, run
// against throwaway clones. Both run as root and then run git and scripts from
// the clone, so they must refuse a clone any other user could change (a tools
// clone the build user made, whose npm scripts run as that user) before they
// run anything from it: git would run that user's core.fsmonitor as root, and
// a file rewritten behind the index's stat data would pass the clean check.
// Everything after the check needs root and Ubuntu and runs on the box
// (design §6.0 P2).
//
// A fake `id` reports FAKE_UID, so "the user running this" can differ from the
// owner of the files without root. It never reports 0, so neither script gets
// past its own root check here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELFHOST = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = ["install-kit.sh", "provision-ggd2l.sh"];
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REAL_UID = process.getuid();
// As root the scripts would pass their root check and go on to change the
// system, so this file only ever runs them as an ordinary user.
const SKIP = REAL_UID === 0 && "never run the kit's root scripts as root in a test";

/** Set modes explicitly, whatever the umask: dirs 0755, files 0644. */
function tidy(dir) {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) tidy(full);
    else chmodSync(full, 0o644);
  }
}

/** A clone under a fresh folder: <holder>/kit/{.git,ops/selfhost/<both scripts>}. */
function fakeClone(t) {
  const holder = realpathSync(mkdtempSync(path.join(tmpdir(), "ggd2l-kit-trust-")));
  t.after(() => {
    chmodSync(holder, 0o700);
    rmSync(holder, { recursive: true, force: true });
  });
  const kit = path.join(holder, "kit");
  const selfhost = path.join(kit, "ops", "selfhost");
  mkdirSync(selfhost, { recursive: true });
  for (const script of SCRIPTS) copyFileSync(path.join(SELFHOST, script), path.join(selfhost, script));
  mkdirSync(path.join(kit, ".git", "hooks"), { recursive: true });
  // What a hostile clone would carry: git runs this on `git status`.
  const marker = path.join(holder, "fsmonitor-ran");
  writeFileSync(path.join(kit, ".git", "config"), `[core]\n\tfsmonitor = touch ${marker}\n`);
  writeFileSync(path.join(kit, ".git", "HEAD"), `${SHA}\n`);
  tidy(holder);
  const bin = path.join(holder, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "id"), '#!/bin/sh\nif [ "$1" = "-u" ]; then echo "$FAKE_UID"; exit 0; fi\nexec /usr/bin/id "$@"\n');
  chmodSync(path.join(bin, "id"), 0o755);
  const run = (script, { uid = REAL_UID } = {}) => {
    const result = spawnSync("bash", [path.join(selfhost, script), SHA], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_UID: String(uid) },
    });
    assert.ok(!existsSync(marker), `${script} ran git from the clone`);
    return result;
  };
  return { holder, kit, selfhost, run };
}

/** The script stopped at its trust check, naming <where>. */
function refused(result, where) {
  assert.equal(result.status, 1, result.stderr);
  assert.ok(
    result.stderr.includes(`: ${where} is owned or writable by a user other than root; run this only from root's own clone`),
    result.stderr,
  );
  assert.doesNotMatch(result.stderr, /run as root$/m);
}

/** The script passed its trust check and stopped at the root check. */
function trusted(result) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /: run as root\n$/);
  assert.doesNotMatch(result.stderr, /owned or writable/);
}

for (const script of SCRIPTS) {
  test(`${script} accepts a clone only its own user can change`, { skip: SKIP }, (t) => {
    const clone = fakeClone(t);
    trusted(clone.run(script));
    // A symlink's own mode means nothing: 0777 on Linux, and made so on macOS,
    // whose symlinks otherwise take the umask.
    const link = path.join(clone.selfhost, "a-link");
    symlinkSync("install-kit.sh", link);
    if (process.platform === "darwin") assert.equal(spawnSync("chmod", ["-h", "777", link]).status, 0);
    trusted(clone.run(script));
  });

  test(`${script} refuses a clone another user owns`, { skip: SKIP }, (t) => {
    const clone = fakeClone(t);
    refused(clone.run(script, { uid: REAL_UID === 4242 ? 4243 : 4242 }), clone.kit);
  });

  test(`${script} refuses a group-writable file deep in the clone`, { skip: SKIP }, (t) => {
    const clone = fakeClone(t);
    chmodSync(path.join(clone.kit, ".git", "config"), 0o664);
    refused(clone.run(script), path.join(clone.kit, ".git", "config"));
  });

  test(`${script} refuses a world-writable folder in the clone`, { skip: SKIP }, (t) => {
    const clone = fakeClone(t);
    chmodSync(path.join(clone.kit, "ops"), 0o757);
    refused(clone.run(script), path.join(clone.kit, "ops"));
  });

  test(`${script} refuses a clone others could move aside, unless its parent is sticky`, { skip: SKIP }, (t) => {
    const clone = fakeClone(t);
    chmodSync(clone.holder, 0o775);
    refused(clone.run(script), clone.holder);
    chmodSync(clone.holder, 0o1777);
    trusted(clone.run(script));
  });
}

test("both scripts carry the same check and run it before any git command", () => {
  const texts = SCRIPTS.map((script) => readFileSync(path.join(SELFHOST, script), "utf8"));
  const bodies = texts.map((text) => /\nkit_untrusted\(\) \{\n[\s\S]*?\n\}\n/.exec(text)?.[0]);
  assert.ok(bodies[0], "install-kit.sh defines kit_untrusted");
  assert.equal(bodies[0], bodies[1]);
  for (const [index, text] of texts.entries()) {
    const code = text.replace(/^\s*#.*$/gm, "");
    const check = code.indexOf('untrusted="$(kit_untrusted "${KIT_ROOT}")"');
    assert.ok(check > 0, `${SCRIPTS[index]} runs the check`);
    for (const later of [/\bgit(_kit)? /, /\bbash "\$\{HERE\}/, /\. \/etc\/os-release/, /\[\[ "\$\(id -u\)" -eq 0 \]\]/]) {
      const at = code.search(later);
      if (at !== -1) assert.ok(check < at, `${SCRIPTS[index]}: the check comes before ${later}`);
    }
    // Root needs no safe.directory exception for its own clone, and git runs
    // no fsmonitor or hook from it.
    assert.doesNotMatch(code, /safe\.directory/);
    for (const call of code.match(/\bgit -c [^\n]*-C "\$\{KIT_ROOT\}"/g) ?? [])
      assert.match(call, /^git -c core\.fsmonitor=false -c core\.hooksPath=\/dev\/null -C /);
  }
});

// 2026-10-18 review: a kit can tighten the env contract (the production
// DOTA_LOBBY_BOT_URL rule), and every live slot's ExecStartPre runs the
// installed copy, so a live env file the new rule refuses would stop that
// league at its next restart. install-kit.sh checks both live files with the
// new contract before it changes anything, and refuses on a problem.
test("install-kit.sh checks the live league env files with its own contract before changing anything", () => {
  const code = readFileSync(path.join(SELFHOST, "install-kit.sh"), "utf8").replace(/^\s*#.*$/gm, "");
  const check = code.indexOf(
    'node "${SELFHOST}/agent/env-contract.mjs" --league "$lg" --file "/etc/ggd2l/${lg}.env" \\\n    || die ',
  );
  assert.ok(check > 0, "install-kit.sh runs the kit's env contract on /etc/ggd2l/<lg>.env and dies on a problem");
  const loop = code.lastIndexOf("for lg in $LEAGUES; do", check);
  assert.ok(loop > 0 && check - loop < 200, "the check runs for each league");
  assert.match(code.slice(loop, check), /\[\[ -f "\/etc\/ggd2l\/\$\{lg\}\.env" \]\] \|\| continue/);
  for (const change of [
    "exec 9>>/run/ggd2l-agent.lock",
    "ensure_user ggd2l-build",
    "write_slot_env us a",
    'mv -T "${STAGE}" "${LIB}"',
    'install_unit_file "$src"',
  ]) {
    const at = code.indexOf(change);
    assert.ok(at > 0, change);
    assert.ok(check < at, `the env check comes before ${change}`);
  }
});

// 2026-10-19: GNU chown and chmod, given a link, change its target. ensure_dir
// ran mkdir -p, chown and chmod as root on the build user's npm cache, inside
// the build user's own home, so a link a build left there handed its target
// (the agent's code, say) to the build user; the backup folders inside
// ggd2l-ops's folder were the same. Root now changes only folders whose parent
// nobody else can write, refuses a link or file there, and leaves a folder in
// a service user's own folder to that user.
const KIT = readFileSync(path.join(SELFHOST, "install-kit.sh"), "utf8");
const KIT_CODE = KIT.replace(/^\s*#.*$/gm, "");

/** Every `ensure_dir` and `ensure_user_dir` call, with ${lg} and ${ADMIN_USER} expanded. */
function folderCalls() {
  const calls = [];
  for (const match of KIT_CODE.matchAll(/^\s*(ensure_dir|ensure_user_dir) (\S+) (\S+) (\S+)$/gm)) {
    const [, fn, a, b, rawPath] = match;
    for (const lg of rawPath.includes("${lg}") ? ["us", "eu"] : [null]) {
      const expand = (value) => value.replace(/"/g, "").replace("${lg}", lg ?? "").replace("${ADMIN_USER}", "ggd2l");
      calls.push(fn === "ensure_dir"
        ? { fn, mode: a, owner: expand(b), path: expand(rawPath) }
        : { fn, user: a, mode: b, path: expand(rawPath) });
    }
  }
  return calls;
}

test("install-kit.sh changes a folder as root only in a parent no service user can write", () => {
  const calls = folderCalls();
  assert.ok(calls.length > 30, `found ${calls.length} folder calls`);
  const ensured = new Map(calls.filter((call) => call.fn === "ensure_dir").map((call) => [call.path, call]));
  const writableBy = (call) => {
    const [user, group] = call.owner.split(":");
    const digits = call.mode.slice(-3);
    const others = [];
    if (user !== "root") others.push(user);
    if (/[2367]/.test(digits[1]) && group !== "root") others.push(`group ${group}`);
    if (/[2367]/.test(digits[2])) others.push("everyone");
    return others;
  };
  for (const call of calls.filter((entry) => entry.fn === "ensure_dir")) {
    const parent = ensured.get(path.posix.dirname(call.path));
    if (parent) assert.deepEqual(writableBy(parent), [], `${call.path}: its parent ${parent.path} is writable by others; use ensure_user_dir`);
  }
  for (const call of calls.filter((entry) => entry.fn === "ensure_user_dir")) {
    const parent = ensured.get(path.posix.dirname(call.path));
    assert.ok(parent && parent.owner === `${call.user}:${call.user}`, `${call.path}: inside a folder ${call.user} owns`);
  }
  // The two folders that let a link through before, now made by their own users.
  for (const [user, folder] of [["ggd2l-build", "/var/cache/ggd2l-build/npm"], ["ggd2l-ops", "/var/backups/ggd2l/us/local"], ["ggd2l-ops", "/var/backups/ggd2l/eu/offsite"]])
    assert.ok(calls.some((call) => call.fn === "ensure_user_dir" && call.user === user && call.path === folder), folder);
  // Where the agent makes the build user's folders (makeBuildDir): root's, and nobody else can write them.
  for (const [folder, mode] of [["/srv/ggd2l/tools", "0755"], ["/srv/ggd2l/bot/releases", "0755"], ["/srv/ggd2l/us/releases", "0751"], ["/srv/ggd2l/eu/releases", "0751"]]) {
    const call = ensured.get(folder);
    assert.ok(call, folder);
    assert.equal(call.owner, "root:root", folder);
    assert.equal(call.mode, mode, folder);
  }
});

/**
 * install-kit.sh's own die, ensure_dir and ensure_user_dir, run on a scratch
 * tree with chown, chmod and runuser replaced by loggers (the folder calls
 * need root on the box), and a fake `id` that may report another user.
 */
function folderHarness(t) {
  const holder = realpathSync(mkdtempSync(path.join(tmpdir(), "ggd2l-kit-dirs-")));
  t.after(() => rmSync(holder, { recursive: true, force: true }));
  const bin = path.join(holder, "bin");
  mkdirSync(bin);
  const log = path.join(holder, "calls.log");
  for (const name of ["chown", "chmod", "runuser"])
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n`, { mode: 0o755 });
  writeFileSync(path.join(bin, "id"), '#!/bin/sh\nif [ "$1" = "-u" ]; then echo "$FAKE_UID"; exit 0; fi\nexec /usr/bin/id "$@"\n', { mode: 0o755 });
  const functions = ["die", "ensure_dir", "ensure_user_dir"].map((name) => {
    const body = new RegExp(`\\n(${name}\\(\\) \\{[^\\n]*\\}|${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\})\\n`).exec(KIT)?.[1];
    assert.ok(body, `install-kit.sh defines ${name}`);
    return body;
  });
  const script = path.join(holder, "dirs.sh");
  writeFileSync(script, `set -euo pipefail\n${functions.join("\n")}\n"$@"\n`);
  const tree = path.join(holder, "tree");
  mkdirSync(tree, { mode: 0o755 });
  const run = (args, { uid = REAL_UID } = {}) => {
    rmSync(log, { force: true });
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_UID: String(uid) },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return { ...result, calls };
  };
  return { holder, tree, run };
}

test("ensure_dir makes a folder, then changes it with chown -h and chmod", { skip: SKIP }, (t) => {
  const { tree, run } = folderHarness(t);
  const folder = path.join(tree, "fresh");
  const result = run(["ensure_dir", "0750", "ggd2l-build:ggd2l-build", folder]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [`chown -h ggd2l-build:ggd2l-build ${folder}`, `chmod 0750 ${folder}`]);
  assert.ok(lstatSync(folder).isDirectory());
  // An existing folder is changed the same way.
  assert.equal(run(["ensure_dir", "0750", "ggd2l-build:ggd2l-build", folder]).status, 0);
});

test("ensure_dir refuses a link or file at the folder's name before any chown or chmod", { skip: SKIP }, (t) => {
  const { holder, tree, run } = folderHarness(t);
  const target = path.join(holder, "agent-code");
  mkdirSync(target);
  for (const [name, plant] of [
    ["a link to a folder", (at) => symlinkSync(target, at)],
    ["a dangling link", (at) => symlinkSync(path.join(holder, "nowhere"), at)],
    ["a file", (at) => writeFileSync(at, "x")],
  ]) {
    const folder = path.join(tree, name.replace(/ /g, "-"));
    plant(folder);
    const result = run(["ensure_dir", "0750", "ggd2l-build:ggd2l-build", folder]);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /is a link or not a folder: refusing to change it as root/, name);
    assert.deepEqual(result.calls, [], `${name}: no chown or chmod ran`);
  }
  assert.deepEqual(readdirSync(target), [], "nothing was made through the link");
});

test("ensure_dir refuses a folder in a parent another user owns or anyone can write", { skip: SKIP }, (t) => {
  const { tree, run } = folderHarness(t);
  // The tree is this user's: as another user, its parent is not "root's".
  const theirs = run(["ensure_dir", "0750", "root:root", path.join(tree, "x")], { uid: REAL_UID === 4242 ? 4243 : 4242 });
  assert.equal(theirs.status, 1);
  assert.match(theirs.stderr, /is not root's, or anyone can write it/);
  assert.deepEqual(theirs.calls, []);
  assert.ok(!existsSync(path.join(tree, "x")));
  for (const mode of [0o777, 0o1777]) {
    const open = path.join(tree, `open-${mode.toString(8)}`);
    mkdirSync(open);
    chmodSync(open, mode);
    const result = run(["ensure_dir", "0750", "root:root", path.join(open, "x")]);
    assert.equal(result.status, 1, mode.toString(8));
    assert.deepEqual(result.calls, []);
  }
});

test("ensure_user_dir leaves the folder to its user, and refuses a link or file there", { skip: SKIP }, (t) => {
  const { holder, tree, run } = folderHarness(t);
  const folder = path.join(tree, "npm");
  const made = run(["ensure_user_dir", "ggd2l-build", "0750", folder]);
  assert.equal(made.status, 0, made.stderr);
  assert.deepEqual(made.calls, [`runuser -u ggd2l-build -- mkdir -p ${folder}`, `runuser -u ggd2l-build -- chmod 0750 ${folder}`]);
  const target = path.join(holder, "agent-code");
  mkdirSync(target);
  for (const plant of [(at) => symlinkSync(target, at), (at) => writeFileSync(at, "x")]) {
    rmSync(folder, { recursive: true, force: true });
    plant(folder);
    const result = run(["ensure_user_dir", "ggd2l-build", "0750", folder]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is a link or not a folder; ggd2l-build may have been misused/);
    assert.deepEqual(result.calls, [], "not even the user's own commands ran");
  }
});
