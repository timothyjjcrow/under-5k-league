import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";
import { SESSION_COOKIE } from "@/lib/constants";
import { signSessionToken, verifySessionToken } from "@/lib/session-token";

const DAY_MS = 24 * 60 * 60 * 1000;

async function tokenIssued(daysAgo: number) {
  const issued = Date.now() - daysAgo * DAY_MS;
  return signSessionToken(
    { uid: "user-1", ep: 2, at: Math.floor(issued / 1000) },
    issued,
  );
}

function request(path: string, token: string | null, method = "GET") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  });
}

describe("proxy: keep active players signed in", () => {
  it("re-issues a week-old session on a page load, same user and epoch", async () => {
    const res = await proxy(request("/schedule", await tokenIssued(8)));
    const cookie = res.cookies.get(SESSION_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    expect(await verifySessionToken(cookie!.value)).toMatchObject({
      uid: "user-1",
      ep: 2,
    });
  });

  it("leaves a fresh session, no session and a bad cookie untouched", async () => {
    for (const token of [await tokenIssued(1), null, "not-a-jwt"]) {
      const res = await proxy(request("/", token));
      expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    }
  });

  it("never touches the cookie on a form post (server action)", async () => {
    const res = await proxy(request("/me", await tokenIssued(8), "POST"));
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("runs on pages only, never on /api or static files", () => {
    const [pattern] = config.matcher;
    const matches = (path: string) =>
      new RegExp(`^${pattern}$`).test(path);
    for (const page of ["/", "/me", "/matches/abc123", "/players/compare"]) {
      expect(matches(page), page).toBe(true);
    }
    for (const other of [
      "/api/auth/logout",
      "/api/auth/steam/callback",
      "/api/draft/tick",
      "/_next/static/chunks/app.js",
      "/_next/image",
      "/robots.txt",
      "/hero-loop.mp4",
    ]) {
      expect(matches(other), other).toBe(false);
    }
  });
});
