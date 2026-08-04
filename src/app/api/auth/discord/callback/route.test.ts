import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DISCORD_OAUTH_COOKIE, packOauthCookie } from "@/lib/discord-oauth";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ allowed: true, retryAfterMs: 0 })),
  clientIp: vi.fn(() => "test-ip"),
}));
vi.mock("@/lib/discord-link-service", () => ({
  handleDiscordCallback: vi.fn(async () => ({
    redirect: "/me?discord=linked",
  })),
}));

import { getSessionUser } from "@/lib/auth";
import { handleDiscordCallback } from "@/lib/discord-link-service";
import { rateLimit } from "@/lib/rate-limit";
import { GET } from "./route";

const session = vi.mocked(getSessionUser);
const handle = vi.mocked(handleDiscordCallback);
const limit = vi.mocked(rateLimit);

afterEach(() => vi.unstubAllEnvs());

const USER = { id: "site-user-a" } as Awaited<
  ReturnType<typeof getSessionUser>
>;
const OAUTH_STATE = "s".repeat(43);
const OAUTH_VERIFIER = "v".repeat(43);

beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(USER);
  handle.mockReset();
  handle.mockResolvedValue({ redirect: "/me?discord=linked" });
  limit.mockReset();
  limit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

function callbackRequest({
  state = OAUTH_STATE,
  code = "discord-code",
  cookieUserId = USER!.id,
}: {
  state?: string | null;
  code?: string | null;
  cookieUserId?: string;
} = {}) {
  const url = new URL("https://league.example/api/auth/discord/callback");
  if (state !== null) url.searchParams.set("state", state);
  if (code !== null) url.searchParams.set("code", code);
  const cookie = packOauthCookie(OAUTH_STATE, OAUTH_VERIFIER, cookieUserId);
  return new NextRequest(url, {
    headers: { cookie: `${DISCORD_OAUTH_COOKIE}=${cookie}` },
  });
}

describe("Discord OAuth callback boundary", () => {
  it("spends the outbound budget only after local session/state/user checks pass", async () => {
    await GET(callbackRequest());

    expect(limit).toHaveBeenCalledOnce();
    expect(handle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: USER!.id,
        state: OAUTH_STATE,
        code: "discord-code",
      }),
    );
  });

  it("does not spend a shared-IP attempt for forged browser state", async () => {
    const attackerState = "a".repeat(43);
    const res = await GET(callbackRequest({ state: attackerState }));

    expect(limit).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: attackerState }),
    );
    expect(res.cookies.get(DISCORD_OAUTH_COOKIE)).toBeUndefined();
  });

  it("does not spend a shared-IP attempt when the site session changed", async () => {
    const res = await GET(
      callbackRequest({ cookieUserId: "original-site-user" }),
    );

    expect(limit).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledOnce();
    expect(res.cookies.get(DISCORD_OAUTH_COOKIE)).toBeUndefined();
  });

  it("rejects ambiguous duplicate callback values before the limiter/exchange path", async () => {
    const req = callbackRequest();
    req.nextUrl.searchParams.append("state", OAUTH_STATE);
    req.nextUrl.searchParams.append("code", "discord-code");

    const res = await GET(req);

    expect(limit).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: null, code: null }),
    );
    expect(res.cookies.get(DISCORD_OAUTH_COOKIE)).toBeUndefined();
  });

  it("does not rate-limit a normal consent cancellation", async () => {
    const req = callbackRequest({ code: null });
    req.nextUrl.searchParams.set("error", "access_denied");

    const res = await GET(req);

    expect(limit).not.toHaveBeenCalled();
    expect(res.cookies.get(DISCORD_OAUTH_COOKIE)?.value).toBe("");
  });

  it("clears the one-shot cookie and skips the callback service when limited", async () => {
    limit.mockReturnValue({ allowed: false, retryAfterMs: 60_000 });

    const res = await GET(callbackRequest());

    expect(handle).not.toHaveBeenCalled();
    expect(
      new URL(res.headers.get("location")!).searchParams.get("discord"),
    ).toBe("error");
    expect(res.cookies.get(DISCORD_OAUTH_COOKIE)?.value).toBe("");
  });

  it("expires the production one-shot cookie with __Host-compatible attributes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(callbackRequest());

    const cookie = res.cookies.get(DISCORD_OAUTH_COOKIE);
    expect(cookie).toMatchObject({
      value: "",
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
    expect(new Date(cookie?.expires ?? 1).getTime()).toBe(0);
  });

  it("rejects oversized callback input before session or provider work", async () => {
    const req = callbackRequest();
    req.nextUrl.searchParams.set("padding", "x".repeat(5_000));

    const res = await GET(req);

    expect(new URL(res.headers.get("location")!).search).toBe("?discord=error");
    expect(session).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
    expect(res.cookies.get(DISCORD_OAUTH_COOKIE)).toBeUndefined();
  });

  it.each([{ state: "short" }, { code: "x".repeat(1_025) }])(
    "never reaches Discord with malformed bounded fields (%j)",
    async (input) => {
      await GET(callbackRequest(input));

      expect(limit).not.toHaveBeenCalled();
      expect(handle).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining(
          "state" in input ? { state: null } : { code: null },
        ),
      );
    },
  );
});
