const AUTOMATION_PATH = "/api/cron/automation";
const REQUEST_TIMEOUT_MS = 65_000;
const MAX_RESPONSE_BYTES = 2_048;

export type SchedulerEnv = {
  AUTOMATION_URL: string;
  AUTOMATION_SECRET: string;
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
  const url = configuredUrl(env.AUTOMATION_URL);
  const secret = configuredSecret(env.AUTOMATION_SECRET);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${secret}`,
        accept: "application/json",
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

const worker = {
  async scheduled(
    _controller: unknown,
    env: SchedulerEnv,
    _context: unknown,
  ): Promise<void> {
    await invokeAutomation(env);
  },
};

export default worker;
