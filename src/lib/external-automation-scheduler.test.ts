import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { invokeAutomation } from "../../ops/cloudflare-automation-worker/src/index";

const SECRET = "C8kP2vR7xM4qT9wL6nH3dF5sJ0yB1zUa";
const URL = "https://league.example/api/cron/automation";

function response(
  body: unknown,
  init: ResponseInit = { status: 200 },
): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Cloudflare automation scheduler", () => {
  it("owns the only configured one-minute production trigger", () => {
    const vercel = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as { crons?: unknown };
    const cloudflare = JSON.parse(
      readFileSync(
        path.resolve(
          process.cwd(),
          "ops/cloudflare-automation-worker/wrangler.jsonc",
        ),
        "utf8",
      ),
    ) as {
      workers_dev?: boolean;
      vars?: { AUTOMATION_URL?: string };
      triggers?: { crons?: string[] };
      secrets?: { required?: string[] };
    };

    expect(vercel.crons).toBeUndefined();
    expect(cloudflare.workers_dev).toBe(false);
    expect(cloudflare.vars?.AUTOMATION_URL).toBe(
      "https://ggd2l.vercel.app/api/cron/automation",
    );
    expect(cloudflare.triggers?.crons).toEqual(["* * * * *"]);
    expect(cloudflare.secrets?.required).toEqual(["AUTOMATION_SECRET"]);
  });

  it("has a reviewed pause artifact that only removes the cron trigger", () => {
    const active = JSON.parse(
      readFileSync(
        path.resolve(
          process.cwd(),
          "ops/cloudflare-automation-worker/wrangler.jsonc",
        ),
        "utf8",
      ),
    ) as Record<string, unknown> & { triggers?: { crons?: string[] } };
    const paused = JSON.parse(
      readFileSync(
        path.resolve(
          process.cwd(),
          "ops/cloudflare-automation-worker/wrangler.paused.jsonc",
        ),
        "utf8",
      ),
    ) as Record<string, unknown> & { triggers?: { crons?: string[] } };

    expect(paused.triggers?.crons).toEqual([]);
    expect({ ...paused, triggers: undefined }).toEqual({
      ...active,
      triggers: undefined,
    });
  });

  it("calls the exact HTTPS worker route with the bearer and no redirects", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({ ok: true, status: "SUCCEEDED" }),
    );

    await invokeAutomation(
      { AUTOMATION_URL: URL, AUTOMATION_SECRET: SECRET },
      fetcher as typeof fetch,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(URL);
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${SECRET}`,
        accept: "application/json",
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    "http://league.example/api/cron/automation",
    "https://user@league.example/api/cron/automation",
    "https://league.example:8443/api/cron/automation",
    "https://league.example/api/cron/automation?next=https://attacker.example",
    "https://league.example/api/sync",
  ])("rejects a non-canonical target without fetching (%s)", async (target) => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      invokeAutomation(
        { AUTOMATION_URL: target, AUTOMATION_SECRET: SECRET },
        fetcher,
      ),
    ).rejects.toThrow("AUTOMATION_URL");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["short", ` ${SECRET}`, `${SECRET}\n`])(
    "rejects an invalid scheduler secret before fetching",
    async (secret) => {
      const fetcher = vi.fn<typeof fetch>();

      await expect(
        invokeAutomation(
          { AUTOMATION_URL: URL, AUTOMATION_SECRET: secret },
          fetcher,
        ),
      ).rejects.toThrow("AUTOMATION_SECRET");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    [response({ ok: false, status: "FAILED" }, { status: 500 }), "HTTP 500"],
    [response({ ok: true, status: "RUNNING" }, { status: 202 }), "HTTP 202"],
    [response({ ok: true, status: "DEGRADED" }), "successful pass"],
    [new Response("not json", { status: 200 }), "invalid response"],
  ] as const)("fails the cron event for a bad endpoint result", async (res, message) => {
    await expect(
      invokeAutomation(
        { AUTOMATION_URL: URL, AUTOMATION_SECRET: SECRET },
        vi.fn(async () => res),
      ),
    ).rejects.toThrow(message);
  });

  it("redacts target and provider details from fetch failures", async () => {
    const providerMessage = `fetch failed for ${URL} using ${SECRET}`;

    await expect(
      invokeAutomation(
        { AUTOMATION_URL: URL, AUTOMATION_SECRET: SECRET },
        vi.fn(async () => {
          throw new Error(providerMessage);
        }),
      ),
    ).rejects.toThrow(/^Automation request failed$/);
  });

  it("bounds the response before parsing it", async () => {
    await expect(
      invokeAutomation(
        { AUTOMATION_URL: URL, AUTOMATION_SECRET: SECRET },
        vi.fn(async () => new Response("x".repeat(2_049))),
      ),
    ).rejects.toThrow("size limit");
  });
});
