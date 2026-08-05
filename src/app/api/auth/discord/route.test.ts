import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
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
