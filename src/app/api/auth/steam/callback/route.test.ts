import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { RETURN_COOKIE, STEAM_STATE_COOKIE } from "@/lib/return-path";

vi.mock("@/lib/steam", () => ({
  verifySteamCallback: vi.fn(),
  fetchSteamProfile: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ createSession: vi.fn() }));
vi.mock("@/lib/users", () => ({
  upsertLeagueUser: vi.fn(),
  ensureRankTier: vi.fn(),
  ensurePubStats: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ allowed: true })),
  clientIp: vi.fn(() => "test-ip"),
}));

import { verifySteamCallback } from "@/lib/steam";
import { rateLimit } from "@/lib/rate-limit";
import { upsertLeagueUser } from "@/lib/users";
import { GET } from "./route";

const verify = vi.mocked(verifySteamCallback);
const limit = vi.mocked(rateLimit);
const upsert = vi.mocked(upsertLeagueUser);

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  verify.mockReset();
  verify.mockResolvedValue(null);
  limit.mockReset();
  limit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

function request(
  returnCookie: string | null,
  stateCookie: string | null = "browser-state",
  callbackState: string | null = stateCookie,
  origin = "https://league.example",
) {
  const url = new URL("/api/auth/steam/callback", origin);
  if (callbackState) url.searchParams.set("state", callbackState);
  const cookies = [
    returnCookie ? `${RETURN_COOKIE}=${returnCookie}` : null,
    stateCookie ? `${STEAM_STATE_COOKIE}=${stateCookie}` : null,
  ].filter(Boolean);
  return new NextRequest(url, {
    headers: cookies.length ? { cookie: cookies.join("; ") } : undefined,
  });
}

describe("Steam callback failures", () => {
  it("keeps a safe destination on the retry URL and consumes its cookie", async () => {
    const res = await GET(request(encodeURIComponent("/me")));
    const location = new URL(res.headers.get("location")!);

    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("steam");
    expect(location.searchParams.get("next")).toBe("/me");
    expect(res.cookies.get(RETURN_COOKIE)?.value).toBe("");
    expect(res.cookies.get(STEAM_STATE_COOKIE)?.value).toBe("");
  });

  it("expires both production flow cookies with __Host-compatible attributes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(request(null));

    for (const name of [RETURN_COOKIE, STEAM_STATE_COOKIE]) {
      const cookie = res.cookies.get(name);
      expect(cookie).toMatchObject({
        value: "",
        httpOnly: true,
        maxAge: 0,
        path: "/",
        sameSite: "lax",
        secure: true,
      });
      expect(new Date(cookie?.expires ?? 1).getTime()).toBe(0);
    }
  });

  it("never copies an unsafe cookie into the retry URL", async () => {
    const res = await GET(request(encodeURIComponent("//evil.example")));
    const location = new URL(res.headers.get("location")!);

    expect(location.searchParams.get("error")).toBe("steam");
    expect(location.searchParams.has("next")).toBe(false);
  });

  it("preserves the retry destination when rate limited too", async () => {
    limit.mockReturnValueOnce({ allowed: false, retryAfterMs: 60_000 });
    const res = await GET(request(encodeURIComponent("/me")));
    const location = new URL(res.headers.get("location")!);

    expect(location.searchParams.get("error")).toBe("rate");
    expect(location.searchParams.get("next")).toBe("/me");
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects an unsolicited callback with no browser state before contacting Steam", async () => {
    const res = await GET(request(null, null, null));
    expect(
      new URL(res.headers.get("location")!).searchParams.get("error"),
    ).toBe("steam");
    expect(verify).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    expect(res.cookies.get(RETURN_COOKIE)).toBeUndefined();
    expect(res.cookies.get(STEAM_STATE_COOKIE)).toBeUndefined();
  });

  it("rejects a callback whose state belongs to another browser", async () => {
    const res = await GET(request(null, "browser-state", "attacker-state"));
    expect(
      new URL(res.headers.get("location")!).searchParams.get("error"),
    ).toBe("steam");
    expect(verify).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    expect(res.cookies.get(RETURN_COOKIE)).toBeUndefined();
    expect(res.cookies.get(STEAM_STATE_COOKIE)).toBeUndefined();
  });

  it("rejects an ambiguous duplicate state before spending the callback budget", async () => {
    const req = request(null);
    req.nextUrl.searchParams.append("state", "browser-state");
    const res = await GET(req);

    expect(
      new URL(res.headers.get("location")!).searchParams.get("error"),
    ).toBe("steam");
    expect(verify).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    expect(res.cookies.get(RETURN_COOKIE)).toBeUndefined();
    expect(res.cookies.get(STEAM_STATE_COOKIE)).toBeUndefined();
  });

  it("rejects an oversized callback before rate-limit or provider work", async () => {
    const req = request(null);
    req.nextUrl.searchParams.set("padding", "x".repeat(17_000));

    const res = await GET(req);

    expect(
      new URL(res.headers.get("location")!).searchParams.get("error"),
    ).toBe("steam");
    expect(verify).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    expect(res.cookies.get(RETURN_COOKIE)).toBeUndefined();
    expect(res.cookies.get(STEAM_STATE_COOKIE)).toBeUndefined();
  });

  it("pins Steam's signed return_to to the state accepted from the cookie", async () => {
    await GET(request(null));
    expect(verify).toHaveBeenCalledWith(
      expect.any(URLSearchParams),
      "https://league.example/api/auth/steam/callback?state=browser-state",
    );
  });
});

describe("Steam callback redirects on a self-hosted league", () => {
  // Next hands the handler the 127.0.0.1 bind address behind Caddy.
  const AT_BIND_ADDRESS = "https://127.0.0.1:3001";

  beforeEach(() => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "production");
    vi.stubEnv("APP_URL", "https://us.ggd2l.com");
  });

  it("sends a failed sign-in back to the canonical login page", async () => {
    const res = await GET(
      request(
        encodeURIComponent("/me"),
        "browser-state",
        "browser-state",
        AT_BIND_ADDRESS,
      ),
    );
    const location = new URL(res.headers.get("location")!);

    expect(location.origin).toBe("https://us.ggd2l.com");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/me");
  });

  it("pins return_to to, and lands a signed-in player on, the canonical origin", async () => {
    verify.mockResolvedValueOnce("76561198000000001");
    upsert.mockResolvedValueOnce({ id: "site-user" } as Awaited<
      ReturnType<typeof upsertLeagueUser>
    >);

    const res = await GET(
      request(
        encodeURIComponent("/me"),
        "browser-state",
        "browser-state",
        AT_BIND_ADDRESS,
      ),
    );

    expect(verify).toHaveBeenCalledWith(
      expect.any(URLSearchParams),
      "https://us.ggd2l.com/api/auth/steam/callback?state=browser-state",
    );
    expect(res.headers.get("location")).toBe("https://us.ggd2l.com/me");
  });
});

describe("Steam callback when the deployment is undeclared", () => {
  it("pins return_to to APP_URL and redirects on the request's own origin", async () => {
    vi.stubEnv("APP_URL", "https://ggd2l.example");
    const res = await GET(request(null));

    expect(verify).toHaveBeenCalledWith(
      expect.any(URLSearchParams),
      "https://ggd2l.example/api/auth/steam/callback?state=browser-state",
    );
    expect(new URL(res.headers.get("location")!).origin).toBe(
      "https://league.example",
    );
  });
});
