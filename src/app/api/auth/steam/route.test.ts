import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { RETURN_COOKIE, STEAM_STATE_COOKIE } from "@/lib/return-path";
import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());

describe("Steam login kickoff return path", () => {
  it("stores a safe destination in a short-lived protected cookie", async () => {
    const res = await GET(
      new NextRequest("https://league.example/api/auth/steam?next=%2Fme"),
    );

    const cookie = res.cookies.get(RETURN_COOKIE);
    expect(cookie?.value).toBe("/me");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
    expect(cookie?.maxAge).toBe(600);

    const state = res.cookies.get(STEAM_STATE_COOKIE);
    expect(state?.value).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(state?.httpOnly).toBe(true);
    expect(state?.sameSite).toBe("lax");
    expect(state?.maxAge).toBe(600);

    const steam = new URL(res.headers.get("location")!);
    const returnTo = new URL(steam.searchParams.get("openid.return_to")!);
    expect(returnTo.searchParams.get("state")).toBe(state?.value);
  });

  it("clears an abandoned destination when a new login has no safe next", async () => {
    const res = await GET(
      new NextRequest(
        "https://league.example/api/auth/steam?next=https%3A%2F%2Fevil.example",
      ),
    );

    expect(res.cookies.get(RETURN_COOKIE)?.value).toBe("");
    expect(res.headers.get("set-cookie")).toContain(`${RETURN_COOKIE}=`);
  });

  it("marks the return cookie secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(
      new NextRequest("https://league.example/api/auth/steam?next=%2Fme"),
    );

    expect(res.cookies.get(RETURN_COOKIE)?.secure).toBe(true);
    expect(res.cookies.get(STEAM_STATE_COOKIE)?.secure).toBe(true);
  });
});
