import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSiteUrl } from "./site-url";

// Env-driven, so save/restore the three inputs around every test — a leaked
// override here would silently change what other env-reading tests see.
const KEYS = [
  "NEXT_PUBLIC_SITE_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveSiteUrl", () => {
  it("falls back to localhost with nothing configured", () => {
    expect(resolveSiteUrl()).toBe("http://localhost:3000");
  });

  it("an explicit NEXT_PUBLIC_SITE_URL wins over everything", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://ggd2l.example";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "prod.vercel.app";
    process.env.VERCEL_URL = "preview.vercel.app";
    expect(resolveSiteUrl()).toBe("https://ggd2l.example");
  });

  it("normalizes an explicit URL to its origin", () => {
    process.env.NEXT_PUBLIC_SITE_URL =
      "https://ggd2l.example/some/path/?preview=1";
    expect(resolveSiteUrl()).toBe("https://ggd2l.example");
  });

  it("ignores a malformed explicit URL and uses the deployment fallback", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "not a URL";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "ggd2l.vercel.app";
    expect(resolveSiteUrl()).toBe("https://ggd2l.vercel.app");
  });

  it("ignores a syntactically valid non-web URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "javascript:alert(1)";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "ggd2l.vercel.app";
    expect(resolveSiteUrl()).toBe("https://ggd2l.vercel.app");
  });

  it("Vercel's production domain gets https:// prepended", () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "ggd2l.vercel.app";
    expect(resolveSiteUrl()).toBe("https://ggd2l.vercel.app");
  });

  it("prefers the stable production domain over the per-deploy VERCEL_URL", () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "ggd2l.vercel.app";
    process.env.VERCEL_URL = "ggd2l-abc123-preview.vercel.app";
    expect(resolveSiteUrl()).toBe("https://ggd2l.vercel.app");
  });

  it("uses VERCEL_URL when the production domain is absent", () => {
    process.env.VERCEL_URL = "ggd2l-abc123-preview.vercel.app";
    expect(resolveSiteUrl()).toBe("https://ggd2l-abc123-preview.vercel.app");
  });

  it("treats an empty-string env var as unset", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "";
    process.env.VERCEL_URL = "";
    expect(resolveSiteUrl()).toBe("http://localhost:3000");
  });
});
