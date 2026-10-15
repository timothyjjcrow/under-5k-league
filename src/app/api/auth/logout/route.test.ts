import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ destroySession: vi.fn() }));

import { destroySession } from "@/lib/auth";
import { POST } from "./route";

const destroy = vi.mocked(destroySession);
const missingOriginHeaders: Record<string, string>[] = [
  {},
  { host: "league.example" },
];

beforeEach(() => destroy.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe("logout", () => {
  it("uses POST, destroys the session, and lands on a confirmation", async () => {
    const res = await POST(
      new NextRequest("https://league.example/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://league.example", host: "league.example" },
      }),
    );

    expect(destroy).toHaveBeenCalledOnce();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://league.example/login?signedOut=1",
    );
  });

  it("rejects a cross-origin form without changing the session", async () => {
    const res = await POST(
      new NextRequest("https://league.example/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://evil.example", host: "league.example" },
      }),
    );

    expect(res.status).toBe(403);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("treats an opaque or malformed Origin as untrusted instead of throwing", async () => {
    const res = await POST(
      new NextRequest("https://league.example/api/auth/logout", {
        method: "POST",
        headers: { origin: "null", host: "league.example" },
      }),
    );

    expect(res.status).toBe(403);
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each(missingOriginHeaders)(
    "fails closed when Origin is missing (%j)",
    async (headers) => {
      const res = await POST(
        new NextRequest("https://league.example/api/auth/logout", {
          method: "POST",
          headers,
        }),
      );

      expect(res.status).toBe(403);
      expect(destroy).not.toHaveBeenCalled();
    },
  );

  it("rejects a same-site sibling origin", async () => {
    const res = await POST(
      new NextRequest("https://league.example/api/auth/logout", {
        method: "POST",
        headers: {
          origin: "https://admin.league.example",
          host: "league.example",
          "sec-fetch-site": "same-site",
        },
      }),
    );

    expect(res.status).toBe(403);
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe("logout on a self-hosted league", () => {
  beforeEach(() => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "production");
    vi.stubEnv("APP_URL", "https://us.ggd2l.com");
  });

  // Next hands the handler the 127.0.0.1 bind address behind Caddy.
  const atBindAddress = (origin: string) =>
    POST(
      new NextRequest("https://127.0.0.1:3001/api/auth/logout", {
        method: "POST",
        headers: { origin, host: "us.ggd2l.com" },
      }),
    );

  it("accepts the canonical origin and lands on the canonical login page", async () => {
    const res = await atBindAddress("https://us.ggd2l.com");

    expect(destroy).toHaveBeenCalledOnce();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://us.ggd2l.com/login?signedOut=1",
    );
  });

  it.each(["https://127.0.0.1:3001", "https://eu.ggd2l.com"])(
    "rejects %s without changing the session",
    async (origin) => {
      const res = await atBindAddress(origin);

      expect(res.status).toBe(403);
      expect(destroy).not.toHaveBeenCalled();
    },
  );
});
