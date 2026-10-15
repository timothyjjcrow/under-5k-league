import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  canonicalOrigin,
  providerReturnBase,
  publicOrigin,
} from "./public-origin";

afterEach(() => vi.unstubAllEnvs());

// What Next hands a route handler on the box: the URL of the bind address.
const AT_BIND_ADDRESS = new NextRequest("https://127.0.0.1:3001/api/inhouse");
// What it hands one on Vercel or in local development: the host browsed.
const AT_REQUEST_HOST = new NextRequest("https://league.example/api/inhouse");
const US = { LEAGUE_DEPLOY_ENV: "production", APP_URL: "https://us.ggd2l.com" };

describe("canonicalOrigin", () => {
  it("is null when the deployment is undeclared, even with APP_URL set", () => {
    expect(canonicalOrigin({})).toBeNull();
    expect(canonicalOrigin({ APP_URL: "https://us.ggd2l.com" })).toBeNull();
    expect(
      canonicalOrigin({ VERCEL_ENV: "production", APP_URL: "https://x.example" }),
    ).toBeNull();
  });

  it("is APP_URL for every declared marker, a typo'd one included", () => {
    expect(canonicalOrigin(US)).toBe("https://us.ggd2l.com");
    for (const marker of ["staging", "prod", ""]) {
      expect(
        canonicalOrigin({ LEAGUE_DEPLOY_ENV: marker, APP_URL: "https://eu.ggd2l.com" }),
      ).toBe("https://eu.ggd2l.com");
    }
    // The documented on-demand staging slot is reached through an SSH tunnel.
    expect(
      canonicalOrigin({ LEAGUE_DEPLOY_ENV: "staging", APP_URL: "http://localhost:3190" }),
    ).toBe("http://localhost:3190");
  });

  it.each([
    undefined,
    "",
    "not a URL",
    "us.ggd2l.com",
    "https://us.ggd2l.com/",
    "https://us.ggd2l.com/league",
    "https://us.ggd2l.com?x=1",
    "HTTPS://US.GGD2L.COM",
    "ftp://us.ggd2l.com",
    "file:///srv/ggd2l",
  ])("throws when declared and APP_URL is %j", (appUrl) => {
    expect(() =>
      canonicalOrigin({ LEAGUE_DEPLOY_ENV: "production", APP_URL: appUrl }),
    ).toThrow(/APP_URL must be one canonical/);
  });

  it("names the variable, never its value, in the error", () => {
    let message = "";
    try {
      canonicalOrigin({
        LEAGUE_DEPLOY_ENV: "production",
        APP_URL: "https://us.ggd2l.com/private-path",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/APP_URL/);
    expect(message).not.toMatch(/private-path|ggd2l\.com/);
  });
});

describe("publicOrigin", () => {
  it("is the request's own origin when undeclared, as on Vercel today", () => {
    expect(publicOrigin(AT_REQUEST_HOST, {})).toBe("https://league.example");
    expect(
      publicOrigin(AT_REQUEST_HOST, { APP_URL: "https://us.ggd2l.com" }),
    ).toBe("https://league.example");
  });

  it("is the canonical origin, never the bind address, when declared", () => {
    expect(publicOrigin(AT_BIND_ADDRESS, US)).toBe("https://us.ggd2l.com");
  });

  it("ignores a forwarded or spoofed host when declared", () => {
    const req = new NextRequest("https://127.0.0.1:3001/api/inhouse", {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    });
    expect(publicOrigin(req, US)).toBe("https://us.ggd2l.com");
  });

  it("reads process.env by default", () => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "production");
    vi.stubEnv("APP_URL", "https://eu.ggd2l.com");
    expect(publicOrigin(AT_BIND_ADDRESS)).toBe("https://eu.ggd2l.com");
  });

  it("fails closed when declared without a usable APP_URL", () => {
    expect(() =>
      publicOrigin(AT_BIND_ADDRESS, { LEAGUE_DEPLOY_ENV: "production" }),
    ).toThrow();
  });
});

describe("providerReturnBase", () => {
  it("keeps the pre-self-hosting rule when undeclared: APP_URL, else the request", () => {
    expect(
      providerReturnBase(AT_REQUEST_HOST, { APP_URL: "https://ggd2l.vercel.app" }),
    ).toBe("https://ggd2l.vercel.app");
    expect(providerReturnBase(AT_REQUEST_HOST, { APP_URL: "" })).toBe(
      "https://league.example",
    );
    expect(providerReturnBase(AT_REQUEST_HOST, {})).toBe(
      "https://league.example",
    );
  });

  it("is the canonical origin when declared", () => {
    expect(providerReturnBase(AT_BIND_ADDRESS, US)).toBe("https://us.ggd2l.com");
    expect(() =>
      providerReturnBase(AT_BIND_ADDRESS, {
        LEAGUE_DEPLOY_ENV: "staging",
        APP_URL: "https://us.ggd2l.com/",
      }),
    ).toThrow();
  });
});
