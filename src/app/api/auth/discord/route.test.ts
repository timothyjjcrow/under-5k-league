import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "user-1" }),
}));

vi.mock("@/lib/discord-roles", () => ({
  getGuildConfig: vi.fn(() => ({ token: "bot-token", guildId: "guild-1" })),
}));

beforeEach(() => {
  vi.stubEnv("DISCORD_CLIENT_ID", "client-1");
  vi.stubEnv("DISCORD_CLIENT_SECRET", "client-secret");
  vi.stubEnv("APP_URL", "https://preview.example");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Discord OAuth kickoff deployment policy", () => {
  it("uses identify only in preview even when the live guild is configured", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");

    const res = await GET(
      new NextRequest("https://preview.example/api/auth/discord"),
    );
    const target = new URL(res.headers.get("location")!);

    expect(target.origin).toBe("https://discord.com");
    expect(target.searchParams.get("scope")).toBe("identify");
    expect(target.searchParams.get("redirect_uri")).toBe(
      "https://preview.example/api/auth/discord/callback",
    );
  });

  it("preserves one-click guild join in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");

    const res = await GET(
      new NextRequest("https://ggd2l.example/api/auth/discord"),
    );
    const target = new URL(res.headers.get("location")!);

    expect(target.searchParams.get("scope")).toBe("identify guilds.join");
  });
});

describe("Discord OAuth kickoff origin", () => {
  const session = vi.mocked(getSessionUser);

  describe("on a self-hosted league", () => {
    // Next hands the handler the 127.0.0.1 bind address behind Caddy.
    const kickoff = () =>
      GET(new NextRequest("https://127.0.0.1:3001/api/auth/discord"));

    beforeEach(() => {
      vi.stubEnv("LEAGUE_DEPLOY_ENV", "production");
      vi.stubEnv("APP_URL", "https://us.ggd2l.com");
    });

    it("registers the canonical callback with Discord", async () => {
      const target = new URL((await kickoff()).headers.get("location")!);

      expect(target.origin).toBe("https://discord.com");
      expect(target.searchParams.get("redirect_uri")).toBe(
        "https://us.ggd2l.com/api/auth/discord/callback",
      );
    });

    it("sends a signed-out player to the canonical login page", async () => {
      session.mockResolvedValueOnce(null);

      expect((await kickoff()).headers.get("location")).toBe(
        "https://us.ggd2l.com/login?next=/me",
      );
    });

    it("sends an unconfigured league back to the canonical profile", async () => {
      vi.stubEnv("DISCORD_CLIENT_ID", "");

      expect((await kickoff()).headers.get("location")).toBe(
        "https://us.ggd2l.com/me?discord=unconfigured",
      );
    });
  });

  describe("when the deployment is undeclared", () => {
    it("registers APP_URL's callback and redirects on the request's origin", async () => {
      const target = new URL(
        (
          await GET(new NextRequest("https://ggd2l.example/api/auth/discord"))
        ).headers.get("location")!,
      );
      expect(target.searchParams.get("redirect_uri")).toBe(
        "https://preview.example/api/auth/discord/callback",
      );

      session.mockResolvedValueOnce(null);
      const signedOut = await GET(
        new NextRequest("https://ggd2l.example/api/auth/discord"),
      );
      expect(signedOut.headers.get("location")).toBe(
        "https://ggd2l.example/login?next=/me",
      );
    });
  });
});
