// discord-alert.mjs: the box's Discord alerts, driven through main() with a
// fake Discord, a fake systemctl/journalctl and a temporary state folder. The
// heartbeat's end-to-end run (heartbeat.sh piping into this) is in
// backup-scripts.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alertSettings, main, parseFacts, UNIT_ALERTS } from "./discord-alert.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789";
const TIM = "112233445566778899";
const INVOCATION = "0123456789abcdef0123456789abcdef";
// 2026-10-18 14:00Z.
const T0 = Date.UTC(2026, 9, 18, 14, 0) / 1000;

function harness(extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ggd2l-alert-test-"));
  const sent = [];
  const logs = [];
  const calls = [];
  let status = 204;
  let journal = "";
  let shown = "Result=success\nInvocationID=" + INVOCATION + "\n";
  const env = {
    ALERT_DEPLOY_ENV: "production",
    ALERT_DISCORD_WEBHOOK_URL: WEBHOOK,
    STATE_DIRECTORY: dir,
    ...extraEnv,
  };
  const overrides = {
    fetch: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(null, { status });
    },
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === "journalctl") return journal;
      if (command === "systemctl") return shown;
      return "";
    },
    log: (message) => logs.push(message),
    retryDelay: false,
  };
  let clock = T0;
  return {
    dir, sent, logs, calls, env,
    setStatus: (code) => { status = code; },
    setJournal: (text) => { journal = text; },
    setShown: (text) => { shown = text; },
    tick: (seconds) => { clock += seconds; },
    state: (key) => {
      const file = path.join(dir, `${key}.json`);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    },
    files: () => readdirSync(dir).sort(),
    unit: (key, monitor = {}) => main(["unit", key], { ...env, GGD2L_NOW: String(clock), ...monitor }, overrides),
    beat: (facts) => main(["heartbeat"], { ...env, GGD2L_NOW: String(clock) }, { ...overrides, stdin: facts }),
    contents: () => sent.map((s) => s.body.content),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const failedRun = (unit) => ({
  MONITOR_SERVICE_RESULT: "exit-code",
  MONITOR_EXIT_CODE: "exited",
  MONITOR_EXIT_STATUS: "1",
  MONITOR_INVOCATION_ID: INVOCATION,
  MONITOR_UNIT: unit,
});
const goodRun = (unit) => ({ MONITOR_SERVICE_RESULT: "success", MONITOR_INVOCATION_ID: INVOCATION, MONITOR_UNIT: unit });

test("only production posts, and only to a Discord webhook", () => {
  assert.equal(alertSettings({ ALERT_DISCORD_WEBHOOK_URL: WEBHOOK }).off, "ALERT_DEPLOY_ENV is not set");
  assert.equal(alertSettings({ ALERT_DEPLOY_ENV: "staging", ALERT_DISCORD_WEBHOOK_URL: WEBHOOK }).off, "ALERT_DEPLOY_ENV is not production");
  assert.equal(alertSettings({ ALERT_DEPLOY_ENV: "production" }).off, "ALERT_DISCORD_WEBHOOK_URL is not set");
  for (const bad of [`${WEBHOOK}?wait=true`, WEBHOOK.replace("discord.com", "evil.test"), ` ${WEBHOOK}`, "http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz"]) {
    assert.equal(alertSettings({ ALERT_DEPLOY_ENV: "production", ALERT_DISCORD_WEBHOOK_URL: bad }).off,
      "ALERT_DISCORD_WEBHOOK_URL is not a Discord webhook", bad);
  }
  assert.deepEqual(alertSettings({ ALERT_DEPLOY_ENV: "production", ALERT_DISCORD_WEBHOOK_URL: WEBHOOK, ALERT_PING_USER_ID: TIM }),
    { webhook: WEBHOOK, webhookId: "123456789012345678", ping: TIM });
});

test("with alerts off nothing posts and no state is written", async () => {
  const box = harness({ ALERT_DEPLOY_ENV: "staging" });
  try {
    assert.equal(await box.unit("backup-us", failedRun("ggd2l-backup@us.service")), 0);
    assert.equal(await box.beat("disk 99\n"), 0);
    assert.deepEqual(box.sent, []);
    assert.deepEqual(box.files(), []);
    assert.match(box.logs.join("\n"), /alerts are off: ALERT_DEPLOY_ENV is not production/);
  } finally {
    box.cleanup();
  }
});

test("a failed backup posts once with its step, and the next good run posts the recovery", async () => {
  const box = harness({ ALERT_PING_USER_ID: TIM });
  try {
    box.setJournal("backup-us: verified x\nbackup-us: could not upload backup-1.sql.gz.age\nbackup-us: FAILED at step upload (exit 1)\n");
    await box.unit("backup-us", failedRun("ggd2l-backup@us.service"));
    assert.deepEqual(box.calls, [["journalctl", "--no-pager", "-q", "-o", "cat", `_SYSTEMD_INVOCATION_ID=${INVOCATION}`]]);
    assert.equal(box.sent.length, 1);
    assert.equal(box.sent[0].url, WEBHOOK);
    assert.equal(box.sent[0].body.content,
      `<@${TIM}> 🔴 **The hourly US database backup failed** at step upload \\(exit 1\\). First look: \`journalctl -u ggd2l-backup@us.service\`.`);
    assert.deepEqual(box.sent[0].body.allowed_mentions, { parse: [], users: [TIM] });

    // The next hour fails too: nothing new.
    box.tick(3600);
    await box.unit("backup-us", failedRun("ggd2l-backup@us.service"));
    assert.equal(box.sent.length, 1);
    assert.equal(box.state("backup-us").failing, 2);

    box.tick(3600);
    await box.unit("backup-us", goodRun("ggd2l-backup@us.service"));
    assert.equal(box.sent.length, 2);
    assert.match(box.sent[1].body.content, /^🟢 The hourly US database backup passed again\. It had been failing since <t:\d+:f>\.$/);
    assert.deepEqual(box.sent[1].body.allowed_mentions, { parse: [] }, "a recovery pings nobody");

    // A good run after a good run posts nothing and writes nothing.
    const before = readFileSync(path.join(box.dir, "backup-us.json"), "utf8");
    box.tick(3600);
    await box.unit("backup-us", goodRun("ggd2l-backup@us.service"));
    assert.equal(box.sent.length, 2);
    assert.equal(readFileSync(path.join(box.dir, "backup-us.json"), "utf8"), before);
  } finally {
    box.cleanup();
  }
});

test("a run killed before its script could log says how it ended; a manual start asks systemctl", async () => {
  const box = harness();
  try {
    await box.unit("drill-eu", { MONITOR_SERVICE_RESULT: "oom-kill", MONITOR_UNIT: "ggd2l-drill@eu.service" });
    assert.equal(box.contents()[0], "🔴 **The weekly Europe restore drill failed** when it ran out of memory. First look: `journalctl -u ggd2l-drill@eu.service`.");
    assert.deepEqual(box.calls, [], "no journal read for a run that logged nothing");

    box.setShown(`Result=timeout\nInvocationID=${INVOCATION}\n`);
    await box.unit("config-archive");
    assert.deepEqual(box.calls[0], ["systemctl", "show", "-p", "Result", "-p", "InvocationID", "ggd2l-config-archive.service"]);
    assert.equal(box.contents()[1], "🔴 **The daily config archive failed** after running out of time. First look: `journalctl -u ggd2l-config-archive.service`.");
  } finally {
    box.cleanup();
  }
});

test("only the step and exit status leave the journal, escaped", async () => {
  const box = harness();
  try {
    box.setJournal("drill-us: [x](https://evil.test) @everyone FAILED at step restore (exit 3)\nsecret=hunter2\n");
    await box.unit("drill-us", failedRun("ggd2l-drill@us.service"));
    assert.equal(box.contents()[0], "🔴 **The weekly US restore drill failed** at step restore \\(exit 3\\). First look: `journalctl -u ggd2l-drill@us.service`.");
    box.setJournal("backup-eu: FAILED at step `rm -rf` (exit 1)\n");
    const reads = box.calls.length;
    await box.unit("backup-eu", failedRun("ggd2l-backup@eu.service"));
    assert.equal(box.contents()[1], "🔴 **The hourly Europe database backup failed** with an error. First look: `journalctl -u ggd2l-backup@eu.service`.");
    // No step line yet: it looked three times (journald may lag the failure).
    assert.equal(box.calls.length - reads, 3);
    assert.doesNotMatch(JSON.stringify(box.sent), /hunter2|evil|everyone/);
  } finally {
    box.cleanup();
  }
});

test("a post Discord refused changes nothing, so the next run posts it", async () => {
  const box = harness();
  try {
    box.setStatus(503);
    await box.unit("backup-eu", failedRun("ggd2l-backup@eu.service"));
    assert.equal(box.sent.length, 3, "three tries");
    assert.equal(box.state("backup-eu").alerted, false);
    assert.match(box.logs.join("\n"), /backup-eu: down NOT posted; the next run retries/);
    assert.doesNotMatch(box.logs.join("\n"), /webhooks|abcdefghij/, "the webhook never reaches a log");

    box.setStatus(204);
    box.tick(3600);
    await box.unit("backup-eu", failedRun("ggd2l-backup@eu.service"));
    assert.equal(box.state("backup-eu").alerted, true);
    assert.equal(box.sent.length, 4);

    // A 4xx is not retried.
    box.setStatus(404);
    box.tick(3600);
    await box.unit("backup-eu", goodRun("ggd2l-backup@eu.service"));
    assert.equal(box.sent.length, 5);
    assert.equal(box.state("backup-eu").alerted, true, "the recovery waits for a post that lands");
  } finally {
    box.cleanup();
  }
});

test("the test key posts a test alert and its recovery and keeps no state", async () => {
  const box = harness({ ALERT_PING_USER_ID: TIM });
  try {
    await box.unit("test");
    assert.equal(box.sent.length, 2);
    assert.match(box.contents()[0], new RegExp(`^<@${TIM}> 🧪 \\*\\*Test alert from `));
    assert.match(box.contents()[1], /^🟢 \*\*Test alert from .+:\*\* recovered\./);
    assert.deepEqual(box.files(), []);
    await box.unit("../etc/passwd");
    assert.match(box.logs.at(-1), /unknown alert key/);
    assert.deepEqual(box.files(), []);
  } finally {
    box.cleanup();
  }
});

const HEALTHY = [
  "leagues us eu",
  "ready us 200",
  "ready eu 200",
  "disk 40",
  "mem-available-kb 900000",
  "swap-used-kb 194300",
  "automation us 200 healthy",
  "automation eu 200 healthy",
  "bot disabled inactive",
].join("\n");
const facts = (...changes) => {
  const lines = HEALTHY.split("\n");
  for (const change of changes) {
    const [name, league] = change.split(" ");
    const keyed = name === "ready" || name === "automation";
    // Every failed unit is its own line.
    const index = name === "failed-unit" ? -1
      : lines.findIndex((line) => (keyed ? line.startsWith(`${name} ${league} `) : line.startsWith(`${name} `)));
    if (index >= 0) lines[index] = change;
    else lines.push(change);
  }
  return `${lines.join("\n")}\n`;
};

test("the first beat with a webhook says hello once; a healthy box says nothing more", async () => {
  const box = harness();
  try {
    await box.beat(HEALTHY);
    assert.equal(box.sent.length, 1);
    assert.match(box.contents()[0], /^👋 Alerts are on for \*\*.+\*\*: its disk, memory, swap and failed units/);
    assert.deepEqual(box.files(), ["hello.json"]);
    for (let i = 0; i < 5; i += 1) {
      box.tick(300);
      await box.beat(HEALTHY);
    }
    assert.equal(box.sent.length, 1);
    assert.deepEqual(box.files(), ["hello.json"], "a healthy beat writes nothing");
  } finally {
    box.cleanup();
  }
});

test("each problem posts once it has lasted long enough, in one message per beat, and clears the same way", async () => {
  const box = harness({ ALERT_PING_USER_ID: TIM });
  try {
    await box.beat(HEALTHY);
    const posts = () => box.sent.slice(1).map((s) => s.body.content);
    // The disk alerts at once; memory needs three beats in a row.
    box.tick(300);
    await box.beat(facts("disk 91", "mem-available-kb 100000"));
    assert.equal(posts().length, 1);
    assert.match(posts()[0], /^<@\d+> 🔴 \*\*.+\*\*: the disk is 91% full \(the alert line is 85%\)\./);
    box.tick(300);
    await box.beat(facts("disk 91", "mem-available-kb 100000"));
    box.tick(300);
    await box.beat(facts("disk 92", "mem-available-kb 100000", "swap-used-kb 2000000"));
    assert.equal(posts().length, 2);
    assert.match(posts()[1], /only 97 MB of memory available since <t:\d+:f>/);
    assert.doesNotMatch(posts()[1], /swap/, "swap has failed one beat only");

    // Both clear: the disk at the first good beat, memory at the second.
    box.tick(300);
    await box.beat(facts("disk 70"));
    assert.equal(posts().length, 3);
    assert.match(posts()[2], /^🟢 \*\*.+\*\*'s disk: back to normal \(70%\)\./);
    assert.ok(!posts()[2].startsWith("<@"), "a recovery pings nobody");
    box.tick(300);
    await box.beat(HEALTHY);
    assert.equal(posts().length, 4);
    assert.match(posts()[3], /^🟢 \*\*.+\*\*'s free memory: back to normal \(878 MB available\)\./);
    assert.deepEqual(box.files(), ["disk.json", "hello.json", "memory.json", "swap.json"]);
    assert.equal(box.state("disk").alerted, false);
  } finally {
    box.cleanup();
  }
});

test("a stale scheduler is the box's to report only while the site answers", async () => {
  const box = harness();
  try {
    await box.beat(HEALTHY);
    const stale = facts("automation us 503 stale");
    for (let i = 0; i < 3; i += 1) {
      box.tick(300);
      await box.beat(stale);
    }
    assert.equal(box.sent.length, 2);
    assert.match(box.contents()[1], /^🔴 \*\*GGD2L US\*\*: the site answers, but no scheduled pass has reached it since <t:\d+:f> \(`\/api\/health\/automation` says stale\)\. First look: the ggd2l-automation-scheduler Worker's logs in Cloudflare\.$/);

    // Europe's site is down: the Worker reports that, so the box stays quiet,
    // and a failed (not stale) pass is the Worker's too.
    for (let i = 0; i < 6; i += 1) {
      box.tick(300);
      await box.beat(facts("automation us 503 stale", "ready eu 530", "automation eu 503 stale"));
    }
    for (let i = 0; i < 6; i += 1) {
      box.tick(300);
      await box.beat(facts("automation us 503 stale", "automation eu 503 failed"));
    }
    assert.equal(box.sent.length, 2);

    box.tick(300);
    await box.beat(HEALTHY);
    box.tick(300);
    await box.beat(HEALTHY);
    assert.match(box.contents()[2], /^🟢 \*\*GGD2L US\*\*'s scheduled passes: back to normal \(healthy\)\./);
    assert.equal(box.sent.length, 3);
  } finally {
    box.cleanup();
  }
});

test("a failed unit posts after two beats unless its own alert already went out", async () => {
  const box = harness();
  try {
    await box.beat(HEALTHY);
    // The backup's own alert reached Discord.
    await box.unit("backup-us", failedRun("ggd2l-backup@us.service"));
    assert.equal(box.sent.length, 2);
    const failing = facts("failed-unit ggd2l-backup@us.service", "failed-unit ggd2l-us@b.service");
    box.tick(300);
    await box.beat(failing);
    box.tick(300);
    await box.beat(failing);
    assert.equal(box.sent.length, 3);
    assert.equal(box.contents()[2],
      `🔴 **${box.contents()[2].split("**")[1]}**: \`ggd2l-us@b.service\` has failed. First look: \`journalctl -u ggd2l-us@b.service\`; once it is fixed, \`sudo systemctl reset-failed ggd2l-us@b.service\`.`);
    box.tick(300);
    await box.beat(facts("failed-unit ggd2l-backup@us.service"));
    assert.equal(box.sent.length, 4);
    assert.match(box.contents()[3], /^🟢 `ggd2l-us@b\.service` on \*\*.+\*\*: back to normal \(cleared\)\./);

    // A drill whose own alert was lost (Discord was down) is reported here.
    box.setStatus(500);
    await box.unit("drill-eu", failedRun("ggd2l-drill@eu.service"));
    box.setStatus(204);
    const drill = facts("failed-unit ggd2l-drill@eu.service");
    box.tick(300);
    await box.beat(drill);
    box.tick(300);
    await box.beat(drill);
    assert.match(box.contents().at(-1), /`ggd2l-drill@eu\.service` has failed/);

    // The next drill fails too, and this time its own alert lands. The unit
    // is still failed, so the heartbeat must not call it back to normal.
    const before = box.sent.length;
    box.tick(300);
    await box.unit("drill-eu", failedRun("ggd2l-drill@eu.service"));
    assert.equal(box.sent.length, before + 1);
    box.tick(300);
    await box.beat(drill);
    assert.equal(box.sent.length, before + 1);
    box.tick(300);
    await box.beat(HEALTHY);
    assert.match(box.contents().at(-1), /^🟢 `ggd2l-drill@eu\.service` on \*\*.+\*\*: back to normal/);
  } finally {
    box.cleanup();
  }
});

test("an enabled lobby bot that stays down posts after four beats; a disabled one never does", async () => {
  const box = harness();
  try {
    await box.beat(HEALTHY);
    for (let i = 0; i < 6; i += 1) {
      box.tick(300);
      await box.beat(facts("bot disabled inactive"));
    }
    assert.equal(box.sent.length, 1);
    for (let i = 0; i < 4; i += 1) {
      box.tick(300);
      await box.beat(facts("bot enabled inactive"));
    }
    assert.equal(box.sent.length, 2);
    assert.match(box.contents()[1], /the lobby bot \(`ggd2l-bot`\) has not been running since <t:\d+:f>/);
  } finally {
    box.cleanup();
  }
});

test("an unknown measurement is never a problem", async () => {
  const box = harness();
  try {
    await box.beat(HEALTHY);
    for (let i = 0; i < 4; i += 1) {
      box.tick(300);
      await box.beat("leagues us eu\ndisk unknown\nmem-available-kb -1\nautomation us 000 unknown\nready us 000\nfailed-unit bad`name\n");
    }
    assert.equal(box.sent.length, 1);
    assert.deepEqual(box.files(), ["hello.json"]);
    assert.deepEqual(parseFacts("failed-unit a`b\nfailed-unit ok.service\ndisk 101\nleagues us ca").failedUnits, ["ok.service"]);
    assert.equal(parseFacts("disk 101").disk, null);
    assert.deepEqual(parseFacts("leagues us ca").leagues, ["us"]);
  } finally {
    box.cleanup();
  }
});

test("its alert keys are the backup, drill and config-archive units, nothing else", () => {
  assert.deepEqual(Object.keys(UNIT_ALERTS).sort(), ["backup-eu", "backup-us", "config-archive", "drill-eu", "drill-us"]);
});

test("run as a command it exits 0 whatever happens, and 2 only for a wrong command line", () => {
  const run = (args, env) => spawnSync(process.execPath, [path.join(HERE, "discord-alert.mjs"), ...args], {
    env: { PATH: process.env.PATH, ...env }, input: "disk 99\n", encoding: "utf8",
  });
  assert.equal(run([], {}).status, 2);
  assert.equal(run(["bogus"], {}).status, 2);
  assert.equal(run(["heartbeat"], {}).status, 0);
  const dir = mkdtempSync(path.join(tmpdir(), "ggd2l-alert-cli-"));
  try {
    const outbox = path.join(dir, "outbox");
    const result = run(["heartbeat"], {
      ALERT_DEPLOY_ENV: "production", ALERT_DISCORD_WEBHOOK_URL: WEBHOOK, STATE_DIRECTORY: path.join(dir, "state"),
      GGD2L_ALERT_OUTBOX: outbox,
    });
    // The state folder is systemd's to create; without it nothing is kept.
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /failed: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
