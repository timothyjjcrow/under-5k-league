// Runs the box's backup, drill, heartbeat and config-archive scripts against
// fakes of every outside tool (pg_dump, age, rclone, curl, flock, dropdb, df,
// systemctl). backup-league.sh uses the real scripts/backup-db.mjs and
// verify-backup.mjs. Works with macOS's bash 3.2 and Linux's bash 5.
//
// The last tests tie these scripts to the other kit packages once they share a
// tree: the agent's real `backup` and `drill` calls (WP-E1) and the units'
// sandboxes (WP-E2). On a branch without those files they skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const APP_PASSWORD = "a0b1c2d3e4f5a6b7c8d9";
const APP_URL = (lg) =>
  `postgresql://ggd2l_${lg}_app:${APP_PASSWORD}@127.0.0.1:5432/ggd2l_${lg}?schema=public&sslmode=disable&connection_limit=8&pool_timeout=10&connect_timeout=5`;
const REHEARSAL_PASSWORD = "f00dfacecafe0123";
const REHEARSAL_URL = `postgresql://ggd2l_rehearsal:${REHEARSAL_PASSWORD}@127.0.0.1:5432/ld2l_restore_test`;
const HC = {
  HC_PING_BACKUP_US: "https://hc-ping.com/11111111-backup-us",
  HC_PING_DRILL: "https://hc-ping.com/33333333-drill",
  HC_PING_BOX: "https://hc-ping.com/44444444-box",
  HC_PING_AUTOMATION: "https://hc-ping.com/55555555-automation",
  HC_PING_BOT: "https://hc-ping.com/66666666-bot",
  HC_PING_CONFIG: "https://hc-ping.com/77777777-config",
};
// 2026-10-16 15:17:00Z, the hour the first box backup runs.
const NOW = Date.UTC(2026, 9, 16, 15, 17) / 1000;
const RECEIPT_SECRET = "a-receipt-secret-that-must-never-sign-anything-here";

function fake(file, body) {
  writeFileSync(file, `#!${process.execPath}\n${body}`);
  chmodSync(file, 0o755);
}

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "ggd2l-backup-test-"));
  const bin = path.join(dir, "bin");
  const etc = path.join(dir, "etc");
  const root = path.join(dir, "backups");
  const log = path.join(dir, "calls.jsonl");
  for (const d of [bin, etc, path.join(root, "us"), path.join(root, "eu")]) {
    mkdirSync(d, { recursive: true });
  }
  const record = `const { appendFileSync, existsSync, fstatSync, readFileSync, writeFileSync, copyFileSync } = require("node:fs");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const record = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
const flag = (name) => existsSync(dir + "/" + name);
`;
  fake(path.join(bin, "pg_dump"), `${record}
record({ tool: "pg_dump", args, password: process.env.PGPASSWORD, user: process.env.PGUSER });
const file = args.find((arg) => arg.startsWith("--file=")).slice(7);
writeFileSync(file, "-- dump of " + process.env.PGDATABASE + "\\nSELECT 1;\\n");
`);
  fake(path.join(bin, "age"), `${record}
record({ tool: "age", args });
const out = args[args.indexOf("-o") + 1];
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  if (flag("age-fail")) process.exit(1);
  writeFileSync(out, Buffer.concat([Buffer.from("FAKE-AGE\\n"), ...chunks]));
});
`);
  fake(path.join(bin, "rclone"), `${record}
record({ tool: "rclone", args });
process.exit(flag("rclone-fail") ? 1 : 0);
`);
  // Records which file the inherited descriptor names, so a test can tell
  // where the script took its lock.
  fake(path.join(bin, "flock"), `${record}
let fd = null;
try {
  const info = fstatSync(Number(args[args.length - 1]), { bigint: true });
  fd = { dev: String(info.dev), ino: String(info.ino), directory: info.isDirectory() };
} catch {}
record({ tool: "flock", args, fd });
process.exit(flag("flock-busy") ? 1 : 0);
`);
  fake(path.join(bin, "dropdb"), `${record}
record({ tool: "dropdb", args, password: process.env.PGPASSWORD, database: process.env.PGDATABASE, user: process.env.PGUSER });
`);
  fake(path.join(bin, "df"), `${record}
const percent = flag("df-percent") ? readFileSync(dir + "/df-percent", "utf8").trim() : "40";
process.stdout.write("Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/vda1 50000000 20000000 30000000 " + percent + "% /\\n");
`);
  fake(path.join(bin, "systemctl"), `${record}
record({ tool: "systemctl", args });
if (args[0] === "list-units") {
  if (flag("failed-units")) process.stdout.write(readFileSync(dir + "/failed-units", "utf8"));
} else if (args[0] === "is-active") {
  process.exit(flag("bot-active") ? 0 : 3);
}
`);
  fake(path.join(bin, "curl"), `${record}
if (args.includes("-K")) {
  const config = readFileSync(0, "utf8");
  const url = /url = "([^"]*)"/.exec(config)[1];
  record({ tool: "curl", kind: "ping", url, body: args[args.indexOf("--data-binary") + 1], args });
  process.exit(0);
}
const url = args[args.length - 1];
const codes = flag("http.json") ? JSON.parse(readFileSync(dir + "/http.json", "utf8")) : {};
record({ tool: "curl", kind: "http", url, args });
process.stdout.write(String(codes[url] ?? 200));
`);
  writeFileSync(path.join(etc, "backup-recipients.txt"), "# Tim's offline key\nage1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq\n", { mode: 0o644 });
  writeFileSync(path.join(dir, "meminfo"), "MemTotal: 2000000 kB\nMemAvailable: 900000 kB\nSwapTotal: 4194300 kB\nSwapFree: 4000000 kB\n");

  // Tools for the drill: a fake rehearsal beside the real libpq helper.
  const drillTools = path.join(dir, "drill-tools");
  const makeDrillTools = (folder) => {
    const name = path.basename(folder);
    mkdirSync(path.join(folder, "scripts"), { recursive: true });
    mkdirSync(path.join(folder, "src", "lib"), { recursive: true });
    copyFileSync(path.join(REPO_ROOT, "src/lib/postgres-cli-env.mjs"), path.join(folder, "src/lib/postgres-cli-env.mjs"));
    writeFileSync(path.join(folder, "scripts/rehearse-backup-restore.mjs"), `${record.replace("require(\"node:fs\")", "await import(\"node:fs\")")}
record({ tool: "rehearse", tools: ${JSON.stringify(name)}, args, cwd: process.cwd(),
  receiptSecret: process.env.BACKUP_RECEIPT_SECRET ?? null, checkpointDisable: process.env.CHECKPOINT_DISABLE ?? null,
  restoreUrlSet: Boolean(process.env.PG_RESTORE_TEST_URL) });
console.log("Verified backup: " + args[0]);
for (let i = 0; i < 50; i += 1) console.log("COPY " + i);
if (flag("rehearse-fail")) { console.error("Restore rehearsal failed: boom"); process.exit(1); }
console.log("Restore rehearsal passed: 17 restored migrations were upgraded to 17 current migrations.");
`);
  };
  for (const name of ["current", "0123456789ab"]) makeDrillTools(path.join(drillTools, name));
  // Tools for the backup: the real repository scripts.
  const backupTools = path.join(dir, "backup-tools");
  mkdirSync(backupTools);
  symlinkSync(REPO_ROOT, path.join(backupTools, "current"));

  const env = {
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
    HOME: dir,
    GGD2L_ETC: etc,
    GGD2L_BACKUP_ROOT: root,
    GGD2L_MEMINFO: path.join(dir, "meminfo"),
    GGD2L_NOW: String(NOW),
  };
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return {
    dir, etc, root, env, calls, drillTools, makeDrillTools,
    set: (name, content = "") => writeFileSync(path.join(dir, name), content),
    run(script, args, extraEnv = {}) {
      return spawnSync("bash", [path.join(HERE, script), ...args], {
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        cwd: dir,
      });
    },
    backup(lg = "us", extraEnv = {}) {
      return this.run("backup-league.sh", [lg], {
        GGD2L_TOOLS_ROOT: backupTools,
        DIRECT_URL: APP_URL(lg),
        BACKUP_DIR: path.join(root, lg, "local"),
        BACKUP_RECEIPT_SECRET: RECEIPT_SECRET,
        ...extraEnv,
      });
    },
    drill(args = ["us"], extraEnv = {}) {
      return this.run("drill-league.sh", args, {
        GGD2L_TOOLS_ROOT: drillTools,
        PG_RESTORE_TEST_URL: REHEARSAL_URL,
        BACKUP_RECEIPT_SECRET: RECEIPT_SECRET,
        ...extraEnv,
      });
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const pings = (box) => box.calls().filter((call) => call.tool === "curl" && call.kind === "ping");
const uploads = (box) =>
  box.calls().filter((call) => call.tool === "rclone").map((call) => call.args[call.args.length - 1]);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const lastReport = (result) => JSON.parse(result.stdout.trim().split("\n").pop());
// The file a fake flock was handed, as {dev, ino, directory}.
const lockedFile = (box) => box.calls().filter((call) => call.tool === "flock").at(-1)?.fd ?? null;
const identity = (file) => {
  const info = statSync(file, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino), directory: info.isDirectory() };
};
const ago = (file, minutes) => {
  const when = new Date(Date.now() - minutes * 60_000);
  utimesSync(file, when, when);
};

function assertNoSecretInArgv(box) {
  for (const call of box.calls()) {
    const argv = JSON.stringify(call.args ?? []);
    for (const secret of [APP_PASSWORD, REHEARSAL_PASSWORD, RECEIPT_SECRET, ...Object.values(HC)]) {
      assert.ok(!argv.includes(secret), `${call.tool} argv carries a secret`);
    }
  }
}

test("an hourly backup dumps, verifies, encrypts, uploads and reports", () => {
  const box = sandbox();
  try {
    writeFileSync(path.join(box.etc, "rclone.conf"), "[r2]\ntype = s3\n");
    writeFileSync(path.join(box.etc, "healthchecks.env"), `HC_PING_BACKUP_US="${HC.HC_PING_BACKUP_US}"\n`);
    const result = box.backup();
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /receipt:/i);

    const report = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(report.ok, true);
    assert.equal(report.offsite, "uploaded");
    const local = path.join(box.root, "us", "local");
    const name = path.basename(report.file);
    assert.equal(path.dirname(report.file), local);
    assert.equal(report.sha256, sha256(report.file));
    for (const suffix of ["", ".sha256", ".metadata.json"]) {
      assert.ok(existsSync(`${report.file}${suffix}`));
    }
    // The encrypted copy holds exactly the gzipped dump (the fake age adds a header).
    const encrypted = readFileSync(report.ageFile);
    assert.equal(gunzipSync(encrypted.subarray("FAKE-AGE\n".length)).toString(), readFileSync(report.file, "utf8"));
    assert.equal(report.ageSha256, sha256(report.ageFile));
    assert.equal(readFileSync(`${report.ageFile}.sha256`, "utf8"), `${report.ageSha256}  ${name}.gz.age\n`);
    const ageCall = box.calls().find((call) => call.tool === "age");
    assert.deepEqual(ageCall.args.slice(0, 2), ["-R", path.join(box.etc, "backup-recipients.txt")]);

    const day = name.slice(7, 17);
    const hourly = `r2:ggd2l-backups/us/hourly/${day}/${name}.gz.age`;
    assert.equal(report.offsiteKey, hourly);
    assert.deepEqual(uploads(box), [
      hourly, `${hourly}.sha256`, `r2:ggd2l-backups/us/hourly/${day}/${name}.sha256`,
      `r2:ggd2l-backups/us/daily/2026-10-16/${name}.gz.age`,
      `r2:ggd2l-backups/us/daily/2026-10-16/${name}.gz.age.sha256`,
      `r2:ggd2l-backups/us/daily/2026-10-16/${name}.sha256`,
      `r2:ggd2l-backups/us/monthly/2026-10/${name}.gz.age`,
      `r2:ggd2l-backups/us/monthly/2026-10/${name}.gz.age.sha256`,
      `r2:ggd2l-backups/us/monthly/2026-10/${name}.sha256`,
    ]);
    assert.equal(report.daily, true);
    assert.equal(report.monthly, true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(box.root, "us/state/last-backup.json"), "utf8")), report);
    // The agent's `backup` and `status` read the copy in the league folder.
    assert.deepEqual(JSON.parse(readFileSync(path.join(box.root, "us/last-backup.json"), "utf8")), report);
    // The lock is a file in the league folder, the only place the unit may write.
    assert.deepEqual(lockedFile(box), identity(path.join(box.root, "us/state/.backup.lock")));

    const [ping] = pings(box);
    assert.equal(ping.url, HC.HC_PING_BACKUP_US);
    assert.equal(ping.body, `ok ${name} sha256=${report.sha256} offsite-uploaded`);
    assertNoSecretInArgv(box);

    // The next hour's backup uploads only hourly: today's daily already went.
    const second = box.backup();
    assert.equal(second.status, 0, second.stderr);
    const next = JSON.parse(second.stdout.trim().split("\n").pop());
    assert.equal(next.daily, false);
    assert.equal(uploads(box).filter((key) => key.includes("/daily/")).length, 3);
  } finally {
    box.cleanup();
  }
});

test("no daily copy before 03:00Z; the first backup after it is the day's daily", () => {
  const box = sandbox();
  try {
    writeFileSync(path.join(box.etc, "rclone.conf"), "[r2]\n");
    const early = Date.UTC(2026, 9, 17, 2, 17) / 1000;
    assert.equal(box.backup("us", { GGD2L_NOW: String(early) }).status, 0);
    assert.equal(uploads(box).filter((key) => key.includes("/daily/")).length, 0);
    const later = Date.UTC(2026, 9, 17, 4, 17) / 1000;
    const result = box.backup("us", { GGD2L_NOW: String(later) });
    const report = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(report.daily, true);
    assert.ok(uploads(box).some((key) => key.startsWith("r2:ggd2l-backups/us/daily/2026-10-17/")));
  } finally {
    box.cleanup();
  }
});

test("without R2, copies wait locally for 48 h of the offsite-pending flag, then the unit fails", () => {
  const box = sandbox();
  try {
    const pending = box.backup("us", { ...HC });
    assert.equal(pending.status, 1, "no rclone.conf and no flag fails");
    assert.match(pending.stderr, /no rclone.conf and no offsite-pending flag/);
    assert.equal(pings(box).at(-1).url, `${HC.HC_PING_BACKUP_US}/fail`);
    assert.equal(pings(box).at(-1).body, "backup-us failed: offsite-not-configured");
    // The dump itself was still taken and encrypted.
    assert.equal(readdirSync(path.join(box.root, "us/local")).filter((f) => f.endsWith(".sql")).length, 1);

    writeFileSync(path.join(box.etc, "offsite-pending"), `${NOW - 3600}\n`);
    const ok = box.backup("us", { ...HC });
    assert.equal(ok.status, 0, ok.stderr);
    const report = JSON.parse(ok.stdout.trim().split("\n").pop());
    assert.equal(report.offsite, "pending");
    assert.equal(report.offsiteKey, null);
    assert.match(ok.stderr, /offsite-pending: R2 is not configured; 2 encrypted copies wait/);
    assert.match(pings(box).at(-1).body, / offsite-pending$/);
    assert.deepEqual(uploads(box), []);

    writeFileSync(path.join(box.etc, "offsite-pending"), `${NOW - 48 * 3600}\n`);
    const expired = box.backup("us", { ...HC });
    assert.equal(expired.status, 1);
    assert.equal(pings(box).at(-1).body, "backup-us failed: offsite-pending-expired");

    writeFileSync(path.join(box.etc, "offsite-pending"), `${NOW + 3600}\n`);
    assert.equal(box.backup("us", { ...HC }).status, 1, "a flag dated in the future cannot extend the window");

    // Once R2 is configured, every queued copy goes up, oldest first.
    writeFileSync(path.join(box.etc, "rclone.conf"), "[r2]\n");
    const flushed = box.backup("us", { ...HC });
    assert.equal(flushed.status, 0, flushed.stderr);
    const hourly = uploads(box).filter((key) => key.includes("/hourly/") && key.endsWith(".gz.age"));
    assert.equal(hourly.length, 5);
    assert.deepEqual(hourly, [...hourly].sort());
    const offsite = readdirSync(path.join(box.root, "us/offsite"));
    assert.equal(offsite.filter((f) => f.endsWith(".gz.age")).length, 5);
    assert.equal(offsite.filter((f) => f.endsWith(".uploaded")).length, 5);
  } finally {
    box.cleanup();
  }
});

test("a failed upload fails the unit and leaves the copy queued", () => {
  const box = sandbox();
  try {
    writeFileSync(path.join(box.etc, "rclone.conf"), "[r2]\n");
    box.set("rclone-fail");
    const result = box.backup("us", { HC_PING_BACKUP_US: HC.HC_PING_BACKUP_US });
    assert.equal(result.status, 1);
    assert.equal(pings(box).at(-1).body, "backup-us failed: upload");
    const offsite = readdirSync(path.join(box.root, "us/offsite"));
    assert.equal(offsite.filter((f) => f.endsWith(".uploaded")).length, 0);
    assert.equal(existsSync(path.join(box.root, "us/state/last-backup.json")), false);
    assert.equal(existsSync(path.join(box.root, "us/last-backup.json")), false);
  } finally {
    box.cleanup();
  }
});

test("the backup refuses the wrong database role, folder, a .env beside it, or a held lock", () => {
  const box = sandbox();
  try {
    writeFileSync(path.join(box.etc, "rclone.conf"), "[r2]\n");
    const cases = [
      [{ DIRECT_URL: APP_URL("us").replace("ggd2l_us_app", "ggd2l_us_owner") }, /DIRECT_URL must be the ggd2l_us_app role/],
      [{ DIRECT_URL: APP_URL("eu") }, /DIRECT_URL must be the ggd2l_us_app role/],
      [{ DIRECT_URL: APP_URL("us").replace("127.0.0.1", "db.example.com") }, /DIRECT_URL must be/],
      [{ BACKUP_DIR: path.join(box.dir, "elsewhere") }, /BACKUP_DIR must be/],
    ];
    for (const [extra, message] of cases) {
      const result = box.backup("us", { HC_PING_BACKUP_US: HC.HC_PING_BACKUP_US, ...extra });
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.equal(pings(box).at(-1).body, "backup-us failed: config");
      assert.doesNotMatch(result.stderr, new RegExp(APP_PASSWORD));
    }
    writeFileSync(path.join(box.root, "us", ".env"), "BACKUP_RECEIPT_SECRET=x\n");
    assert.match(box.backup().stderr, /refusing to run beside a \.env/);
    rmSync(path.join(box.root, "us", ".env"));

    box.set("flock-busy");
    const busy = box.backup("us", { HC_PING_BACKUP_US: HC.HC_PING_BACKUP_US });
    assert.equal(busy.status, 1);
    assert.equal(pings(box).at(-1).body, "backup-us failed: lock");
    assert.equal(box.calls().filter((call) => call.tool === "pg_dump").length, 0);

    assert.equal(box.run("backup-league.sh", ["ca"]).status, 2);
    assert.equal(box.run("backup-league.sh", []).status, 2);
  } finally {
    box.cleanup();
  }
});

test("pruning drops old dumps and uploaded copies, never a copy that has not reached R2", () => {
  const box = sandbox();
  try {
    const local = path.join(box.root, "us/local");
    const offsite = path.join(box.root, "us/offsite");
    mkdirSync(local, { recursive: true });
    mkdirSync(offsite, { recursive: true });
    const old = path.join(local, "backup-2026-10-10T01-17-00-000-1.sql");
    for (const suffix of ["", ".sha256", ".metadata.json"]) writeFileSync(`${old}${suffix}`, "x", { mode: 0o600 });
    ago(old, 3 * 24 * 60);
    const recent = path.join(local, "backup-2026-10-16T13-17-00-000-1.sql");
    writeFileSync(recent, "x", { mode: 0o600 });
    ago(recent, 60);
    const uploaded = path.join(offsite, "backup-2026-09-30T01-17-00-000-1.sql.gz.age");
    const waiting = path.join(offsite, "backup-2026-09-30T02-17-00-000-1.sql.gz.age");
    for (const file of [uploaded, waiting]) {
      writeFileSync(file, "x");
      writeFileSync(`${file}.sha256`, "x");
      ago(file, 15 * 24 * 60);
    }
    writeFileSync(`${uploaded}.uploaded`, "r2:ggd2l-backups/us/hourly/2026-09-30/x\n");
    writeFileSync(path.join(box.etc, "offsite-pending"), `${NOW - 60}\n`);

    const result = box.backup();
    assert.equal(result.status, 0, result.stderr);
    for (const suffix of ["", ".sha256", ".metadata.json"]) assert.equal(existsSync(`${old}${suffix}`), false);
    assert.ok(existsSync(recent));
    assert.equal(existsSync(uploaded), false);
    assert.equal(existsSync(`${uploaded}.uploaded`), false);
    assert.ok(existsSync(waiting), "a copy that never reached R2 is kept");
    assert.match(result.stderr, /keeping backup-2026-09-30T02-17-00-000-1\.sql\.gz\.age: it has not reached R2/);
  } finally {
    box.cleanup();
  }
});

test("the drill restores the newest dump with the rehearsal role, then drops the scratch database", () => {
  const box = sandbox();
  try {
    const local = path.join(box.root, "us/local");
    mkdirSync(local, { recursive: true });
    for (const stamp of ["2026-10-16T13-17-00-000-1", "2026-10-16T14-17-00-000-1"]) {
      const file = path.join(local, `backup-${stamp}.sql`);
      writeFileSync(file, "x", { mode: 0o600 });
      writeFileSync(`${file}.sha256`, `${"a".repeat(64)}  backup-${stamp}.sql\n`, { mode: 0o600 });
    }
    const result = box.drill(["us"], { HC_PING_DRILL: HC.HC_PING_DRILL });
    assert.equal(result.status, 0, result.stderr);
    const newest = path.join(local, "backup-2026-10-16T14-17-00-000-1.sql");
    const rehearse = box.calls().find((call) => call.tool === "rehearse");
    assert.deepEqual(rehearse.args, [newest]);
    assert.equal(rehearse.tools, "current");
    assert.equal(rehearse.receiptSecret, null);
    assert.equal(rehearse.checkpointDisable, "1");
    assert.equal(rehearse.restoreUrlSet, true);
    assert.equal(path.basename(rehearse.cwd), "us");

    const drops = box.calls().filter((call) => call.tool === "dropdb");
    assert.equal(drops.length, 1);
    assert.deepEqual(drops[0].args, ["--if-exists", "--force", "ld2l_restore_test"]);
    assert.equal(drops[0].password, REHEARSAL_PASSWORD);
    assert.equal(drops[0].user, "ggd2l_rehearsal");
    assert.equal(drops[0].database, "postgres");

    const report = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(report.dump, newest);
    assert.equal(report.dumpSha256, "a".repeat(64));
    assert.ok(existsSync(path.join(box.root, "us/state/last-drill.json")));
    assert.equal(pings(box).at(-1).url, HC.HC_PING_DRILL);
    assert.equal(pings(box).at(-1).body, `ok backup-2026-10-16T14-17-00-000-1.sql sha256=${"a".repeat(64)}`);
    // Both leagues' drills lock the shared backups folder through a read-only
    // descriptor: nothing outside the league folder has to be writable.
    assert.deepEqual(lockedFile(box), identity(box.root));
    // Only the tail of the restore's output reaches the journal.
    assert.doesNotMatch(result.stderr, /COPY 5\n/);
    assert.match(result.stderr, /Restore rehearsal passed/);
    assert.deepEqual(readdirSync(path.join(box.root, "us/state")).filter((f) => f.startsWith(".drill-output")), []);
    assertNoSecretInArgv(box);
  } finally {
    box.cleanup();
  }
});

test("a failed drill still drops the scratch database and pings /fail", () => {
  const box = sandbox();
  try {
    const local = path.join(box.root, "eu/local");
    mkdirSync(local, { recursive: true });
    const file = path.join(local, "backup-2026-10-16T14-17-00-000-1.sql");
    writeFileSync(file, "x", { mode: 0o600 });
    writeFileSync(`${file}.sha256`, `${"b".repeat(64)}  ${path.basename(file)}\n`, { mode: 0o600 });
    box.set("rehearse-fail");
    const result = box.drill(["eu", "0123456789ab0123456789ab0123456789ab0123"], { HC_PING_DRILL: HC.HC_PING_DRILL });
    assert.equal(result.status, 1);
    assert.equal(box.calls().find((call) => call.tool === "rehearse").tools, "0123456789ab");
    assert.equal(box.calls().filter((call) => call.tool === "dropdb").length, 1);
    assert.equal(pings(box).at(-1).url, `${HC.HC_PING_DRILL}/fail`);
    assert.equal(pings(box).at(-1).body, "drill-eu failed: restore");
    assert.equal(existsSync(path.join(box.root, "eu/state/last-drill.json")), false);
  } finally {
    box.cleanup();
  }
});

test("the drill refuses a non-scratch target, a missing dump and a malformed SHA", () => {
  const box = sandbox();
  try {
    const local = path.join(box.root, "us/local");
    mkdirSync(local, { recursive: true });
    const noDump = box.drill(["us"]);
    assert.equal(noDump.status, 1);
    assert.match(noDump.stderr, /no local dump/);
    const file = path.join(local, "backup-2026-10-16T14-17-00-000-1.sql");
    writeFileSync(file, "x", { mode: 0o600 });
    writeFileSync(`${file}.sha256`, `${"c".repeat(64)}  ${path.basename(file)}\n`, { mode: 0o600 });
    for (const url of [
      REHEARSAL_URL.replace("ld2l_restore_test", "ggd2l_us"),
      REHEARSAL_URL.replace("ggd2l_rehearsal", "ggd2l_us_owner"),
      REHEARSAL_URL.replace("127.0.0.1", "10.0.0.5"),
    ]) {
      const result = box.drill(["us"], { PG_RESTORE_TEST_URL: url });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /PG_RESTORE_TEST_URL must be ggd2l_rehearsal/);
    }
    assert.equal(box.calls().filter((call) => call.tool === "rehearse" || call.tool === "dropdb").length, 0);
    assert.equal(box.drill(["us", "abc"]).status, 2);
    assert.equal(box.drill(["us", "0123456789ab0123456789ab0123456789ab012G"]).status, 2);
  } finally {
    box.cleanup();
  }
});

// One newest dump with its sidecar in <root>/<lg>/local.
function seedDump(root, lg, shaChar = "d") {
  const local = path.join(root, lg, "local");
  mkdirSync(local, { recursive: true });
  const file = path.join(local, "backup-2026-10-16T14-17-00-000-1.sql");
  writeFileSync(file, "x", { mode: 0o600 });
  writeFileSync(`${file}.sha256`, `${shaChar.repeat(64)}  ${path.basename(file)}\n`, { mode: 0o600 });
  return file;
}

test("the pre-migration drill restores with the tools GGD2L_TOOLS_DIR names, never tools/current", () => {
  const box = sandbox();
  try {
    seedDump(box.root, "us");
    // The agent's call: the league alone, the commit's clone in the environment.
    const named = path.join(box.drillTools, "0123456789ab");
    const result = box.drill(["us"], { GGD2L_TOOLS_DIR: named, HC_PING_DRILL: HC.HC_PING_DRILL });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(box.calls().filter((call) => call.tool === "rehearse").map((call) => call.tools), ["0123456789ab"]);
    assert.equal(lastReport(result).tools, named);
    assert.match(result.stderr, /restoring backup-2026-10-16T14-17-00-000-1\.sql with .*\/0123456789ab\n/);

    // The SHA as an argument, alone or agreeing with the environment, also works.
    const sha = "0123456789ab0123456789ab0123456789ab0123";
    assert.equal(box.drill(["us", sha], { GGD2L_TOOLS_DIR: named }).status, 0);
    assert.equal(box.drill(["us", sha]).status, 0);
    assert.deepEqual(box.calls().filter((call) => call.tool === "rehearse").map((call) => call.tools),
      ["0123456789ab", "0123456789ab", "0123456789ab"]);
  } finally {
    box.cleanup();
  }
});

test("the drill refuses a GGD2L_TOOLS_DIR it cannot trust instead of falling back to tools/current", () => {
  const box = sandbox();
  try {
    seedDump(box.root, "us");
    const elsewhere = path.join(box.dir, "elsewhere", "0123456789ab");
    box.makeDrillTools(elsewhere);
    const refusals = [
      [{ GGD2L_TOOLS_DIR: "" }, []],
      [{ GGD2L_TOOLS_DIR: path.join(box.drillTools, "current") }, []],
      [{ GGD2L_TOOLS_DIR: `${path.join(box.drillTools, "0123456789ab")}/` }, []],
      [{ GGD2L_TOOLS_DIR: path.join(box.drillTools, "0123456789AB") }, []],
      [{ GGD2L_TOOLS_DIR: path.join(box.drillTools, "0123456789a") }, []],
      [{ GGD2L_TOOLS_DIR: elsewhere }, []],
      [{ GGD2L_TOOLS_DIR: path.join(box.drillTools, "0123456789ab") }, ["fedcba9876543210fedcba9876543210fedcba98"]],
    ];
    for (const [extra, sha] of refusals) {
      const result = box.drill(["us", ...sha], { ...extra, HC_PING_DRILL: HC.HC_PING_DRILL });
      assert.equal(result.status, 2, JSON.stringify(extra));
      assert.match(result.stderr, /GGD2L_TOOLS_DIR/);
    }
    assert.deepEqual(box.calls().filter((call) => ["rehearse", "dropdb", "flock", "curl"].includes(call.tool)), []);
  } finally {
    box.cleanup();
  }
});

test("the drill pings only the one drill check", () => {
  const box = sandbox();
  try {
    seedDump(box.root, "eu");
    assert.equal(box.drill(["eu"], { HC_PING_DRILL_EU: "https://hc-ping.com/99999999-drill-eu" }).status, 0);
    assert.deepEqual(pings(box), [], "a per-league key is not a check the design has");
    assert.equal(box.drill(["eu"], { HC_PING_DRILL: HC.HC_PING_DRILL }).status, 0);
    assert.deepEqual(pings(box).map((ping) => ping.url), [HC.HC_PING_DRILL]);
  } finally {
    box.cleanup();
  }
});

// Root ignores file modes, so the sandbox below would prove nothing as root.
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

test("the backup and the drill write only inside their own league folder, as the units' sandboxes allow",
  { skip: RUNNING_AS_ROOT && "file modes do not bind root" }, () => {
    const box = sandbox();
    const home = path.join(box.dir, "home");
    // Everything a strict unit mounts read-only: the backups root and the other
    // league, /etc/ggd2l, the tools clones and the home folder.
    const readOnly = [box.root, path.join(box.root, "eu"), box.etc, box.drillTools,
      path.join(box.drillTools, "current"), path.join(box.drillTools, "0123456789ab"), home];
    try {
      mkdirSync(home);
      writeFileSync(path.join(box.etc, "rclone.conf"), "[r2]\n");
      for (const dir of readOnly) chmodSync(dir, 0o555);

      const backup = box.backup("us", { HOME: home });
      assert.equal(backup.status, 0, backup.stderr);
      const drill = box.drill(["us"], { HOME: home });
      assert.equal(drill.status, 0, drill.stderr);
      assert.equal(lastReport(drill).dump, lastReport(backup).file);

      // A drill unit that cannot write its league folder fails at config and says why.
      chmodSync(path.join(box.root, "us"), 0o555);
      const blocked = box.drill(["us"], { HOME: home, HC_PING_DRILL: HC.HC_PING_DRILL });
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /the unit needs ReadWritePaths=\/var\/backups\/ggd2l\/us/);
      assert.equal(pings(box).at(-1).body, "drill-us failed: config");
    } finally {
      for (const dir of [...readOnly, path.join(box.root, "us")]) {
        if (existsSync(dir)) chmodSync(dir, 0o755);
      }
      box.cleanup();
    }
  });

test("a healthy box pings box, automation and bot; URLs travel on stdin only", () => {
  const box = sandbox();
  try {
    writeFileSync(path.join(box.etc, "healthchecks.env"),
      `HC_PING_BOX="${HC.HC_PING_BOX}"\nHC_PING_AUTOMATION='${HC.HC_PING_AUTOMATION}'\nexport HC_PING_BOT=${HC.HC_PING_BOT}\n`);
    box.set("bot-active");
    const result = box.run("heartbeat.sh", []);
    assert.equal(result.status, 0, result.stderr);
    const sent = pings(box);
    assert.deepEqual(sent.map((ping) => ping.url), [HC.HC_PING_BOX, HC.HC_PING_AUTOMATION, HC.HC_PING_BOT]);
    assert.equal(sent[0].body, "ok disk=40% memAvailableMb=878 swapUsedMb=189");
    const probed = box.calls().filter((call) => call.kind === "http").map((call) => call.url);
    assert.deepEqual(probed, [
      "https://us.ggd2l.com/api/health/ready", "https://eu.ggd2l.com/api/health/ready",
      "https://us.ggd2l.com/api/health/automation", "https://eu.ggd2l.com/api/health/automation",
    ]);
    assertNoSecretInArgv(box);
  } finally {
    box.cleanup();
  }
});

test("an unhealthy box pings /fail with every failed check; automation and bot fall silent", () => {
  const box = sandbox();
  try {
    box.set("http.json", JSON.stringify({
      "https://eu.ggd2l.com/api/health/ready": 503,
      "https://us.ggd2l.com/api/health/automation": 503,
    }));
    box.set("df-percent", "91");
    box.set("failed-units", "ggd2l-drill@us.service loaded failed failed GGD2L drill\n");
    writeFileSync(path.join(box.dir, "meminfo"), "MemAvailable: 100000 kB\nSwapTotal: 4194300 kB\nSwapFree: 2000000 kB\n");
    const result = box.run("heartbeat.sh", [], {
      HC_PING_BOX: HC.HC_PING_BOX, HC_PING_AUTOMATION: HC.HC_PING_AUTOMATION, HC_PING_BOT: HC.HC_PING_BOT,
    });
    assert.equal(result.status, 0, result.stderr);
    const sent = pings(box);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, `${HC.HC_PING_BOX}/fail`);
    assert.equal(sent[0].body,
      "fail: ready-eu disk memory swap failed-units disk=91% memAvailableMb=97 swapUsedMb=2142 failed: ggd2l-drill@us.service");
    assert.match(result.stderr, /automation not healthy: us/);
    assert.match(result.stderr, /ggd2l-bot.service is not active/);
  } finally {
    box.cleanup();
  }
});

test("the heartbeat probes only the live leagues and pings nothing when unconfigured", () => {
  const box = sandbox();
  try {
    const result = box.run("heartbeat.sh", [], { GGD2L_HEARTBEAT_LEAGUES: "us" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(pings(box), []);
    assert.ok(box.calls().filter((call) => call.kind === "http").every((call) => call.url.startsWith("https://us.")));
    assert.equal(box.run("heartbeat.sh", [], { GGD2L_HEARTBEAT_LEAGUES: "us ca" }).status, 1);
  } finally {
    box.cleanup();
  }
});

test("the config archive is encrypted from the stream, uploaded under config/, and never plaintext on disk", () => {
  const box = sandbox();
  try {
    const ggd2l = path.join(box.dir, "conf", "ggd2l");
    const caddy = path.join(box.dir, "conf", "caddy");
    mkdirSync(path.join(ggd2l, "secrets"), { recursive: true });
    mkdirSync(caddy, { recursive: true });
    writeFileSync(path.join(ggd2l, "us.env"), "AUTH_SECRET=example\n");
    writeFileSync(path.join(ggd2l, "secrets", "us-app.pw"), "deadbeef\n");
    writeFileSync(path.join(caddy, "Caddyfile"), "{}\n");
    writeFileSync(path.join(box.etc, "rclone.conf"), "[r2]\n");
    const dirs = `${ggd2l} ${path.join(box.dir, "conf", "cloudflared")} ${caddy}`;
    const result = box.run("config-archive.sh", [], { GGD2L_CONFIG_DIRS: dirs, HC_PING_CONFIG: HC.HC_PING_CONFIG });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /skipping .*cloudflared: not present/);
    const report = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.match(path.basename(report.file), /^config-20261016T151700Z\.tar\.gz\.age$/);
    assert.equal(report.offsiteKey, `r2:ggd2l-backups/config/2026-10-16/${path.basename(report.file)}`);
    assert.deepEqual(uploads(box), [report.offsiteKey, `${report.offsiteKey}.sha256`]);
    assert.equal(report.sha256, sha256(report.file));

    const tarball = gunzipSync(readFileSync(report.file).subarray("FAKE-AGE\n".length));
    const listing = spawnSync("tar", ["-tf", "-"], { input: tarball, encoding: "utf8" }).stdout;
    assert.match(listing, /conf\/ggd2l\/us\.env/);
    assert.match(listing, /conf\/ggd2l\/secrets\/us-app\.pw/);
    assert.match(listing, /conf\/caddy\/Caddyfile/);
    const files = readdirSync(path.dirname(report.file)).sort();
    assert.deepEqual(files, [
      path.basename(report.file), `${path.basename(report.file)}.sha256`,
      `${path.basename(report.file)}.uploaded`, "last-archive.json",
    ]);
    assert.equal(pings(box).at(-1).url, HC.HC_PING_CONFIG);
    assertNoSecretInArgv(box);

    const missing = box.run("config-archive.sh", [], { GGD2L_CONFIG_DIRS: path.join(box.dir, "absent") });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /absent is missing/);
  } finally {
    box.cleanup();
  }
});

// --- Ties to the other kit packages ------------------------------------------
// These read files other packages own (the agent, the units) and skip on a
// branch that does not have them yet; on the integration branch they run.

const AGENT_DIR = path.resolve(HERE, "../agent");
const UNIT_DIR = path.resolve(HERE, "../systemd");
const hasAgent = ["layout.mjs", "runner.mjs", "tools.mjs"].every((name) => existsSync(path.join(AGENT_DIR, name)));

test("the agent's backup and drill calls reach these scripts' record and tools",
  { skip: !hasAgent && "the agent (WP-E1) is not on this branch" }, async () => {
    const agent = (name) => import(pathToFileURL(path.join(AGENT_DIR, name)).href);
    const { BIN, createLayout } = await agent("layout.mjs");
    const { createRunner } = await agent("runner.mjs");
    const { backup, drill } = await agent("tools.mjs");
    const box = sandbox();
    try {
      const layout = createLayout(path.join(box.dir, "box"));
      const backupRoot = path.dirname(layout.backupDir("us"));
      for (const lg of ["us", "eu"]) mkdirSync(layout.backupDir(lg), { recursive: true });
      const sha = "0123456789ab0123456789ab0123456789ab0123";
      box.makeDrillTools(layout.toolsCurrent);
      box.makeDrillTools(layout.toolsDir(sha));
      mkdirSync(path.join(layout.toolsDir(sha), "node_modules"));
      writeFileSync(path.join(layout.toolsDir(sha), "node_modules/.package-lock.json"), "{}");
      mkdirSync(path.dirname(layout.drillEnv), { recursive: true });
      writeFileSync(layout.drillEnv, `PG_RESTORE_TEST_URL=${REHEARSAL_URL}\n`);
      writeFileSync(path.join(box.etc, "rclone.conf"), "[r2]\n");

      // The agent's own runner (its argv secret check included). A unit start or
      // systemd-run of a script runs the real script as the unit would.
      const results = {};
      const answer = (result) => ({ code: result.status, stdout: result.stdout, stderr: result.stderr });
      const spawnImpl = async (command, args) => {
        if (command === BIN.runuser && args.includes("rev-parse")) return { code: 0, stdout: `${sha}\n`, stderr: "" };
        if (command === BIN.systemctl && args[0] === "show") return { code: 0, stdout: `${results[args.at(-1)]}\n`, stderr: "" };
        if (command === BIN.systemctl && args[0] === "start") {
          const [, kind, lg] = /^ggd2l-(backup|drill)@(us|eu)\.service$/.exec(args.at(-1));
          const result = kind === "backup"
            ? box.backup(lg, { GGD2L_BACKUP_ROOT: backupRoot, BACKUP_DIR: path.join(backupRoot, lg, "local") })
            : box.drill([lg], { GGD2L_BACKUP_ROOT: backupRoot, GGD2L_TOOLS_ROOT: layout.tools });
          results[args.at(-1)] = result.status === 0 ? "success" : "exit-code";
          return answer(result);
        }
        if (command === BIN.systemdRun) {
          const env = { GGD2L_BACKUP_ROOT: backupRoot, GGD2L_TOOLS_ROOT: layout.tools, PG_RESTORE_TEST_URL: "" };
          for (let i = 0; i < args.length - 1; i += 1) {
            if (args[i] === "-E" || args[i] === "--setenv") {
              const [key, ...value] = args[i + 1].split("=");
              env[key] = value.join("=");
            } else if (args[i] === "-p" && args[i + 1].startsWith("EnvironmentFile=")) {
              for (const line of readFileSync(args[i + 1].slice("EnvironmentFile=".length), "utf8").split("\n")) {
                const eq = line.indexOf("=");
                if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
              }
            }
          }
          const helper = args.indexOf(layout.helper("drill-league.sh"));
          assert.ok(helper > 0, "the agent runs the installed drill-league.sh");
          return answer(box.drill(args.slice(helper + 1), env));
        }
        // The agent's own housekeeping (log owners and modes) succeeds.
        return { code: 0, stdout: "", stderr: "" };
      };
      const ctx = { layout, runner: createRunner({ spawnImpl }), now: () => NOW * 1000 };

      const reported = await backup(ctx, "us");
      const record = JSON.parse(readFileSync(path.join(backupRoot, "us/state/last-backup.json"), "utf8"));
      assert.deepEqual(reported, { file: path.basename(record.file), sha256: record.sha256, offsiteKey: record.offsiteKey });
      assert.match(reported.offsiteKey, /^r2:ggd2l-backups\/us\/hourly\//, "the agent reports the R2 key, not the fallback's null");

      await drill(ctx, "us");
      await drill(ctx, "us", sha);
      const used = box.calls().filter((call) => call.tool === "rehearse").map((call) => call.tools);
      assert.deepEqual(used, ["current", sha.slice(0, 12)], "the pre-migration drill restores with the new commit's tools");
    } finally {
      box.cleanup();
    }
  });

// [Section] Key=value settings of a unit file, each key's values in order.
function unitSettings(file) {
  const settings = {};
  let section = "";
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) (settings[`${section}.${line.slice(0, eq).trim()}`] ??= []).push(line.slice(eq + 1).trim());
  }
  return settings;
}

// Under ProtectSystem=strict only ReadWritePaths= (and the API file systems)
// stay writable; a script that writes elsewhere fails with EROFS on the box.
function assertMayWrite(unit, needed) {
  const settings = unitSettings(path.join(UNIT_DIR, unit));
  if (settings["Service.ProtectSystem"]?.at(-1) !== "strict") return;
  const writable = (settings["Service.ReadWritePaths"] ?? [])
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean)
    .map((entry) => entry.replace(/^[-+]+/, ""));
  for (const target of needed) {
    assert.ok(writable.some((entry) => target === entry || target.startsWith(`${entry}/`)),
      `${unit} has ProtectSystem=strict but no ReadWritePaths= for ${target} (it has: ${writable.join(" ") || "none"})`);
  }
}

const hasUnits = existsSync(path.join(UNIT_DIR, "ggd2l-backup@.service"));

test("the backup and drill units let the scripts write their league folder",
  { skip: !hasUnits && "the units (WP-E2) are not on this branch" }, () => {
    // Every write, the locks included, is under the league folder; the drill's
    // shared lock is a read-only descriptor of /var/backups/ggd2l.
    assertMayWrite("ggd2l-backup@.service", ["/var/backups/ggd2l/%i", "/var/backups/ggd2l/%i/state"]);
    assertMayWrite("ggd2l-drill@.service", ["/var/backups/ggd2l/%i", "/var/backups/ggd2l/%i/state"]);
  });

test("the README's config-archive unit is one the kit ships, and its sandbox lets the script write",
  { skip: !hasUnits && "the units (WP-E2) are not on this branch" }, () => {
    const readme = readFileSync(path.resolve(HERE, "../README.md"), "utf8");
    const cited = /ggd2l-config-archive/.test(readme);
    const shipped = existsSync(path.join(UNIT_DIR, "ggd2l-config-archive.timer"));
    assert.equal(cited, shipped, shipped
      ? "the kit ships ggd2l-config-archive.timer but the README never names it"
      : "the README cites ggd2l-config-archive, which the kit does not ship: say the archive is not scheduled");
    if (!shipped) return;
    const service = unitSettings(path.join(UNIT_DIR, "ggd2l-config-archive.service"));
    assert.ok(["root", undefined].includes(service["Service.User"]?.at(-1)), "the archive reads root-only folders");
    assertMayWrite("ggd2l-config-archive.service", ["/var/backups/ggd2l/config"]);
  });
