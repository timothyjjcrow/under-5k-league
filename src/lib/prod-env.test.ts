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

  it.each(["1", "0", "true", ""])(
    "rejects obsolete PRISMA_ACCEPT_DATA_LOSS=%j in production",
    (value) => {
      const result = run({ PRISMA_ACCEPT_DATA_LOSS: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "PRISMA_ACCEPT_DATA_LOSS is obsolete and must be unset",
      );
    },
  );

  it.each(["1", "0", "true", ""])(
    "rejects configured PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=%j in production",
    (value) => {
      const result = run({ PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK must be unset",
      );
    },
  );

  it("allows separate least-privilege runtime and migration database users", () => {
    const result = run({
      DIRECT_URL:
        "postgresql://migration:direct@ep-league.us-west-2.aws.neon.tech:5432/league?sslmode=require",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts known Supabase pooler/direct forms for the same project", () => {
    const result = run({
      DATABASE_URL:
        "postgresql://postgres.project-ref:pooled@aws-0-us-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
      DIRECT_URL:
        "postgresql://postgres:direct@db.project-ref.supabase.co:5432/postgres",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("allows separate roles on the same custom database host and port", () => {
    const result = run({
      DATABASE_URL:
        "postgresql://runtime:pooled@database.internal/league?schema=league",
      DIRECT_URL:
        "postgresql://migration:direct@database.internal:5432/league?schema=league",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects custom URLs whose ports could identify different clusters", () => {
    const result = run({
      DATABASE_URL:
        "postgresql://runtime:pooled@database.internal:6432/league?schema=league",
      DIRECT_URL:
        "postgresql://migration:direct@database.internal:5432/league?schema=league",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("same PostgreSQL host and effective port");
  });

  it("fails closed when custom pool/direct host relationships cannot be proven", () => {
    const result = run({
      DATABASE_URL:
        "postgresql://runtime:pooled@pool.database.internal:6432/league",
      DIRECT_URL:
        "postgresql://migration:direct@primary.database.internal:5432/league",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "same PostgreSQL host and effective port unless a supported managed provider can be matched",
    );
  });

  it.each([
    [
      "database",
      "postgresql://migration:direct@ep-league.us-west-2.aws.neon.tech/other",
      "same PostgreSQL database and schema",
    ],
    [
      "schema",
      "postgresql://migration:direct@ep-league.us-west-2.aws.neon.tech/league?schema=other",
      "same PostgreSQL database and schema",
    ],
    [
      "Neon project",
      "postgresql://migration:direct@ep-other.us-west-2.aws.neon.tech/league",
      "same managed PostgreSQL provider/project",
    ],
    [
      "managed provider",
      "postgresql://postgres:direct@db.project-ref.supabase.co/league",
      "same managed PostgreSQL provider/project",
    ],
  ])("rejects a direct URL for a different %s", (_part, directUrl, message) => {
    const result = run({ DIRECT_URL: directUrl });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("requires a recognizable managed runtime URL to be pooled", () => {
    const result = run({
      DATABASE_URL:
        "postgresql://league:runtime@ep-league.us-west-2.aws.neon.tech/league",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pooled PostgreSQL endpoint");
  });

  it.each([
    "postgresql://league:direct@ep-league-pooler.us-west-2.aws.neon.tech/league",
    "postgresql://postgres.project-ref:direct@aws-0-us-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
  ])("rejects a pooled DIRECT_URL", (directUrl) => {
    const overrides = directUrl.includes("supabase")
      ? {
          DATABASE_URL:
            "postgresql://postgres.project-ref:pooled@aws-0-us-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
          DIRECT_URL: directUrl,
        }
      : { DIRECT_URL: directUrl };
    const result = run(overrides);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("direct PostgreSQL endpoint, not a pooler");
  });
});
