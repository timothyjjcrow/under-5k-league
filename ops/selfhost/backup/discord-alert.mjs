// Discord alerts from the box (ops/selfhost/README.md "Alerts"; docs/DECISIONS.md,
// Hosting). Runs as ggd2l-ops, two ways:
//
//   discord-alert.mjs unit <key>   from ggd2l-alert@<key>.service, which the
//       backup, drill and config-archive units start through OnFailure= and
//       OnSuccess=. A failed run posts once, with the step its script logged;
//       the next good run posts the recovery. <key> is backup-us, backup-eu,
//       drill-us, drill-eu or config-archive, or "test": a test alert and its
//       recovery, started by hand (`sudo systemctl start ggd2l-alert@test`).
//   discord-alert.mjs heartbeat    from heartbeat.sh, which pipes what it
//       measured on stdin (one fact per line). Posts when the disk, memory,
//       swap, a failed unit, a league's scheduled passes or the lobby bot
//       stays wrong for long enough, and when it is right again. A league the
//       box can't reach through Cloudflare is the scheduler Worker's to report
//       (ops/cloudflare-automation-worker/src/alerts.ts), so it is left out.
//
// The rules and the state shape are the scheduler Worker's, kept in step by
// src/lib/ops-alerts-parity.test.ts: post once after `after` bad checks in a
// row, remind after a day, post the recovery after `recoverAfter` good checks
// in a row. A post that fails changes no state, so the next check retries it.
// One heartbeat's posts go out as one message.
//
// Settings come from EnvironmentFile=-/etc/ggd2l/alerts.env (root, 0600):
//   ALERT_DISCORD_WEBHOOK_URL  the admin channel's webhook, a credential: it
//                              never reaches argv, a log or a message
//   ALERT_DEPLOY_ENV           must be exactly "production" for anything to
//                              post (a restored copy of the box sets staging)
//   ALERT_PING_USER_ID         optional: the one Discord user a failure pings
// Without them it only logs. State is one JSON file per alert key in
// $STATE_DIRECTORY (StateDirectory=ggd2l-alerts: /var/lib/ggd2l-alerts). It
// exits 0 once it has reported, so the units that run it never fail.
//
// Test hooks, never set on the box: GGD2L_ALERT_OUTBOX (a folder that receives
// each payload instead of Discord), GGD2L_NOW (epoch seconds).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- the rules (the Worker's alerts.ts, parity-tested) -------------------------

export const EMPTY_ALERT_STATE = Object.freeze({
  failing: 0,
  passing: 0,
  alerted: false,
  since: null,
  postedAt: null,
  detail: null,
});
export const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

/** One event through the alert rules. Pure. */
export function nextAlertStep(prev, event, rule) {
  if (!event.ok) {
    const state = {
      ...prev,
      failing: prev.failing + 1,
      passing: 0,
      since: prev.since ?? event.at,
      detail: event.detail ?? null,
    };
    if (!state.alerted && state.failing >= rule.after) {
      return { post: "down", state: { ...state, alerted: true, postedAt: event.at }, ifPostFails: state };
    }
    if (state.alerted && state.postedAt !== null && event.at - state.postedAt >= rule.remindMs) {
      return { post: "still-down", state: { ...state, postedAt: event.at }, ifPostFails: state };
    }
    return { post: null, state, ifPostFails: state };
  }
  if (!prev.alerted) return { post: null, state: EMPTY_ALERT_STATE, ifPostFails: EMPTY_ALERT_STATE };
  const state = { ...prev, passing: prev.passing + 1 };
  if (state.passing >= rule.recoverAfter) return { post: "recovered", state: EMPTY_ALERT_STATE, ifPostFails: state };
  return { post: null, state, ifPostFails: state };
}

export function sameAlertState(a, b) {
  return a.failing === b.failing && a.passing === b.passing && a.alerted === b.alerted &&
    a.since === b.since && a.postedAt === b.postedAt && a.detail === b.detail;
}

const nonNegativeInt = (value) => Number.isSafeInteger(value) && value >= 0;
const epochOrNull = (value) => value === null || nonNegativeInt(value);

/** A stored state, or the empty one for anything unreadable. */
export function readAlertState(value) {
  if (!value || typeof value !== "object") return EMPTY_ALERT_STATE;
  if (!nonNegativeInt(value.failing) || !nonNegativeInt(value.passing) || typeof value.alerted !== "boolean" ||
    !epochOrNull(value.since) || !epochOrNull(value.postedAt) ||
    !(value.detail === null || (typeof value.detail === "string" && value.detail.length <= 200))) {
    return EMPTY_ALERT_STATE;
  }
  const { failing, passing, alerted, since, postedAt, detail } = value;
  return { failing, passing, alerted, since, postedAt, detail };
}

// --- Discord (copies of src/lib/discord-webhook.mjs and discord-escape.ts) -----

const WEBHOOK_PATH = /^\/api\/(?:v(?:9|10)\/)?webhooks\/(\d{5,25})\/([A-Za-z0-9._-]{16,256})$/;

export function normalizeDiscordWebhookUrl(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 512) return null;
  if (input !== input.trim()) return null;
  if (!/^https:\/\/(?:discord\.com|discordapp\.com)\//.test(input)) return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || (url.hostname !== "discord.com" && url.hostname !== "discordapp.com") ||
    url.port || url.username || url.password || url.search || url.hash || !WEBHOOK_PATH.test(url.pathname)) {
    return null;
  }
  return input;
}

export function escapeDiscordText(raw, maxLen) {
  const flat = raw.replace(/[\r\n\t]+/g, " ").trim();
  const trimmed = maxLen != null && flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat;
  return trimmed
    .replace(/[\\*_~`|<>[\]()@#-]/g, (c) => `\\${c}`)
    .replace(/(https?):\/\//gi, "$1:​//")
    .replace(/\bwww\./gi, "www​.");
}

export function pingUserId(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value) ? value : null;
}

export function discordPayload(content, ping) {
  if (ping) return { content: `<@${ping}> ${content}`, allowed_mentions: { parse: [], users: [ping] } };
  return { content, allowed_mentions: { parse: [] } };
}

/** The settings, or why alerts are off. Only exactly "production" posts. */
export function alertSettings(env) {
  if (env.ALERT_DEPLOY_ENV !== "production") {
    return { off: env.ALERT_DEPLOY_ENV ? "ALERT_DEPLOY_ENV is not production" : "ALERT_DEPLOY_ENV is not set" };
  }
  const webhook = normalizeDiscordWebhookUrl(env.ALERT_DISCORD_WEBHOOK_URL);
  if (!webhook) {
    return { off: env.ALERT_DISCORD_WEBHOOK_URL ? "ALERT_DISCORD_WEBHOOK_URL is not a Discord webhook" : "ALERT_DISCORD_WEBHOOK_URL is not set" };
  }
  return { webhook, webhookId: WEBHOOK_PATH.exec(new URL(webhook).pathname)[1], ping: pingUserId(env.ALERT_PING_USER_ID) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST one message: up to three tries, waiting out a short 429. True only
 * for a 2xx. Logs no URL. With the outbox test hook, writes the payload there.
 */
export async function postDiscord(settings, payload, deps) {
  if (deps.outbox) {
    mkdirSync(deps.outbox, { recursive: true });
    const n = readdirSync(deps.outbox).length;
    writeFileSync(path.join(deps.outbox, `${String(n).padStart(3, "0")}.json`), JSON.stringify(payload));
    return true;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let wait = attempt * 3000;
    try {
      const response = await deps.fetch(settings.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text().catch(() => "");
      if (response.status >= 200 && response.status < 300) return true;
      deps.log(`Discord answered HTTP ${response.status}`);
      if (response.status === 429) {
        let after = Number.NaN;
        try {
          after = Number(JSON.parse(text).retry_after);
        } catch {
          // keep the default wait
        }
        if (Number.isFinite(after) && after >= 0 && after <= 10) wait = Math.ceil(after * 1000);
      } else if (response.status < 500) {
        return false;
      }
    } catch {
      deps.log("could not reach Discord");
    }
    if (attempt < 3) await sleep(deps.retryDelay ? wait : 0);
  }
  return false;
}

const discordTime = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;

function aboutDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

// --- state -----------------------------------------------------------------------

const KEY = /^[A-Za-z0-9@._:-]{1,120}$/;

function stateStore(dir) {
  const file = (key) => {
    if (!KEY.test(key)) throw new Error(`bad alert key ${key}`);
    return path.join(dir, `${key}.json`);
  };
  const readJson = (name) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    } catch {
      return null;
    }
  };
  const writeJson = (name, value) => {
    const target = path.join(dir, name);
    writeFileSync(`${target}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  };
  return {
    get: (key) => readAlertState(readJson(path.basename(file(key)))),
    put: (key, value) => writeJson(path.basename(file(key)), value),
    keys: (prefix) => {
      try {
        return readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
          .map((f) => f.slice(0, -5)).filter((k) => KEY.test(k)).sort();
      } catch {
        return [];
      }
    },
    hello: () => readJson("hello.json")?.webhookId ?? null,
    setHello: (webhookId) => writeJson("hello.json", { webhookId }),
  };
}

// --- the backup, drill and config-archive units ---------------------------------

export const UNIT_ALERTS = {
  "backup-us": { unit: "ggd2l-backup@us.service", what: "The hourly US database backup" },
  "backup-eu": { unit: "ggd2l-backup@eu.service", what: "The hourly Europe database backup" },
  "drill-us": { unit: "ggd2l-drill@us.service", what: "The weekly US restore drill" },
  "drill-eu": { unit: "ggd2l-drill@eu.service", what: "The weekly Europe restore drill" },
  "config-archive": { unit: "ggd2l-config-archive.service", what: "The daily config archive" },
};
const UNIT_RULE = { after: 1, recoverAfter: 1, remindMs: REMIND_AFTER_MS };
const RESULT_DETAIL = {
  timeout: "after running out of time",
  "oom-kill": "when it ran out of memory",
  signal: "when a signal killed it",
  "core-dump": "with a crash",
  watchdog: "when its watchdog fired",
  "start-limit-hit": "and hit its start limit",
  resources: "before it could start (a missing file or folder)",
  protocol: "with a protocol error",
};

/** How a run ended: systemd's MONITOR_* variables, else `systemctl show`. */
export async function unitRun(env, unit, deps) {
  let result = env.MONITOR_SERVICE_RESULT;
  let invocation = env.MONITOR_INVOCATION_ID;
  if (!result || (env.MONITOR_UNIT && env.MONITOR_UNIT !== unit)) {
    const shown = deps.run("systemctl", ["show", "-p", "Result", "-p", "InvocationID", unit]);
    result = /^Result=(\S+)$/m.exec(shown)?.[1];
    invocation = /^InvocationID=(\S+)$/m.exec(shown)?.[1];
  }
  if (!result) return null;
  if (result === "success") return { ok: true };
  let detail = RESULT_DETAIL[result] ?? (result === "exit-code" ? "with an error" : `(result ${result.slice(0, 20)})`);
  if (result === "exit-code" && /^[0-9a-f]{32}$/.test(invocation ?? "")) {
    // The scripts log "FAILED at step <step> (exit <n>)" last; only those two
    // tokens are taken from the journal, never a line of it. OnFailure= can
    // start this before journald has stored that line, so look three times.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const journal = deps.run("journalctl", ["--no-pager", "-q", "-o", "cat", `_SYSTEMD_INVOCATION_ID=${invocation}`]);
      const last = [...journal.matchAll(/FAILED at step ([a-z0-9-]{1,40}) \(exit (\d{1,3})\)/g)].at(-1);
      if (last) {
        detail = `at step ${last[1]} (exit ${last[2]})`;
        break;
      }
      if (attempt < 3) await sleep(deps.retryDelay ? 1000 : 0);
    }
  }
  return { ok: false, detail };
}

function unitMessage(post, alert, state, nowMs) {
  const since = discordTime(state.since ?? nowMs);
  const detail = escapeDiscordText(state.detail ?? "with an error", 120);
  if (post === "down") {
    return `🔴 **${alert.what} failed** ${detail}. First look: \`journalctl -u ${alert.unit}\`.`;
  }
  if (post === "still-down") {
    return `🔴 ${alert.what} is still failing, since ${since} (${aboutDuration(nowMs - (state.since ?? nowMs))}). Latest: ${detail}.`;
  }
  return `🟢 ${alert.what} passed again. It had been failing since ${since}.`;
}

async function runUnit(key, env, settings, store, deps) {
  const host = boxName();
  if (key === "test") {
    const down = await postDiscord(settings, discordPayload(
      `🧪 **Test alert from ${host}.** Nothing is wrong: this is how a failure looks here, and the next message is how its recovery looks.`,
      settings.ping), deps);
    const back = down && await postDiscord(settings, discordPayload(
      `🟢 **Test alert from ${host}:** recovered. Alerts from the box reach this channel.`, null), deps);
    deps.log(down && back ? "test alert and recovery posted" : "the test alert did not reach Discord");
    return;
  }
  const alert = UNIT_ALERTS[key];
  if (!alert) {
    deps.log(`unknown alert key ${key}`);
    return;
  }
  const run = await unitRun(env, alert.unit, deps);
  if (!run) {
    deps.log(`could not tell how ${alert.unit} ended`);
    return;
  }
  const prev = store.get(key);
  const step = nextAlertStep(prev, { ok: run.ok, at: deps.now(), detail: run.detail ?? null }, UNIT_RULE);
  let next = step.state;
  if (step.post) {
    const text = unitMessage(step.post, alert, step.post === "recovered" ? prev : step.state, deps.now());
    const delivered = await postDiscord(settings, discordPayload(text, step.post === "recovered" ? null : settings.ping), deps);
    deps.log(`${key}: ${step.post} ${delivered ? "posted" : "NOT posted; the next run retries"}`);
    if (!delivered) next = step.ifPostFails;
  }
  if (!sameAlertState(prev, next)) store.put(key, next);
}

// --- the heartbeat --------------------------------------------------------------------

const DISK_LIMIT_PERCENT = 85;
const MEM_FLOOR_KB = 153600; // 150 MB
const SWAP_LIMIT_KB = 1572864; // 1.5 GB
const HEARTBEAT_RULES = {
  disk: { after: 1, recoverAfter: 1 },
  memory: { after: 3, recoverAfter: 2 },
  swap: { after: 3, recoverAfter: 2 },
  unit: { after: 2, recoverAfter: 1 },
  automation: { after: 3, recoverAfter: 2 },
  bot: { after: 4, recoverAfter: 2 },
};
const WORKERS = { us: "ggd2l-automation-scheduler", eu: "ggd2l-europe-automation-scheduler" };
const LEAGUE_LABEL = { us: "GGD2L US", eu: "GGD2L Europe" };
const UNIT_NAME = /^[A-Za-z0-9@._:-]{1,100}$/;

/** heartbeat.sh's facts, one per line. Anything malformed is left out. */
export function parseFacts(text) {
  const facts = { leagues: [], ready: {}, automation: {}, failedUnits: [], disk: null, memAvailableKb: null, swapUsedKb: null, bot: null };
  const int = (value) => (/^\d{1,12}$/.test(value ?? "") ? Number(value) : null);
  for (const line of text.split("\n")) {
    const [name, ...rest] = line.trim().split(/\s+/);
    if (name === "leagues") facts.leagues = rest.filter((lg) => lg === "us" || lg === "eu");
    else if (name === "ready" && (rest[0] === "us" || rest[0] === "eu")) facts.ready[rest[0]] = rest[1] ?? "000";
    else if (name === "automation" && (rest[0] === "us" || rest[0] === "eu")) {
      facts.automation[rest[0]] = { code: rest[1] ?? "000", status: /^[a-z-]{1,20}$/.test(rest[2] ?? "") ? rest[2] : "unknown" };
    } else if (name === "disk") {
      const disk = int(rest[0]);
      facts.disk = disk !== null && disk <= 100 ? disk : null;
    } else if (name === "mem-available-kb") facts.memAvailableKb = int(rest[0]);
    else if (name === "swap-used-kb") facts.swapUsedKb = int(rest[0]);
    else if (name === "failed-unit" && UNIT_NAME.test(rest[0] ?? "")) facts.failedUnits.push(rest[0]);
    else if (name === "bot" && ["enabled", "disabled"].includes(rest[0]) && ["active", "inactive"].includes(rest[1])) {
      facts.bot = { enabled: rest[0] === "enabled", active: rest[1] === "active" };
    }
  }
  return facts;
}

/**
 * What each check says this beat: an event per alert key, or nothing for a
 * key that can't be judged now (unknown is never bad, and a league the box
 * can't reach is the Worker's to report). Pure, given the stored states.
 */
export function heartbeatChecks(facts, stateOf, unitKeys) {
  const checks = [];
  const add = (key, kind, ok, detail, current) => checks.push({ key, kind, ok, detail, current });
  if (facts.disk !== null) add("disk", "disk", facts.disk < DISK_LIMIT_PERCENT, `${facts.disk}%`, `${facts.disk}%`);
  if (facts.memAvailableKb !== null) {
    const mb = Math.floor(facts.memAvailableKb / 1024);
    add("memory", "memory", facts.memAvailableKb > MEM_FLOOR_KB, `${mb} MB`, `${mb} MB available`);
  }
  if (facts.swapUsedKb !== null) {
    const mb = Math.floor(facts.swapUsedKb / 1024);
    add("swap", "swap", facts.swapUsedKb < SWAP_LIMIT_KB, `${mb} MB`, `${mb} MB in use`);
  }
  for (const lg of facts.leagues) {
    if (facts.ready[lg] !== "200") continue;
    const probe = facts.automation[lg];
    if (!probe) continue;
    if (probe.code === "200") add(`automation-${lg}`, "automation", true, null, "healthy");
    else if (probe.status === "stale") add(`automation-${lg}`, "automation", false, "stale", "stale");
    // failed, degraded and the rest: the Worker sees those passes fail.
  }
  if (facts.bot) add("bot", "bot", !facts.bot.enabled || facts.bot.active, "inactive", facts.bot.active ? "active" : "disabled");
  const failed = new Set();
  for (const unit of facts.failedUnits) {
    const own = Object.entries(UNIT_ALERTS).find(([, alert]) => alert.unit === unit);
    // A unit whose own alert reached Discord is reported; anything else is
    // the heartbeat's, the backup units included when their alert was lost.
    if (own && stateOf(own[0]).alerted) continue;
    failed.add(`unit-${unit}`);
    add(`unit-${unit}`, "unit", false, "failed", "failed");
  }
  for (const key of unitKeys) if (!failed.has(key)) {
    const unit = key.slice("unit-".length);
    const own = Object.entries(UNIT_ALERTS).find(([, alert]) => alert.unit === unit);
    if (own && facts.failedUnits.includes(unit)) continue;
    add(key, "unit", true, null, "cleared");
  }
  return checks;
}

function heartbeatLine(post, check, state, nowMs, host) {
  const since = discordTime(state.since ?? nowMs);
  const box = `**${host}**`;
  const lg = check.key.replace(/^automation-/, "");
  const unit = check.key.replace(/^unit-/, "");
  const subject = {
    disk: `${box}'s disk`,
    memory: `${box}'s free memory`,
    swap: `${box}'s swap`,
    unit: `\`${unit}\` on ${box}`,
    automation: `**${LEAGUE_LABEL[lg]}**'s scheduled passes`,
    bot: `the lobby bot on ${box}`,
  }[check.kind];
  if (post === "recovered") return `🟢 ${subject}: back to normal (${check.current}). It had been failing since ${since}.`;
  if (post === "still-down") return `🔴 ${subject}: still failing, since ${since} (${aboutDuration(nowMs - (state.since ?? nowMs))}).`;
  const status = "`sudo -n ggd2l-agent status`";
  return {
    disk: `🔴 ${box}: the disk is ${check.detail} full (the alert line is ${DISK_LIMIT_PERCENT}%). First look: ${status}, then \`df -h /\`.`,
    memory: `🔴 ${box}: only ${check.detail} of memory available since ${since} (the alert line is 150 MB). First look: ${status}; a release build may be running.`,
    swap: `🔴 ${box}: ${check.detail} of swap in use since ${since} (the alert line is 1,536 MB). First look: ${status}.`,
    unit: `🔴 ${box}: \`${unit}\` has failed. First look: \`journalctl -u ${unit}\`; once it is fixed, \`sudo systemctl reset-failed ${unit}\`.`,
    automation: `🔴 **${LEAGUE_LABEL[lg]}**: the site answers, but no scheduled pass has reached it since ${since} (\`/api/health/automation\` says stale). First look: the ${WORKERS[lg]} Worker's logs in Cloudflare.`,
    bot: `🔴 ${box}: the lobby bot (\`ggd2l-bot\`) has not been running since ${since}. First look: \`journalctl -u ggd2l-bot\`.`,
  }[check.kind];
}

async function runHeartbeat(input, settings, store, deps) {
  const host = boxName();
  const now = deps.now();
  if (store.hello() !== settings.webhookId) {
    const hello = `👋 Alerts are on for **${host}**: its disk, memory, swap and failed units, the leagues' scheduled passes and the lobby bot, every 5 minutes, plus every backup, restore drill and config archive. Each problem posts once, and again when it clears.`;
    if (await postDiscord(settings, discordPayload(hello, null), deps)) store.setHello(settings.webhookId);
  }
  const facts = parseFacts(input);
  const checks = heartbeatChecks(facts, (key) => store.get(key), store.keys("unit-"));
  const results = [];
  for (const check of checks) {
    const prev = store.get(check.key);
    const rule = { ...HEARTBEAT_RULES[check.kind], remindMs: REMIND_AFTER_MS };
    const step = nextAlertStep(prev, { ok: check.ok, at: now, detail: check.detail }, rule);
    results.push({ check, prev, step });
  }
  const posting = results.filter((r) => r.step.post);
  let delivered = true;
  if (posting.length > 0) {
    const lines = posting.map(({ check, prev, step }) =>
      heartbeatLine(step.post, check, step.post === "recovered" ? prev : step.state, now, host));
    const urgent = posting.some(({ step }) => step.post !== "recovered");
    let text = lines.join("\n");
    if (text.length > 1900) text = `${text.slice(0, 1890)}\n…`;
    delivered = await postDiscord(settings, discordPayload(text, urgent ? settings.ping : null), deps);
    deps.log(`${posting.map(({ check, step }) => `${check.key}: ${step.post}`).join(", ")} ${delivered ? "posted" : "NOT posted; the next beat retries"}`);
  }
  for (const { check, prev, step } of results) {
    const next = delivered ? step.state : step.ifPostFails;
    if (!sameAlertState(prev, next)) store.put(check.key, next);
  }
}

// --- main --------------------------------------------------------------------------

function boxName() {
  const name = hostname();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ? name : "the box";
}

function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout : "";
}

export async function main(argv, env = process.env, overrides = {}) {
  const log = overrides.log ?? ((message) => process.stderr.write(`discord-alert: ${message}\n`));
  const [mode, key] = argv;
  if (!(mode === "unit" && key) && mode !== "heartbeat") {
    log("usage: discord-alert.mjs unit <key> | heartbeat");
    return 2;
  }
  const settings = alertSettings(env);
  if (settings.off) {
    log(`alerts are off: ${settings.off}`);
    return 0;
  }
  const stateDir = (env.STATE_DIRECTORY ?? "").split(":")[0];
  if (!stateDir || !path.isAbsolute(stateDir)) {
    log("alerts are off: no STATE_DIRECTORY (the unit needs StateDirectory=ggd2l-alerts)");
    return 0;
  }
  const nowSeconds = Number(env.GGD2L_NOW);
  const deps = {
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    outbox: env.GGD2L_ALERT_OUTBOX || null,
    run: overrides.run ?? runTool,
    now: () => (Number.isFinite(nowSeconds) && env.GGD2L_NOW ? nowSeconds * 1000 : Date.now()),
    log,
    retryDelay: overrides.retryDelay ?? true,
  };
  const store = stateStore(stateDir);
  try {
    if (mode === "unit") await runUnit(key, env, settings, store, deps);
    else await runHeartbeat(overrides.stdin ?? readFileSync(0, "utf8"), settings, store, deps);
  } catch (error) {
    log(`failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return 0;
}

let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
