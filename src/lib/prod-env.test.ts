import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(process.cwd(), "scripts/validate-prod-env.mjs");
const VALID = {
  VERCEL_ENV: "production",
  NODE_ENV: "production",
  DATABASE_URL:
    "postgresql://league:pooled@ep-league-pooler.us-west-2.aws.neon.tech:5432/league?sslmode=require",
  DIRECT_URL:
    "postgresql://league:direct@ep-league.us-west-2.aws.neon.tech:5432/league?sslmode=require",
  AUTH_SECRET: "K3vM9zQ1rT8pL4xN7sW2dF6hJ0cB5yUaE9iO",
  BACKUP_RECEIPT_SECRET: "Q8rM4wT2yP9cL6hN1fD7sK3vB5xJ0zUaE2iG",
  ADMIN_STEAM_IDS: "76561198000000001,76561198000000002",
  APP_URL: "https://league.example",
  NEXT_PUBLIC_SITE_URL: "https://league.example",
  ALLOW_DEV_LOGIN: "false",
} satisfies NodeJS.ProcessEnv;

function run(overrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...VALID };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
}

describe("production environment validation", () => {
  it("accepts one complete, internally consistent production configuration", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("validation passed");
  });

  it("skips preview builds instead of requiring production credentials", () => {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, NODE_ENV: "production", VERCEL_ENV: "preview" },
      encoding: "utf8",
    });
    expect(out).toContain("validation skipped");
  });

  it.each([
    ["DATABASE_URL", "file:./dev.db", "DATABASE_URL"],
    ["DIRECT_URL", "", "DIRECT_URL"],
    ["AUTH_SECRET", "short", "AUTH_SECRET"],
    ["AUTH_SECRET", "a".repeat(32), "placeholder"],
    ["BACKUP_RECEIPT_SECRET", "short", "BACKUP_RECEIPT_SECRET"],
    [
      "AUTH_SECRET",
      "change-me-to-a-long-random-string-min-32-chars",
      "placeholder",
    ],
    ["ADMIN_STEAM_IDS", "", "at least one trusted SteamID64"],
    ["ADMIN_STEAM_IDS", "12345", "valid individual SteamID64"],
    [
      "ADMIN_STEAM_IDS",
      "76561190000000001",
      "valid individual SteamID64",
    ],
    [
      "ADMIN_STEAM_IDS",
      "76561198000000001,76561198000000001",
      "duplicate",
    ],
    ["APP_URL", "http://league.example", "APP_URL"],
    ["NEXT_PUBLIC_SITE_URL", "https://league.example/path", "NEXT_PUBLIC_SITE_URL"],
    ["ALLOW_DEV_LOGIN", "true", "ALLOW_DEV_LOGIN"],
  ])("rejects unsafe %s configuration", (key, value, message) => {
    const result = run({ [key]: value });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain(VALID.AUTH_SECRET);
  });

  it("rejects divergent authentication and public origins", () => {
    const result = run({ NEXT_PUBLIC_SITE_URL: "https://www.league.example" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("same canonical origin");
  });

  it("requires the backup receipt key to be independent from session signing", () => {
    const result = run({ BACKUP_RECEIPT_SECRET: VALID.AUTH_SECRET });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("different from AUTH_SECRET");
  });

  it.each(["1", "0", "true", ""])(
    "rejects configured BUILD_DB_DRY_RUN=%j in production",
    (value) => {
      const result = run({ BUILD_DB_DRY_RUN: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "BUILD_DB_DRY_RUN is test-only and must be unset in production",
      );
    },
  );

  it.each([
    [
      "user",
      "postgresql://other:direct@ep-league.us-west-2.aws.neon.tech/league",
    ],
    [
      "database",
      "postgresql://league:direct@ep-league.us-west-2.aws.neon.tech/other",
    ],
    [
      "endpoint",
      "postgresql://league:direct@ep-other.us-west-2.aws.neon.tech/league",
    ],
  ])("rejects pooled/direct URLs for a different %s", (_part, directUrl) => {
    const result = run({ DIRECT_URL: directUrl });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("same PostgreSQL user, database, and endpoint");
  });
});
