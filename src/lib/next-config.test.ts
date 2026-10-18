import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";
// Next's own builder for a header or redirect route, so these tests match a
// path the way the server's routes manifest does.
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import { REPO_ROOT } from "../../test/support/source-files";
import { createLeagueConfig } from "./league-config";

// next.config.ts reads the flag when it loads, so each case re-imports it.
async function configWith(flag: string | undefined): Promise<NextConfig> {
  vi.resetModules();
  vi.stubEnv("GGD2L_SKIP_BUILD_TYPECHECK", flag);
  return (await import("../../next.config")).default;
}

async function configFor(region: string | undefined): Promise<NextConfig> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_LEAGUE_REGION", region);
  return (await import("../../next.config")).default;
}

/** The Cache-Control the config gives a path: the last matching rule wins,
 *  as in Next's router. Undefined when no rule sets one. */
async function cacheControlFor(config: NextConfig, pathname: string) {
  let value: string | undefined;
  for (const route of (await config.headers!()) ?? []) {
    if (!new RegExp(buildCustomRoute("header", route).regex).test(pathname)) continue;
    for (const header of route.headers) {
      if (header.key.toLowerCase() === "cache-control") value = header.value;
    }
  }
  return value;
}

/** Where the config redirects a path, if anywhere, and whether for good. */
async function redirectFor(config: NextConfig, pathname: string) {
  for (const route of (await config.redirects!()) ?? []) {
    // The restricted prefix Next's build passes (no basePath here).
    const built = buildCustomRoute("redirect", route, ["/_next"]);
    if (new RegExp(built.regex).test(pathname)) {
      return { destination: route.destination, status: built.statusCode };
    }
  }
  return null;
}

const publicFile = (url: string) => path.join(REPO_ROOT, "public", ...url.split("/"));

const DAILY = "public, max-age=86400, stale-while-revalidate=604800";
const YEAR = "public, max-age=31536000, immutable";

// Everything except the flag's own key, with the async route tables resolved
// so two loads compare by value.
async function withoutTypescript(config: NextConfig) {
  const { typescript: _typescript, redirects, headers, ...rest } = config;
  return {
    ...rest,
    redirects: await redirects?.(),
    headers: await headers?.(),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GGD2L_SKIP_BUILD_TYPECHECK", () => {
  it("keeps Next's build type check when unset, as on Vercel, dev and CI", async () => {
    const config = await configWith(undefined);
    expect(config.typescript).toEqual({ ignoreBuildErrors: false });
  });

  it("skips it only for exactly 1, the value the box's build sets", async () => {
    expect((await configWith("1")).typescript).toEqual({
      ignoreBuildErrors: true,
    });
    for (const value of ["", "0", "true", "yes", " 1", "1 "]) {
      expect((await configWith(value)).typescript).toEqual({
        ignoreBuildErrors: false,
      });
    }
  });

  it("changes nothing else in the exported config", async () => {
    const unset = await configWith(undefined);
    const skipped = await configWith("1");
    expect(Object.keys(skipped).sort()).toEqual(Object.keys(unset).sort());
    expect(await withoutTypescript(skipped)).toEqual(
      await withoutTypescript(unset),
    );
  });
});

describe("the league's artwork and medals", () => {
  // Every file LEAGUE_CONFIG's branding points at, in both leagues: the
  // header logo is on every page, so with Next's max-age=0 each page view
  // asked the box whether it had changed.
  const brandingFiles = [...new Set(
    (["us", "eu"] as const).flatMap((region) => {
      const { branding } = createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: region });
      return [
        branding.logo,
        branding.navLogo,
        ...branding.icons.map((icon) => icon.url),
        branding.appleIcon,
        ...branding.appIcons.map((icon) => icon.src),
        branding.openGraphImage,
        branding.twitterImage,
      ];
    }),
  )];

  it("keeps every branding file a day, then serves it stale for a week", async () => {
    const config = await configFor(undefined);
    expect(brandingFiles.length).toBeGreaterThanOrEqual(10);
    for (const file of brandingFiles) {
      expect(existsSync(publicFile(file)), file).toBe(true);
      expect(await cacheControlFor(config, file), file).toBe(DAILY);
    }
    // Whatever else is added under public/brand.
    expect(await cacheControlFor(config, "/brand/banner.png")).toBe(DAILY);
  });

  it("keeps the full-size medals a day and the 72px copies a year", async () => {
    const config = await configFor(undefined);
    for (const file of ["/ranks/rank_icon_6.png", "/ranks/rank_star_4.png"]) {
      expect(existsSync(publicFile(file)), file).toBe(true);
      expect(await cacheControlFor(config, file), file).toBe(DAILY);
    }
    for (const file of ["/ranks/72/rank_icon_6.png", "/ranks/72/rank_star_4.png"]) {
      expect(existsSync(publicFile(file)), file).toBe(true);
      expect(await cacheControlFor(config, file), file).toBe(YEAR);
    }
    expect(await cacheControlFor(config, "/hero-loop.mp4")).toBe(YEAR);
  });

  it("caches no page or API route", async () => {
    const config = await configFor(undefined);
    for (const page of [
      "/",
      "/players/abc",
      "/matches/abc/opengraph-image",
      "/api/sync",
      "/brandnew",
      "/rankings",
    ]) {
      expect(await cacheControlFor(config, page), page).toBeUndefined();
    }
  });
});

describe("/favicon.ico and the Apple touch icons", () => {
  const ICON_PATHS = [
    "/favicon.ico",
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
  ];

  it("have no file of their own, so the redirects shadow nothing", () => {
    for (const icon of ICON_PATHS) {
      expect(existsSync(publicFile(icon)), icon).toBe(false);
      expect(existsSync(path.join(REPO_ROOT, "src", "app", icon.slice(1))), icon).toBe(false);
    }
  });

  it.each([
    [undefined, "us"],
    ["us", "us"],
    ["eu", "eu"],
    [" EU ", "eu"],
  ] as const)(
    "redirect to the league's own icons (NEXT_PUBLIC_LEAGUE_REGION=%s)",
    async (env, region) => {
      const config = await configFor(env);
      const { branding } = createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: env });
      expect(branding).toEqual(
        createLeagueConfig({ NEXT_PUBLIC_LEAGUE_REGION: region }).branding,
      );
      // The tab icon the layout links first, and the home-screen icon.
      const expected = {
        "/favicon.ico": branding.icons[0].url,
        "/apple-touch-icon.png": branding.appleIcon,
        "/apple-touch-icon-precomposed.png": branding.appleIcon,
      };
      for (const [icon, destination] of Object.entries(expected)) {
        expect(await redirectFor(config, icon), icon).toEqual({
          destination,
          status: 307,
        });
        expect(existsSync(publicFile(destination)), destination).toBe(true);
      }
    },
  );

  it("keep the old /features redirect beside them", async () => {
    const config = await configFor("eu");
    expect(await redirectFor(config, "/features")).toEqual({
      destination: "/how-it-works",
      status: 308,
    });
    expect(await redirectFor(config, "/favicon.ico.map")).toBeNull();
    expect(await redirectFor(config, "/brand/ggd2l-europe-icon-32.png")).toBeNull();
  });
});
