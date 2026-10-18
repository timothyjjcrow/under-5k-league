import { failureDetail, productionLeague, normalizeDiscordWebhookUrl } from "./alerts";

// The Durable Object class must be exported from the Worker's main module.
export { SchedulerAlertState } from "./alert-state";

const AUTOMATION_PATH = "/api/cron/automation";
const REQUEST_TIMEOUT_MS = 65_000;
const MAX_RESPONSE_BYTES = 2_048;
// A fixed name lets access logs tell scheduler passes apart from people. It
// does NOT get a tick past the zone's Browser Integrity Check: BIC challenges
// a missing AND a non-standard user agent, and a challenged tick is a 403, a
// failed pass. The zone must skip BIC for this path (a WAF custom rule with a
// Skip action; the bearer still guards the route), and a pre-cutover request
// with this user agent must get the app's own 401, never `cf-mitigated:
// challenge`.
const USER_AGENT = "ggd2l-automation-scheduler";

/** The slice of DurableObjectNamespace this uses (the app has no Workers types). */
export type AlertStateNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
};

export type SchedulerEnv = {
  AUTOMATION_URL: string;
  AUTOMATION_SECRET: string;
  AUTOMATION_PAUSED?: string;
  // Optional secrets: without the webhook the Worker never alerts.
  ALERT_DISCORD_WEBHOOK_URL?: string;
  ALERT_PING_USER_ID?: string;
  ALERT_STATE?: AlertStateNamespace;
};

type AutomationResponse = {
  ok?: unknown;
  status?: unknown;
};

function configuredUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AUTOMATION_URL must be a canonical HTTPS URL");
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== AUTOMATION_PATH
  ) {
    throw new Error(
      `AUTOMATION_URL must be a canonical HTTPS origin followed by ${AUTOMATION_PATH}`,
    );
  }
  return url;
}

function configuredSecret(value: string): string {
  if (
    value.length < 32 ||
    value.length > 512 ||
    /\s/.test(value)
  ) {
    throw new Error(
      "AUTOMATION_SECRET must contain 32-512 non-whitespace characters",
    );
  }
  return value;
}

async function boundedJson(response: Response): Promise<AutomationResponse> {
  if (!response.body) throw new Error("Automation returned an empty response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Automation response exceeded its size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof Error && error.message.includes("size limit")) {
      throw error;
    }
    throw new Error("Automation returned an invalid response");
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid shape");
    }
    return parsed as AutomationResponse;
  } catch {
    throw new Error("Automation returned an invalid response");
  }
}

/**
 * Invoke one bounded, authenticated maintenance pass. Redirects are never
 * followed: the bearer must only be sent to the exact configured origin.
 * Error messages intentionally omit the URL, response body, and secret so
 * Cloudflare invocation logs remain safe to retain.
 */
export async function invokeAutomation(
  env: SchedulerEnv,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  // Trigger removal can propagate slowly. Fence dispatch in the deployed
  // Worker as well, so a late scheduled event cannot reach the application.
  if (env.AUTOMATION_PAUSED === "true") {
    console.info("AUTOMATION_PAUSED");
    return;
  }
  if (env.AUTOMATION_PAUSED !== undefined && env.AUTOMATION_PAUSED !== "false") {
    throw new Error("AUTOMATION_PAUSED must be true or false");
  }
  const url = configuredUrl(env.AUTOMATION_URL);
  const secret = configuredSecret(env.AUTOMATION_SECRET);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${secret}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Automation request failed");
  }

  if (response.status !== 200) {
    response.body?.cancel().catch(() => undefined);
    throw new Error(`Automation returned HTTP ${response.status}`);
  }
  const body = await boundedJson(response);
  if (body.ok !== true || body.status !== "SUCCEEDED") {
    throw new Error("Automation did not report a successful pass");
  }
}

/**
 * Hand one finished pass to the league's alert state (alert-state.ts), which
 * posts to Discord when the rules in alerts.ts call for it. Best-effort: it
 * never throws and never delays the pass's own outcome by more than one
 * Durable Object call. Without a production route or a webhook it does
 * nothing at all, so a Worker without the secret costs exactly what it did.
 */
export async function reportPass(
  env: SchedulerEnv,
  failure: unknown,
  nowMs: number,
): Promise<void> {
  const league = productionLeague(env.AUTOMATION_URL);
  if (!league || !normalizeDiscordWebhookUrl(env.ALERT_DISCORD_WEBHOOK_URL)) return;
  if (!env.ALERT_STATE) {
    console.error("ALERT_STATE_UNBOUND");
    return;
  }
  try {
    const stub = env.ALERT_STATE.get(env.ALERT_STATE.idFromName(league));
    const response = await stub.fetch("https://alert-state/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        failure === null
          ? { ok: true, at: nowMs }
          : { ok: false, at: nowMs, detail: failureDetail(failure) },
      ),
    });
    if (!response.ok) console.error(`ALERT_STATE_REFUSED HTTP ${response.status}`);
    else await response.body?.cancel().catch(() => undefined);
  } catch {
    console.error("ALERT_STATE_UNAVAILABLE");
  }
}

const worker = {
  async scheduled(
    _controller: unknown,
    env: SchedulerEnv,
    _context: unknown,
  ): Promise<void> {
    let failure: unknown = null;
    try {
      await invokeAutomation(env);
    } catch (error) {
      failure = error;
    }
    // A paused Worker made no pass, so there is nothing to count.
    if (env.AUTOMATION_PAUSED !== "true") await reportPass(env, failure, Date.now());
    // The cron event still fails exactly as before.
    if (failure !== null) throw failure;
  },
};

export default worker;
