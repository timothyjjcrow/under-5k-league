import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ createSession: vi.fn() }));
vi.mock("@/lib/users", () => ({
  upsertLeagueUser: vi.fn(async () => ({ id: "dev-user" })),
}));
vi.mock("@/lib/automation-gate-invalidation", () => ({
  invalidateAutomationGateBestEffort: vi.fn(),
}));

import { createSession } from "@/lib/auth";
import { GET } from "./route";

const session = vi.mocked(createSession);

beforeEach(() => {
  session.mockReset();
  vi.stubEnv("ALLOW_DEV_LOGIN", "true");
});
afterEach(() => vi.unstubAllEnvs());

const devLogin = (url: string) => GET(new NextRequest(url));

describe("dev login", () => {
  it.each([
    ["ALLOW_DEV_LOGIN unset", { ALLOW_DEV_LOGIN: "" }],
    ["production", { NODE_ENV: "production" }],
  ])("is disabled when %s", async (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    const res = await devLogin(
      "https://league.example/api/auth/dev?steamId=76561190000000001",
    );

    expect(res.status).toBe(403);
    expect(session).not.toHaveBeenCalled();
  });

  it("signs in and lands on a safe path on the request's own origin", async () => {
    const res = await devLogin(
      "https://league.example/api/auth/dev?steamId=76561190000000001&redirect=%2Fme",
    );

    expect(session).toHaveBeenCalledWith("dev-user");
    expect(res.headers.get("location")).toBe("https://league.example/me");
  });

  it("never follows an off-site redirect", async () => {
    const res = await devLogin(
      "https://league.example/api/auth/dev?redirect=https%3A%2F%2Fevil.example",
    );

    expect(res.headers.get("location")).toBe("https://league.example/");
  });

  it("lands on the canonical origin when the deployment is declared", async () => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "staging");
    vi.stubEnv("APP_URL", "https://us.ggd2l.com");

    // Next hands the handler the 127.0.0.1 bind address behind Caddy.
    const res = await devLogin(
      "https://127.0.0.1:3001/api/auth/dev?steamId=76561190000000001&redirect=%2Fme",
    );

    expect(res.headers.get("location")).toBe("https://us.ggd2l.com/me");
  });
});
