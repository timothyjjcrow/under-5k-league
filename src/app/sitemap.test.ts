import { afterEach, describe, expect, it, vi } from "vitest";
import sitemap from "./sitemap";

afterEach(() => vi.unstubAllEnvs());

describe("public sitemap", () => {
  it("includes public statistics, content, archive, and discovery surfaces", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://league.example");
    vi.stubEnv("VERCEL_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");

    const entries = sitemap();
    const urls = entries.map((entry) => entry.url);
    for (const path of [
      "/leaders",
      "/meta",
      "/records",
      "/players/compare",
      "/news",
      "/features",
      "/hall-of-fame",
      "/seasons",
      "/inhouse/history",
    ]) {
      expect(urls).toContain(`https://league.example${path}`);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("does not invent a last-modified date for static route entries", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://league.example");
    expect(sitemap().every((entry) => entry.lastModified == null)).toBe(true);
  });

  it("does not produce double slashes from a trailing-slash site override", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://league.example/");
    expect(sitemap().every((entry) => !entry.url.includes("example//"))).toBe(
      true,
    );
  });
});
