// Structural checks for the box's systemd units (design §1.5, §5, §7).
// systemd-analyze does not exist on macOS or in CI, so this parses the files
// the way systemd reads them and pins what the design requires. On the box,
// `systemd-analyze verify` (install-kit.sh prints the command) is the final
// word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UNIT_ALERTS } from "../backup/discord-alert.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SELFHOST = path.resolve(DIR, "..");
const read = (relative) => readFileSync(path.join(SELFHOST, relative), "utf8");

// Every directive these files may use, per section. A typo (MemroyMax=) is
// ignored by systemd with only a warning; here it fails.
const KNOWN = {
  Unit: new Set(["Description", "After", "Wants", "StartLimitIntervalSec", "StartLimitBurst", "OnFailure", "OnSuccess"]),
  Service: new Set([
    "Type", "User", "Group", "WorkingDirectory", "EnvironmentFile", "Environment",
    "ExecStartPre", "ExecStart", "KillSignal", "TimeoutStopSec", "TimeoutStartSec",
    "SuccessExitStatus", "Restart", "RestartSec", "MemoryHigh", "MemoryMax", "UMask",
    "NoNewPrivileges", "ProtectSystem", "ProtectHome", "PrivateTmp", "ReadWritePaths",
    "Nice", "IOSchedulingClass", "SupplementaryGroups", "StateDirectory",
  ]),
  Timer: new Set(["OnCalendar", "Persistent"]),
  Install: new Set(["WantedBy"]),
};
const VALUES = {
  Type: /^(simple|oneshot)$/,
  Restart: /^(on-failure|always)$/,
  NoNewPrivileges: /^yes$/,
  PrivateTmp: /^yes$/,
  ProtectHome: /^yes$/,
  ProtectSystem: /^strict$/,
  Persistent: /^true$/,
  UMask: /^0[0-7]{3}$/,
  MemoryHigh: /^\d+[MG]$/,
  MemoryMax: /^\d+[MG]$/,
  TimeoutStopSec: /^\d+(s|min)?$/,
  TimeoutStartSec: /^\d+(s|min|h)?$/,
  RestartSec: /^\d+$/,
  StartLimitIntervalSec: /^\d+$/,
  StartLimitBurst: /^\d+$/,
  Nice: /^(-?1?\d)$/,
  IOSchedulingClass: /^idle$/,
  KillSignal: /^SIGTERM$/,
  SuccessExitStatus: /^\d+$/,
  WantedBy: /^(multi-user|timers)\.target$/,
  OnFailure: /^ggd2l-alert@[a-z%-]+\.service$/,
  OnSuccess: /^ggd2l-alert@[a-z%-]+\.service$/,
  SupplementaryGroups: /^systemd-journal$/,
  StateDirectory: /^ggd2l-alerts$/,
};

/** Parse a unit file into Map<section, [key, value][]>, refusing anything systemd would warn about. */
function parseUnit(text, name) {
  const sections = new Map();
  let current = null;
  text.split("\n").forEach((raw, index) => {
    const where = `${name}:${index + 1}`;
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) return;
    assert.ok(!raw.endsWith("\\"), `${where}: no line continuations`);
    assert.equal(raw, line, `${where}: no leading or trailing whitespace`);
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header) {
      assert.ok(KNOWN[header[1]], `${where}: unknown section [${header[1]}]`);
      assert.ok(!sections.has(header[1]), `${where}: section [${header[1]}] repeated`);
      sections.set(header[1], []);
      current = header[1];
      return;
    }
    const pair = /^([A-Za-z]+)=(.*)$/.exec(line);
    assert.ok(pair && current, `${where}: expected key=value inside a section`);
    const [, key, value] = pair;
    assert.ok(KNOWN[current].has(key), `${where}: unknown directive ${key}= in [${current}]`);
    if (VALUES[key] && value !== "") assert.match(value, VALUES[key], `${where}: bad ${key}=${value}`);
    for (const specifier of value.matchAll(/%(.)/g))
      assert.ok("iIjpn%".includes(specifier[1]), `${where}: unexpected specifier %${specifier[1]}`);
    sections.get(current).push([key, value]);
  });
  return sections;
}

const all = (unit, section, key) => (unit.get(section) ?? []).filter(([k]) => k === key).map(([, v]) => v);
/** Every path a service may write under ProtectSystem=strict, one per entry. */
const writable = (unit) => all(unit, "Service", "ReadWritePaths").flatMap((v) => v.split(/\s+/));
const one = (unit, section, key) => {
  const values = all(unit, section, key);
  assert.equal(values.length, 1, `expected exactly one ${key}= in [${section}], found ${values.length}`);
  return values[0];
};

/** Resolve the specifiers this kit uses, as systemd does for an instance name. */
function resolve(value, instanceName) {
  const [prefix, rest] = instanceName.split("@");
  const instance = rest ? rest.replace(/\.[a-z]+$/, "") : "";
  const league = prefix.slice(prefix.lastIndexOf("-") + 1);
  return value.replace(/%(.)/g, (_, s) => ({ i: instance, I: instance, j: league, p: prefix, n: instanceName, "%": "%" })[s]);
}

const UNIT_FILES = readdirSync(DIR).filter((f) => /\.(service|timer)$/.test(f)).sort();
const DROP_INS = readdirSync(DIR).filter((f) => f.endsWith(".d") && statSync(path.join(DIR, f)).isDirectory())
  .flatMap((d) => readdirSync(path.join(DIR, d)).map((f) => `${d}/${f}`));
const units = new Map(UNIT_FILES.map((f) => [f, parseUnit(read(`systemd/${f}`), f)]));
const installKit = read("install-kit.sh");

test("the kit ships exactly the units the design names", () => {
  assert.deepEqual(UNIT_FILES, [
    "cloudflared-ggd2l.service",
    "ggd2l-alert@.service",
    "ggd2l-backup@.service",
    "ggd2l-backup@.timer",
    "ggd2l-bot.service",
    "ggd2l-config-archive.service",
    "ggd2l-config-archive.timer",
    "ggd2l-drill@.service",
    "ggd2l-drill@.timer",
    "ggd2l-eu@.service",
    "ggd2l-heartbeat.service",
    "ggd2l-heartbeat.timer",
    "ggd2l-us@.service",
  ]);
  assert.deepEqual(DROP_INS, ["ggd2l-drill@eu.timer.d/10-schedule.conf"]);
  // install-kit.sh refuses a kit clone that lacks any of them.
  for (const file of [...UNIT_FILES, ...DROP_INS])
    assert.ok(installKit.includes(`\nsystemd/${file}\n`), `install-kit.sh REQUIRED lists systemd/${file}`);
});

test("every unit parses, describes itself, and runs an absolute command", () => {
  for (const [name, unit] of units) {
    assert.ok(one(unit, "Unit", "Description").length > 0, name);
    if (name.endsWith(".service")) {
      for (const key of ["ExecStartPre", "ExecStart"])
        for (const command of all(unit, "Service", key))
          assert.match(command, /^\/usr\/(bin|local\/lib\/ggd2l)\/[\w.-]+( |$)/, `${name}: ${key} must start with an absolute path`);
      for (const file of all(unit, "Service", "EnvironmentFile"))
        assert.match(file, /^-?\/(etc\/ggd2l|srv\/ggd2l)\//, `${name}: env files come from /etc/ggd2l or a release`);
      assert.equal(one(unit, "Service", "NoNewPrivileges"), "yes", name);
      assert.equal(one(unit, "Service", "ProtectSystem"), "strict", name);
      assert.equal(one(unit, "Service", "ProtectHome"), "yes", name);
      assert.equal(one(unit, "Service", "PrivateTmp"), "yes", name);
      // Only the config archive runs as root: it reads root-only directories.
      assert.match(one(unit, "Service", "User"),
        name === "ggd2l-config-archive.service" ? /^root$/ : /^(ggd2l-%j|ggd2l-ops|ggd2l-bot|cloudflared)$/, name);
      assert.ok(one(unit, "Service", "MemoryMax"), name);
    }
  }
  parseUnit(read(`systemd/${DROP_INS[0]}`), DROP_INS[0]);
});

test("the two league units are byte-identical copies of one template", () => {
  assert.equal(read("systemd/ggd2l-us@.service"), read("systemd/ggd2l-eu@.service"));
  const text = read("systemd/ggd2l-us@.service");
  assert.doesNotMatch(text.replace(/^#.*$/gm, ""), /\b(us|eu)\b/, "league names come only from %j");
});

test("a league slot runs exactly the design's unit (§1.5)", () => {
  const unit = units.get("ggd2l-us@.service");
  assert.equal(one(unit, "Unit", "After"), "network-online.target postgresql@18-main.service");
  assert.equal(one(unit, "Unit", "Wants"), "network-online.target postgresql@18-main.service");
  assert.equal(one(unit, "Unit", "StartLimitIntervalSec"), "300");
  assert.equal(one(unit, "Unit", "StartLimitBurst"), "5");
  assert.equal(one(unit, "Service", "Type"), "simple");
  assert.equal(one(unit, "Service", "Group"), "ggd2l-%j");
  // The env contract runs first, then the fetch-cache wipe (D5), then Next.
  assert.deepEqual(all(unit, "Service", "ExecStartPre"), [
    "/usr/bin/node /usr/local/lib/ggd2l/env-contract.mjs --league %j --slot %i",
    "/usr/bin/rm -rf .next/cache/fetch-cache",
  ]);
  assert.equal(one(unit, "Service", "ExecStart"),
    "/usr/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p ${PORT} --keepAliveTimeout 75000");
  assert.equal(one(unit, "Service", "Environment"),
    "NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 MALLOC_ARENA_MAX=2 NODE_OPTIONS=--max-old-space-size=640");
  assert.equal(one(unit, "Service", "KillSignal"), "SIGTERM");
  assert.equal(one(unit, "Service", "TimeoutStopSec"), "60");
  assert.equal(one(unit, "Service", "SuccessExitStatus"), "143");
  assert.equal(one(unit, "Service", "Restart"), "on-failure");
  assert.equal(one(unit, "Service", "RestartSec"), "5");
  assert.equal(one(unit, "Service", "MemoryHigh"), "700M");
  assert.equal(one(unit, "Service", "MemoryMax"), "900M");
  assert.equal(one(unit, "Service", "UMask"), "0027");
  assert.equal(one(unit, "Install", "WantedBy"), "multi-user.target");
  // PORT and HOSTNAME come only from the slot env file; nothing VERCEL.
  assert.doesNotMatch(one(unit, "Service", "Environment"), /\b(PORT|HOSTNAME|VERCEL\w*)=/);
});

test("each slot resolves to its own league's user, files, cache and port", () => {
  const unit = units.get("ggd2l-us@.service");
  const ports = { "us-a": "3001", "us-b": "3002", "eu-a": "3011", "eu-b": "3012" };
  for (const [key, port] of Object.entries(ports)) {
    const [lg, slot] = key.split("-");
    const name = `ggd2l-${lg}@${slot}.service`;
    assert.equal(resolve(one(unit, "Unit", "Description"), name), `GGD2L ${lg} web, slot ${slot}`);
    assert.equal(resolve(one(unit, "Service", "User"), name), `ggd2l-${lg}`);
    assert.equal(resolve(one(unit, "Service", "WorkingDirectory"), name), `/srv/ggd2l/${lg}/slots/${slot}`);
    assert.deepEqual(all(unit, "Service", "EnvironmentFile").map((v) => resolve(v, name)), [
      `/etc/ggd2l/${lg}.env`,
      `/etc/ggd2l/${lg}-slot-${slot}.env`,
      `/srv/ggd2l/${lg}/slots/${slot}/.release.env`,
    ]);
    // The only writable path is this slot's own cache.
    assert.deepEqual(all(unit, "Service", "ReadWritePaths").map((v) => resolve(v, name)),
      [`/srv/ggd2l/${lg}/slots/${slot}/.next/cache`]);
    assert.ok(installKit.includes(`write_slot_env ${lg} ${slot} ${port}\n`), `install-kit.sh writes PORT=${port} for ${lg}-${slot}`);
  }
  assert.equal(new Set(Object.values(ports)).size, 4);
});

test("backups run hourly at :17 as ggd2l-ops, with only their own env (§5.1)", () => {
  const timer = units.get("ggd2l-backup@.timer");
  assert.equal(one(timer, "Timer", "OnCalendar"), "*-*-* *:17:00 UTC");
  assert.equal(one(timer, "Timer", "Persistent"), "true");
  assert.equal(one(timer, "Install", "WantedBy"), "timers.target");
  const unit = units.get("ggd2l-backup@.service");
  assert.equal(one(unit, "Service", "Type"), "oneshot");
  assert.equal(one(unit, "Service", "User"), "ggd2l-ops");
  assert.equal(one(unit, "Service", "Nice"), "10");
  assert.equal(one(unit, "Service", "IOSchedulingClass"), "idle");
  assert.equal(one(unit, "Service", "MemoryMax"), "256M");
  assert.equal(resolve(one(unit, "Service", "WorkingDirectory"), "ggd2l-backup@eu.service"), "/var/backups/ggd2l/eu");
  assert.equal(resolve(one(unit, "Service", "ExecStart"), "ggd2l-backup@eu.service"), "/usr/local/lib/ggd2l/backup-league.sh eu");
  assert.deepEqual(all(unit, "Service", "EnvironmentFile"), ["/etc/ggd2l/backup-%i.env", "-/etc/ggd2l/healthchecks.env"]);
  // The league folder only: everything the script writes, its lock included,
  // must live there (checked against the script below).
  assert.deepEqual(writable(unit), ["/var/backups/ggd2l/%i"]);
  assert.ok(!unit.has("Install"), "started by its timer only");
});

test("restore drills run weekly, US Sunday 10:30Z and Europe 11:30Z (§5.1)", () => {
  const timer = units.get("ggd2l-drill@.timer");
  assert.equal(one(timer, "Timer", "OnCalendar"), "Sun *-*-* 10:30:00 UTC");
  const dropIn = parseUnit(read("systemd/ggd2l-drill@eu.timer.d/10-schedule.conf"), "eu drop-in");
  // The empty assignment clears the template's time; without it Europe would
  // run at both times.
  assert.deepEqual(all(dropIn, "Timer", "OnCalendar"), ["", "Sun *-*-* 11:30:00 UTC"]);
  const unit = units.get("ggd2l-drill@.service");
  assert.equal(one(unit, "Service", "Type"), "oneshot");
  assert.equal(one(unit, "Service", "User"), "ggd2l-ops");
  assert.equal(one(unit, "Service", "MemoryMax"), "700M");
  assert.deepEqual(all(unit, "Service", "EnvironmentFile"), ["/etc/ggd2l/drill.env", "-/etc/ggd2l/healthchecks.env"]);
  assert.equal(resolve(one(unit, "Service", "ExecStart"), "ggd2l-drill@us.service"), "/usr/local/lib/ggd2l/drill-league.sh us");
  // drill-league.sh refuses a league folder it cannot write (state/,
  // last-drill.json): without this every drill fails at "config".
  assert.deepEqual(writable(unit), ["/var/backups/ggd2l/%i"]);
  assert.ok(!unit.has("Install"));
});

test("the configuration archive runs daily as root and writes only its own folder (§5.1)", () => {
  const timer = units.get("ggd2l-config-archive.timer");
  assert.equal(one(timer, "Timer", "OnCalendar"), "*-*-* 04:47:00 UTC");
  assert.equal(one(timer, "Timer", "Persistent"), "true");
  assert.equal(one(timer, "Install", "WantedBy"), "timers.target");
  const unit = units.get("ggd2l-config-archive.service");
  assert.equal(one(unit, "Service", "Type"), "oneshot");
  assert.equal(one(unit, "Service", "User"), "root");
  assert.equal(one(unit, "Service", "ExecStart"), "/usr/local/lib/ggd2l/config-archive.sh");
  // No database URL and no league env: only the healthchecks ping URL.
  assert.deepEqual(all(unit, "Service", "EnvironmentFile"), ["-/etc/ggd2l/healthchecks.env"]);
  assert.deepEqual(writable(unit), ["/var/backups/ggd2l/config"]);
  assert.ok(!unit.has("Install"), "started by its timer only");
});

test("install-kit.sh creates every backup folder a unit is given to write", () => {
  // systemd fails a unit whose ReadWritePaths= names a missing directory.
  assert.match(installKit, /\n {2}ensure_dir 0700 ggd2l-ops:ggd2l-ops "\/var\/backups\/ggd2l\/\$\{lg\}"\n/);
  assert.match(installKit, /\nensure_dir 0700 root:root \/var\/backups\/ggd2l\/config\n/);
});

// Every folder or file a oneshot's script writes, its lock included, must lie
// inside the unit's ReadWritePaths=: ProtectSystem=strict makes the rest of the
// file system, /run included, read-only (EROFS on the box). Read from the
// scripts themselves: their top-level assignments with the GGD2L_* test hooks
// at their box defaults and the league as %i, the folders they work in, and
// every file they open for writing with exec. The scripts belong to the
// backup package and sit beside these units only once both are merged.
function scriptWrites(text, workDirs) {
  const vars = new Map([["lg", "%i"]]);
  const expand = (value) => value
    .replace(/\$\{GGD2L_[A-Z_]+:-([^}]*)\}/g, "$1")
    .replace(/\$\{([A-Za-z_]+)\}/g, (whole, name) => vars.get(name) ?? whole);
  for (const [, name, value] of text.matchAll(/^([A-Z_]+)="([^"]*)"$/gm)) vars.set(name, expand(value));
  const targets = workDirs.map((name) => {
    assert.ok(vars.has(name), `the script sets ${name}`);
    return vars.get(name);
  });
  for (const [, target] of text.matchAll(/^\s*exec \d+>>?"([^"]+)"/gm)) targets.push(expand(target));
  for (const target of targets) assert.match(target, /^\/[^$]*$/, `resolved ${target} to an absolute path`);
  return targets;
}
const SCRIPT_WRITES = [
  ["ggd2l-backup@.service", "backup/backup-league.sh", ["LEAGUE_DIR", "STATE_DIR"]],
  ["ggd2l-drill@.service", "backup/drill-league.sh", ["LEAGUE_DIR", "STATE_DIR"]],
  ["ggd2l-config-archive.service", "backup/config-archive.sh", ["OUT_DIR"]],
];
const haveScripts = SCRIPT_WRITES.every(([, script]) => existsSync(path.join(SELFHOST, script)));

test("every path a oneshot's script writes, its lock included, is writable in its unit",
  { skip: !haveScripts && "the backup scripts are not on this branch" }, () => {
    for (const [name, script, workDirs] of SCRIPT_WRITES) {
      const allowed = writable(units.get(name));
      for (const target of scriptWrites(read(script), workDirs))
        assert.ok(allowed.some((dir) => target === dir || target.startsWith(`${dir}/`)),
          `${name} must let ${script} write ${target} (it allows ${allowed.join(" ")})`);
    }
  });

test("the heartbeat runs every 5 minutes as ggd2l-ops (§5.2)", () => {
  assert.equal(one(units.get("ggd2l-heartbeat.timer"), "Timer", "OnCalendar"), "*-*-* *:00/5:00 UTC");
  const unit = units.get("ggd2l-heartbeat.service");
  assert.equal(one(unit, "Service", "Type"), "oneshot");
  assert.equal(one(unit, "Service", "User"), "ggd2l-ops");
  assert.equal(one(unit, "Service", "ExecStart"), "/usr/local/lib/ggd2l/heartbeat.sh");
  // healthchecks' ping URLs and Discord's webhook, each optional.
  assert.deepEqual(all(unit, "Service", "EnvironmentFile"), ["-/etc/ggd2l/healthchecks.env", "-/etc/ggd2l/alerts.env"]);
  // It writes only discord-alert.mjs's state, which systemd makes writable.
  assert.deepEqual(writable(unit), [], "the heartbeat only reads and pings");
  assert.equal(one(unit, "Service", "StateDirectory"), "ggd2l-alerts");
  assert.ok(!unit.has("Install"));
});

test("every backup, drill and config-archive run ends in its own Discord alert unit", () => {
  const triggered = {
    "ggd2l-backup@us.service": "ggd2l-backup@.service",
    "ggd2l-backup@eu.service": "ggd2l-backup@.service",
    "ggd2l-drill@us.service": "ggd2l-drill@.service",
    "ggd2l-drill@eu.service": "ggd2l-drill@.service",
    "ggd2l-config-archive.service": "ggd2l-config-archive.service",
  };
  // discord-alert.mjs knows exactly these keys, each for the unit that starts it.
  assert.deepEqual(Object.values(UNIT_ALERTS).map((alert) => alert.unit).sort(), Object.keys(triggered).sort());
  for (const [instance, file] of Object.entries(triggered)) {
    const unit = units.get(file);
    const failure = resolve(one(unit, "Unit", "OnFailure"), instance);
    // A failure posts; the next success posts the recovery (or nothing).
    assert.equal(resolve(one(unit, "Unit", "OnSuccess"), instance), failure, instance);
    const key = /^ggd2l-alert@(.+)\.service$/.exec(failure)?.[1];
    assert.equal(UNIT_ALERTS[key]?.unit, instance, `${failure} is the alert for ${instance}`);
  }
  // Nothing else starts an alert, and the alert unit starts nothing: no loop.
  for (const [name, unit] of units) {
    if (Object.values(triggered).includes(name)) continue;
    assert.deepEqual([...all(unit, "Unit", "OnFailure"), ...all(unit, "Unit", "OnSuccess")], [], name);
  }
});

test("the alert unit posts as ggd2l-ops with only the Discord settings, beside the heartbeat's state", () => {
  const unit = units.get("ggd2l-alert@.service");
  assert.equal(one(unit, "Service", "Type"), "oneshot");
  assert.equal(one(unit, "Service", "User"), "ggd2l-ops");
  assert.equal(one(unit, "Service", "ExecStart"), "/usr/bin/node /usr/local/lib/ggd2l/discord-alert.mjs unit %i");
  // No database URL, no league env, no healthchecks URLs.
  assert.deepEqual(all(unit, "Service", "EnvironmentFile"), ["-/etc/ggd2l/alerts.env"]);
  // The failed run's step comes from the journal.
  assert.equal(one(unit, "Service", "SupplementaryGroups"), "systemd-journal");
  assert.ok(installKit.includes("getent group systemd-journal"), "install-kit.sh checks the group exists");
  assert.equal(one(unit, "Service", "StateDirectory"), one(units.get("ggd2l-heartbeat.service"), "Service", "StateDirectory"));
  assert.deepEqual(writable(unit), []);
  assert.ok(!unit.has("Install"), "started only by the units it reports on, or by hand");
});

test("the tunnel and the bot run as the design says (§1.5, §7)", () => {
  const tunnel = units.get("cloudflared-ggd2l.service");
  assert.equal(one(tunnel, "Service", "User"), "cloudflared");
  assert.equal(one(tunnel, "Service", "ExecStart"),
    "/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run");
  assert.equal(one(tunnel, "Service", "Restart"), "always");
  assert.equal(one(tunnel, "Service", "MemoryMax"), "200M");
  assert.equal(one(tunnel, "Unit", "StartLimitIntervalSec"), "0");
  const bot = units.get("ggd2l-bot.service");
  assert.equal(one(bot, "Service", "User"), "ggd2l-bot");
  assert.equal(one(bot, "Service", "WorkingDirectory"), "/srv/ggd2l/bot/current/ops/dota-lobby-bot");
  assert.deepEqual(all(bot, "Service", "EnvironmentFile"), ["/etc/ggd2l/bot.env"]);
  assert.match(one(bot, "Service", "Environment"), /(^| )NODE_ENV=production( |$)/);
  assert.match(one(bot, "Service", "Environment"), /(^| )DOTA_BOT_STATE_DIR=\/var\/lib\/ggd2l-bot( |$)/);
  assert.match(one(bot, "Service", "Environment"), /(^| )HOST=127\.0\.0\.1 PORT=8090( |$)/);
  assert.equal(one(bot, "Service", "ExecStart"), "/usr/bin/node server.mjs");
  assert.equal(one(bot, "Service", "Restart"), "on-failure");
  assert.equal(one(bot, "Service", "RestartSec"), "30");
  assert.equal(one(bot, "Service", "MemoryMax"), "300M");
  assert.deepEqual(all(bot, "Service", "ReadWritePaths"), ["/var/lib/ggd2l-bot"]);
});

test("exactly one clock: no unit calls the automation endpoint (§9.2)", () => {
  for (const file of [...UNIT_FILES, ...DROP_INS])
    assert.doesNotMatch(read(`systemd/${file}`).replace(/^#.*$/gm, ""), /cron\/automation/, file);
  // Timers start only the backup, config archive, drill and heartbeat
  // oneshots, never a slot.
  assert.deepEqual(UNIT_FILES.filter((f) => f.endsWith(".timer")).map((f) => f.replace(".timer", ".service"))
    .map((service) => one(units.get(service), "Service", "Type")), ["oneshot", "oneshot", "oneshot", "oneshot"]);
});

test("every helper a unit runs is installed under /usr/local/lib/ggd2l by install-kit.sh", () => {
  const sources = {
    "env-contract.mjs": "agent/env-contract.mjs",
    "backup-league.sh": "backup/backup-league.sh",
    "drill-league.sh": "backup/drill-league.sh",
    "heartbeat.sh": "backup/heartbeat.sh",
    "config-archive.sh": "backup/config-archive.sh",
    "discord-alert.mjs": "backup/discord-alert.mjs",
  };
  const used = new Set();
  for (const unit of units.values())
    for (const key of ["ExecStartPre", "ExecStart"])
      for (const command of all(unit, "Service", key))
        for (const match of command.matchAll(/\/usr\/local\/lib\/ggd2l\/([\w.-]+)/g)) used.add(match[1]);
  assert.deepEqual([...used].sort(), Object.keys(sources).sort());
  for (const source of Object.values(sources))
    assert.ok(installKit.includes(`\n${source}\n`), `install-kit.sh REQUIRED lists ${source}`);
});

test("the agent and the env contract run from a real directory, never through a symlink", () => {
  // Node resolves symlinks in import.meta.url but not in process.argv[1], so a
  // module's main-module check is false through a symlinked path: ExecStartPre
  // would run env-contract.mjs and exit 0 without checking the env.
  assert.doesNotMatch(installKit, /ln -s[^\n]*\$\{LIB\}/);
  assert.match(installKit, /\nmv -T "\$\{STAGE\}" "\$\{LIB\}"\n/);
  assert.match(installKit, /\nexec \/usr\/bin\/node \/usr\/local\/lib\/ggd2l\/ggd2l-agent\.mjs "\$@"\n/);
});
