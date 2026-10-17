import { describe, expect, it } from "vitest";
import { publicPageView, siteAnalyticsEnabled } from "./site-analytics";
import {
  filesContaining,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

describe("siteAnalyticsEnabled", () => {
  it("is on for Vercel production", () => {
    expect(siteAnalyticsEnabled({ VERCEL_ENV: "production" })).toBe(true);
  });

  it.each([
    {},
    { VERCEL_ENV: "preview" },
    { VERCEL_ENV: "development" },
    { VERCEL_ENV: "" },
    { VERCEL_ENV: "Production" },
    // The self-hosted box: Cloudflare's zone analytics, no Vercel script.
    { LEAGUE_DEPLOY_ENV: "production" },
    { LEAGUE_DEPLOY_ENV: "staging" },
  ])("is off for %j", (env) => {
    expect(siteAnalyticsEnabled(env)).toBe(false);
  });
});

describe("where the analytics script mounts", () => {
  // Every rendering file that mounts <SiteAnalytics>, wherever it moves.
  const mounts = filesContaining(
    sourceFiles("src/**/*.tsx", 100).map((f) => ({
      ...f,
      text: stripLineComments(f.text),
    })),
    /<SiteAnalytics\b/,
  );

  it("mounts in the root layout", () => {
    expect(mounts.map((f) => f.path)).toContain("src/app/layout.tsx");
  });

  it("mounts only behind siteAnalyticsEnabled()", () => {
    for (const file of mounts) {
      const lines = file.text.split("\n").filter((l) => /<SiteAnalytics\b/.test(l));
      expect(lines.length, file.path).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, file.path).toMatch(/siteAnalyticsEnabled\(\)\s*\?\s*<SiteAnalytics\b/);
      }
    }
  });
});

describe("public traffic reporting", () => {
  it("keeps the public page while removing query values and fragments", () => {
    const event = {
      type: "pageview" as const,
      url: "https://ggd2l.vercel.app/inhouse?join=1&code=private#room",
    };
    expect(publicPageView(event)).toEqual({
      type: "pageview",
      url: "https://ggd2l.vercel.app/inhouse",
    });
    expect(event.url).toContain("code=private");
  });

  it.each(["/admin", "/admin/activity", "/api/auth/steam", "/login", "/logout", "/me", "/me/settings"])(
    "excludes %s from audience figures",
    (path) => {
      expect(publicPageView({ type: "pageview", url: `https://ggd2l.vercel.app${path}` })).toBeNull();
    },
  );

  it.each(["/", "/inhouse/history", "/players/player-123", "/meta", "/news"])(
    "retains public traffic to %s",
    (path) => {
      const event = { type: "pageview" as const, url: `https://ggd2l.vercel.app${path}` };
      expect(publicPageView(event)).toEqual(event);
    },
  );

  it("does not send custom events", () => {
    expect(publicPageView({ type: "event", url: "https://ggd2l.vercel.app/" })).toBeNull();
  });
});
