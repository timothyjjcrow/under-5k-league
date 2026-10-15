import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";

// next.config.ts reads the flag when it loads, so each case re-imports it.
async function configWith(flag: string | undefined): Promise<NextConfig> {
  vi.resetModules();
  vi.stubEnv("GGD2L_SKIP_BUILD_TYPECHECK", flag);
  return (await import("../../next.config")).default;
}

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
