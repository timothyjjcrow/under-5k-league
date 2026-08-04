import { beforeEach, describe, expect, it, vi } from "vitest";
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

const USER = { id: "site-user-a" } as Awaited<
  ReturnType<typeof getSessionUser>
>;

beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(USER);
  handle.mockReset();
  handle.mockResolvedValue({ redirect: "/me?discord=linked" });
  limit.mockReset();
  limit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

function callbackRequest({
  state = "browser-state",
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
  const cookie = packOauthCookie(
    "browser-state",
    "pkce-verifier",
    cookieUserId,
  );
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
        state: "browser-state",
        code: "discord-code",
      }),
    );
  });

  it("does not spend a shared-IP attempt for forged browser state", async () => {
    await GET(callbackRequest({ state: "attacker-state" }));

    expect(limit).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "attacker-state" }),
    );
  });

  it("does not spend a shared-IP attempt when the site session changed", async () => {
    await GET(callbackRequest({ cookieUserId: "original-site-user" }));

    expect(limit).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous duplicate callback values before the limiter/exchange path", async () => {
    const req = callbackRequest();
    req.nextUrl.searchParams.append("state", "browser-state");
    req.nextUrl.searchParams.append("code", "discord-code");

    await GET(req);

    expect(limit).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: null, code: null }),
    );
  });

  it("does not rate-limit a normal consent cancellation", async () => {
    const req = callbackRequest({ code: null });
    req.nextUrl.searchParams.set("error", "access_denied");

    await GET(req);

    expect(limit).not.toHaveBeenCalled();
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
});
