// Discord alerts for the minute scheduler: the dead-man check from outside the
// box (docs/DECISIONS.md, Hosting; ops/selfhost/README.md "Alerts").
//
// Each league's Worker counts its own consecutive failed passes in one SQLite
// Durable Object (alert-state.ts). Cron runs land in whichever data center has
// spare capacity, so a per-data-center Cache API entry or a KV key (up to 60 s
// stale elsewhere) can't count minutes in a row; a Durable Object is one
// strongly consistent instance, on the Workers Free plan. A healthy minute
// reads one row and writes none, so a league costs 1,440 Durable Object
// requests and reads a day (Free allows 100,000 requests and 5 million rows
// read) and only a handful of writes per incident (100,000 a day allowed).
//
// It posts once when a league fails ALERT_AFTER_FAILURES runs in a row, a
// reminder after REMIND_AFTER_MS if it is still failing, and once more after
// RECOVER_AFTER_PASSES clean runs in a row. A post that fails leaves the state
// where it was, so the next run tries again. The same rules, with the same
// state shape, drive the box's alerts (ops/selfhost/backup/discord-alert.mjs);
// src/lib/ops-alerts-parity.test.ts keeps the two in step.
//
// Only production posts: the Worker's AUTOMATION_URL must be one league's
// canonical route, and ALERT_DISCORD_WEBHOOK_URL (an optional Worker secret,
// put through stdin) must be a Discord webhook. Messages ping nobody unless
// ALERT_PING_USER_ID (another optional secret) names one Discord user, and
// then only for a failure. Error text never reaches Discord: a failed pass is
// reported by a fixed description of its kind.

export const ALERT_AFTER_FAILURES = 3;
// The box's unattended upgrades may reboot it at 09:00 UTC (provision-base.sh),
// and a reboot can cost a few minutes of failed passes. Inside this window a
// streak needs more failures before it alerts; past it the normal rule applies
// to the same streak.
export const REBOOT_WINDOW_UTC = { hour: 9, minutes: 15 };
export const ALERT_AFTER_FAILURES_IN_REBOOT_WINDOW = 10;
// The runbooks' health gate: two successful passes in a row.
export const RECOVER_AFTER_PASSES = 2;
export const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;
const POST_TIMEOUT_MS = 10_000;

export type AlertState = {
  /** Failed runs in a row (an alerted streak keeps counting through a lone pass). */
  failing: number;
  /** Clean runs in a row since the alert; 0 while not alerted. */
  passing: number;
  /** A failure message reached Discord and no recovery has yet. */
  alerted: boolean;
  /** Epoch ms of the streak's first failure. */
  since: number | null;
  /** Epoch ms of the last failure or reminder post. */
  postedAt: number | null;
  /** The latest failure's fixed description. */
  detail: string | null;
};

export type AlertRule = {
  after: number;
  recoverAfter: number;
  remindMs: number;
};

export type AlertEvent = { ok: boolean; at: number; detail?: string | null };
export type AlertPost = "down" | "still-down" | "recovered";
export type AlertStep = {
  post: AlertPost | null;
  /** The state to keep when there is no post or the post reached Discord. */
  state: AlertState;
  /** The state to keep when the post failed, so the next event retries it. */
  ifPostFails: AlertState;
};

export const EMPTY_ALERT_STATE: AlertState = {
  failing: 0,
  passing: 0,
  alerted: false,
  since: null,
  postedAt: null,
  detail: null,
};

/** One event through the alert rules. Pure. */
export function nextAlertStep(
  prev: AlertState,
  event: AlertEvent,
  rule: AlertRule,
): AlertStep {
  if (!event.ok) {
    const state: AlertState = {
      ...prev,
      failing: prev.failing + 1,
      passing: 0,
      since: prev.since ?? event.at,
      detail: event.detail ?? null,
    };
    if (!state.alerted && state.failing >= rule.after) {
      return {
        post: "down",
        state: { ...state, alerted: true, postedAt: event.at },
        ifPostFails: state,
      };
    }
    if (
      state.alerted &&
      state.postedAt !== null &&
      event.at - state.postedAt >= rule.remindMs
    ) {
      return {
        post: "still-down",
        state: { ...state, postedAt: event.at },
        ifPostFails: state,
      };
    }
    return { post: null, state, ifPostFails: state };
  }
  if (!prev.alerted) {
    return { post: null, state: EMPTY_ALERT_STATE, ifPostFails: EMPTY_ALERT_STATE };
  }
  const state: AlertState = { ...prev, passing: prev.passing + 1 };
  if (state.passing >= rule.recoverAfter) {
    return { post: "recovered", state: EMPTY_ALERT_STATE, ifPostFails: state };
  }
  return { post: null, state, ifPostFails: state };
}

export function sameAlertState(a: AlertState, b: AlertState): boolean {
  return (
    a.failing === b.failing &&
    a.passing === b.passing &&
    a.alerted === b.alerted &&
    a.since === b.since &&
    a.postedAt === b.postedAt &&
    a.detail === b.detail
  );
}

const nonNegativeInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const epochOrNull = (value: unknown): value is number | null =>
  value === null || nonNegativeInt(value);

/** A stored state, or the empty one for anything unreadable. */
export function readAlertState(value: unknown): AlertState {
  if (!value || typeof value !== "object") return EMPTY_ALERT_STATE;
  const v = value as Record<string, unknown>;
  if (
    !nonNegativeInt(v.failing) ||
    !nonNegativeInt(v.passing) ||
    typeof v.alerted !== "boolean" ||
    !epochOrNull(v.since) ||
    !epochOrNull(v.postedAt) ||
    !(v.detail === null || (typeof v.detail === "string" && v.detail.length <= 200))
  ) {
    return EMPTY_ALERT_STATE;
  }
  return {
    failing: v.failing,
    passing: v.passing,
    alerted: v.alerted,
    since: v.since,
    postedAt: v.postedAt,
    detail: v.detail,
  };
}

/** The rule for a scheduler event at nowMs (the reboot window raises the bar). */
export function schedulerAlertRule(nowMs: number): AlertRule {
  const at = new Date(nowMs);
  const inRebootWindow =
    at.getUTCHours() === REBOOT_WINDOW_UTC.hour &&
    at.getUTCMinutes() < REBOOT_WINDOW_UTC.minutes;
  return {
    after: inRebootWindow
      ? ALERT_AFTER_FAILURES_IN_REBOOT_WINDOW
      : ALERT_AFTER_FAILURES,
    recoverAfter: RECOVER_AFTER_PASSES,
    remindMs: REMIND_AFTER_MS,
  };
}

// --- the league --------------------------------------------------------------

export type League = "us" | "eu";

const PRODUCTION_ROUTES: Record<string, League> = {
  "https://us.ggd2l.com/api/cron/automation": "us",
  "https://eu.ggd2l.com/api/cron/automation": "eu",
};
const LEAGUE_LABEL: Record<League, string> = { us: "GGD2L US", eu: "GGD2L Europe" };
const LEAGUE_ORIGIN: Record<League, string> = {
  us: "https://us.ggd2l.com",
  eu: "https://eu.ggd2l.com",
};
const WORKER_NAME: Record<League, string> = {
  us: "ggd2l-automation-scheduler",
  eu: "ggd2l-europe-automation-scheduler",
};

/** The league whose production route this Worker calls, or null (no alerts). */
export function productionLeague(automationUrl: unknown): League | null {
  return typeof automationUrl === "string"
    ? (PRODUCTION_ROUTES[automationUrl] ?? null)
    : null;
}

// --- what failed ---------------------------------------------------------------

const FIXED_DETAILS: Record<string, string> = {
  "Automation request failed": "no answer (a timeout or a refused connection)",
  "Automation returned an empty response": "an empty response",
  "Automation returned an invalid response": "a response that was not the pass's JSON",
  "Automation response exceeded its size limit": "an oversized response",
  "Automation did not report a successful pass": "a pass that did not succeed",
  "AUTOMATION_PAUSED must be true or false": "an invalid AUTOMATION_PAUSED in the Worker",
};
const HTTP_HINTS: Record<number, string> = {
  202: "the previous pass still holds the lease",
  401: "the Worker's AUTOMATION_SECRET does not match the league's CRON_SECRET",
  403: "Cloudflare may be challenging the scheduler",
  500: "the pass failed or was degraded",
  502: "the site is down behind the tunnel",
  503: "the site or its database is unavailable",
  504: "the site timed out",
  521: "the site is down",
  522: "the site timed out",
  523: "the site is unreachable",
  524: "the site timed out",
  530: "the tunnel to the box is down",
};

/**
 * A fixed description of a failed pass. Only invokeAutomation's own messages
 * are recognized; anything else is "an unexpected error", so no provider text,
 * URL or secret can reach Discord.
 */
export function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const http = /^Automation returned HTTP (\d{3})$/.exec(message);
  if (http) {
    const code = Number(http[1]);
    return HTTP_HINTS[code] ? `HTTP ${code}: ${HTTP_HINTS[code]}` : `HTTP ${code}`;
  }
  if (FIXED_DETAILS[message]) return FIXED_DETAILS[message];
  if (message.startsWith("AUTOMATION_URL must")) return "an invalid AUTOMATION_URL in the Worker";
  if (message.startsWith("AUTOMATION_SECRET must")) return "an invalid AUTOMATION_SECRET in the Worker";
  return "an unexpected error";
}

// --- Discord -------------------------------------------------------------------

// A copy of src/lib/discord-webhook.mjs, kept identical by
// src/lib/ops-alerts-parity.test.ts: the Worker bundles nothing from the app.
const WEBHOOK_PATH =
  /^\/api\/(?:v(?:9|10)\/)?webhooks\/(\d{5,25})\/([A-Za-z0-9._-]{16,256})$/;

export function normalizeDiscordWebhookUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 512) {
    return null;
  }
  if (input !== input.trim()) return null;
  if (!/^https:\/\/(?:discord\.com|discordapp\.com)\//.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "discord.com" && url.hostname !== "discordapp.com") ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !WEBHOOK_PATH.test(url.pathname)
  ) {
    return null;
  }
  return input;
}

/** The webhook's id (not a credential: it can't post), to tell webhooks apart. */
export function webhookId(url: string): string | null {
  return WEBHOOK_PATH.exec(new URL(url).pathname)?.[1] ?? null;
}

// A copy of escapeDiscordText in src/lib/discord-escape.ts (parity-tested).
export function escapeDiscordText(raw: string, maxLen?: number): string {
  const flat = raw.replace(/[\r\n\t]+/g, " ").trim();
  const trimmed =
    maxLen != null && flat.length > maxLen
      ? `${flat.slice(0, maxLen - 1)}…`
      : flat;
  return trimmed
    .replace(/[\\*_~`|<>[\]()@#-]/g, (c) => `\\${c}`)
    .replace(/(https?):\/\//gi, "$1:​//")
    .replace(/\bwww\./gi, "www​.");
}

/** A Discord user id (a snowflake), or null. */
export function pingUserId(value: unknown): string | null {
  return typeof value === "string" && /^\d{17,20}$/.test(value) ? value : null;
}

export type DiscordPayload = {
  content: string;
  allowed_mentions: { parse: []; users?: string[] };
};

/** The webhook body: nobody is pinged unless `ping` names the one user. */
export function discordPayload(content: string, ping: string | null): DiscordPayload {
  if (ping) {
    return {
      content: `<@${ping}> ${content}`,
      allowed_mentions: { parse: [], users: [ping] },
    };
  }
  return { content, allowed_mentions: { parse: [] } };
}

function aboutDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

const discordTime = (ms: number) => `<t:${Math.floor(ms / 1000)}:f>`;

/** The message for one post. Only the detail is dynamic, and it is escaped. */
export function schedulerMessage(
  post: AlertPost,
  league: League,
  state: AlertState,
  nowMs: number,
): string {
  const name = `**${LEAGUE_LABEL[league]}**`;
  const since = state.since ?? nowMs;
  const detail = escapeDiscordText(state.detail ?? "an unexpected error", 160);
  if (post === "down") {
    return [
      `🔴 ${name} is failing: its last ${state.failing} scheduled runs in a row failed, since ${discordTime(since)}.`,
      `Latest: ${detail}.`,
      `Players may not reach <${LEAGUE_ORIGIN[league]}>, or results, reminders and Discord posts have stopped.`,
      "First look: `ssh ggd2l-1 sudo -n ggd2l-agent status`, then the slot's journal.",
    ].join("\n");
  }
  if (post === "still-down") {
    return `🔴 ${name} is still failing: ${state.failing} scheduled runs in a row since ${discordTime(since)} (${aboutDuration(nowMs - since)}). Latest: ${detail}.`;
  }
  return `🟢 ${name} is back: ${RECOVER_AFTER_PASSES} scheduled runs in a row passed. It had been failing since ${discordTime(since)} (${aboutDuration(nowMs - since)}).`;
}

/** The one-time message that proves a newly configured webhook works. */
export function schedulerHelloMessage(league: League): string {
  return `👋 Alerts are on for **${LEAGUE_LABEL[league]}**'s minute scheduler (the Cloudflare Worker ${WORKER_NAME[league]}): it posts here when ${ALERT_AFTER_FAILURES} runs in a row fail, and again when ${RECOVER_AFTER_PASSES} in a row pass.`;
}

/**
 * POST one message. True only for a 2xx. Never throws, never follows a
 * redirect, and logs no URL (the webhook URL is a credential).
 */
export async function postDiscord(
  webhookUrl: string,
  payload: DiscordPayload,
  fetcher: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    response.body?.cancel().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) return true;
    console.error(`ALERT_POST_FAILED HTTP ${response.status}`);
    return false;
  } catch {
    console.error("ALERT_POST_FAILED");
    return false;
  }
}

// --- the Durable Object's work ----------------------------------------------------

/** The slice of DurableObjectStorage this uses (the app has no Workers types). */
export type AlertStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
};

export type AlertEnv = {
  AUTOMATION_URL: string;
  ALERT_DISCORD_WEBHOOK_URL?: string;
  ALERT_PING_USER_ID?: string;
};

export type AlertResult = { posted: AlertPost | "hello" | null; delivered: boolean };

const STATE_KEY = "alert";
const HELLO_KEY = "hello";

/**
 * Apply one scheduler outcome to the stored state and post what it calls for.
 * Runs inside the Durable Object, one call at a time. Writes only on a change,
 * so a healthy minute is one read (two the first time a webhook is seen).
 */
export async function recordSchedulerEvent(
  storage: AlertStorage,
  env: AlertEnv,
  event: AlertEvent,
  fetcher: typeof fetch,
): Promise<AlertResult> {
  const league = productionLeague(env.AUTOMATION_URL);
  const webhook = normalizeDiscordWebhookUrl(env.ALERT_DISCORD_WEBHOOK_URL);
  if (!league || !webhook) return { posted: null, delivered: false };
  const id = webhookId(webhook);
  const ping = pingUserId(env.ALERT_PING_USER_ID);

  let posted: AlertResult["posted"] = null;
  let delivered = false;
  if ((await storage.get(HELLO_KEY)) !== id) {
    posted = "hello";
    delivered = await postDiscord(
      webhook,
      discordPayload(schedulerHelloMessage(league), null),
      fetcher,
    );
    if (delivered) await storage.put(HELLO_KEY, id);
  }

  const prev = readAlertState(await storage.get(STATE_KEY));
  const step = nextAlertStep(prev, event, schedulerAlertRule(event.at));
  let next = step.state;
  if (step.post) {
    posted = step.post;
    delivered = await postDiscord(
      webhook,
      discordPayload(
        schedulerMessage(step.post, league, step.post === "recovered" ? prev : step.state, event.at),
        step.post === "recovered" ? null : ping,
      ),
      fetcher,
    );
    if (!delivered) next = step.ifPostFails;
  }
  if (!sameAlertState(prev, next)) await storage.put(STATE_KEY, next);
  return { posted, delivered };
}
