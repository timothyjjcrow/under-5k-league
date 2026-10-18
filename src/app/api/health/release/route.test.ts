import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { GET } from "./route";

const SHA = "0123456789abcdef0123456789abcdef01234567";

async function read() {
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/health/release", () => {
  beforeEach(() => {
    for (const name of [
      "LEAGUE_RELEASE_SHA",
      "LEAGUE_DEPLOY_ENV",
      "NEXT_PUBLIC_SITE_URL",
      "VERCEL_PROJECT_PRODUCTION_URL",
      "VERCEL_URL",
    ]) {
      vi.stubEnv(name, undefined);
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reports exactly the frozen identity fields", async () => {
    vi.stubEnv("LEAGUE_RELEASE_SHA", SHA);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://us.ggd2l.com");
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "production");

    expect(await read()).toEqual({
      ok: true,
      region: LEAGUE_CONFIG.region,
      commit: SHA,
      site: "https://us.ggd2l.com",
      deployEnv: "production",
    });
  });

  it.each(["", "abc123", SHA.toUpperCase(), `${SHA}0`, ` ${SHA}`])(
    "reports a malformed release SHA %j as null",
    async (value) => {
      vi.stubEnv("LEAGUE_RELEASE_SHA", value);
      expect((await read()).commit).toBeNull();
    },
  );

  it("reports a missing release SHA as null", async () => {
    expect((await read()).commit).toBeNull();
  });

  it("reports the baked site as an origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://eu.ggd2l.com/");
    expect((await read()).site).toBe("https://eu.ggd2l.com");
  });

  it("keeps Vercel's view when nothing self-hosted is declared", async () => {
    vi.stubEnv("LEAGUE_RELEASE_SHA", SHA);
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "ggd2l.vercel.app");
    expect(await read()).toEqual({
      ok: true,
      region: LEAGUE_CONFIG.region,
      commit: SHA,
      site: "https://ggd2l.vercel.app",
      deployEnv: null,
    });
  });

  it.each([
    ["staging", "staging"],
    ["prod", "invalid"],
  ])("reports the declared marker %j as %j", async (value, expected) => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", value);
    expect((await read()).deployEnv).toBe(expected);
  });
});
