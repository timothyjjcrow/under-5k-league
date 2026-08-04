import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(process.cwd(), "scripts/validate-prod-env.mjs");
const MAX_LENGTH_CRON_SECRET = "Ab3dEf7!".repeat(64);
const VALID = {
  VERCEL_ENV: "production",
  NODE_ENV: "production",
  DATABASE_URL:
    "postgresql://league:pooled@ep-league-pooler.us-west-2.aws.neon.tech:5432/league?sslmode=require",
  DIRECT_URL:
    "postgresql://league:direct@ep-league.us-west-2.aws.neon.tech:5432/league?sslmode=require",
  AUTH_SECRET: "K3vM9zQ1rT8pL4xN7sW2dF6hJ0cB5yUaE9iO",
  CRON_SECRET: "N6pT2yK8mW4cR9hL1sD7vF3xB5qJ0zUaE2iG",
  BACKUP_RECEIPT_SECRET: "Q8rM4wT2yP9cL6hN1fD7sK3vB5xJ0zUaE2iG",
  STEAM_API_KEY: "0123456789ABCDEF0123456789ABCDEF",
  ADMIN_STEAM_IDS: "76561198000000001,76561198000000002",
  APP_URL: "https://league.example",
  NEXT_PUBLIC_SITE_URL: "https://league.example",
  PRIVACY_CONTACT_EMAIL: "privacy@ggd2l.org",
  PRIVACY_DATA_LOCATIONS: "United States",
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
    ["CRON_SECRET", "short", "CRON_SECRET"],
    ["CRON_SECRET", "c".repeat(32), "placeholder"],
    ["BACKUP_RECEIPT_SECRET", "short", "BACKUP_RECEIPT_SECRET"],
    ["STEAM_API_KEY", "", "STEAM_API_KEY"],
    ["STEAM_API_KEY", "replace-with-your-key", "STEAM_API_KEY"],
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
    ["PRIVACY_CONTACT_EMAIL", "", "PRIVACY_CONTACT_EMAIL"],
    ["PRIVACY_DATA_LOCATIONS", "", "PRIVACY_DATA_LOCATIONS"],
    ["PRIVACY_DATA_LOCATIONS", "TBD", "PRIVACY_DATA_LOCATIONS"],
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

  it.each([
    " privacy@ggd2l.org",
    "Privacy Team <privacy@ggd2l.org>",
    "mailto:privacy@ggd2l.org",
    "privacy@ggd2l.org,other@ggd2l.org",
    "privacy@league.example",
    "privacy@example.com",
    "privacy@league.invalid",
    "privacy@league.test",
    `privacy@ggd2l.org\nBcc: attacker@evil.example`,
    `${"a".repeat(245)}@ggd2l.org`,
  ])("rejects unsafe or placeholder privacy contact %j", (value) => {
    const result = run({ PRIVACY_CONTACT_EMAIL: value });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PRIVACY_CONTACT_EMAIL");
    expect(result.stderr).not.toContain(value);
    expect(result.stderr).not.toContain(VALID.AUTH_SECRET);
  });

  it("requires the backup receipt key to be independent from session signing", () => {
    const result = run({ BACKUP_RECEIPT_SECRET: VALID.AUTH_SECRET });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("different from AUTH_SECRET");
  });

  it("requires the scheduler key to be independent from every other secret", () => {
    const authReuse = run({ CRON_SECRET: VALID.AUTH_SECRET });
    expect(authReuse.status).toBe(1);
    expect(authReuse.stderr).toContain("different from AUTH_SECRET");

    const receiptReuse = run({ CRON_SECRET: VALID.BACKUP_RECEIPT_SECRET });
    expect(receiptReuse.status).toBe(1);
    expect(receiptReuse.stderr).toContain("different from BACKUP_RECEIPT_SECRET");
  });

  it("matches the runtime scheduler-secret whitespace and length contract", () => {
    const boundary = run({ CRON_SECRET: MAX_LENGTH_CRON_SECRET });
    expect(boundary.status, boundary.stderr).toBe(0);

    const whitespace = run({
      CRON_SECRET: `${VALID.CRON_SECRET.slice(0, 20)} ${VALID.CRON_SECRET.slice(20)}`,
    });
    expect(whitespace.status).toBe(1);
    expect(whitespace.stderr).toContain("must not contain whitespace");

    const oversized = run({ CRON_SECRET: `${MAX_LENGTH_CRON_SECRET}Z` });
    expect(oversized.status).toBe(1);
    expect(oversized.stderr).toContain("at most 512 characters");
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

  it.each(["", "https://discord-fixture.example"])(
    "rejects configured DISCORD_API_BASE=%j in production",
    (value) => {
      const result = run({ DISCORD_API_BASE: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "DISCORD_API_BASE is test-only and must be unset in production",
      );
    },
  );

  it.each([
    [{ DISCORD_CLIENT_ID: "oauth-client" }, "DISCORD_CLIENT_SECRET"],
    [{ DISCORD_CLIENT_SECRET: "oauth-secret" }, "DISCORD_CLIENT_ID"],
    [{ DISCORD_BOT_TOKEN: "bot-token" }, "DISCORD_GUILD_ID"],
    [{ DISCORD_GUILD_ID: "guild-id" }, "DISCORD_BOT_TOKEN"],
  ])("rejects a half-configured Discord pair", (overrides, missingKey) => {
    const result = run(overrides);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(missingKey);
    expect(result.stderr).toContain("both be set or both be unset");
  });

  it("accepts complete optional Discord OAuth and bot pairs", () => {
    const result = run({
      DISCORD_CLIENT_ID: "oauth-client",
      DISCORD_CLIENT_SECRET: "oauth-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_GUILD_ID: "guild-id",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts canonical Discord webhook fallbacks and rejects arbitrary fetch targets", () => {
    const webhook =
      "https://discord.com/api/webhooks/1379001234567890123/Ab3dEf7_9-token.value";
    const accepted = run({
      DISCORD_WEBHOOK_URL: webhook,
      DISCORD_INHOUSE_WEBHOOK_URL: webhook,
      DISCORD_INHOUSE_ALERT_WEBHOOK_URL: webhook,
    });
    expect(accepted.status, accepted.stderr).toBe(0);

    for (const key of [
      "DISCORD_WEBHOOK_URL",
      "DISCORD_INHOUSE_WEBHOOK_URL",
      "DISCORD_INHOUSE_ALERT_WEBHOOK_URL",
    ]) {
      const rejected = run({ [key]: "https://internal.example/collect" });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(key);
      expect(rejected.stderr).not.toContain("internal.example");
    }
  });

  it("rejects separate runtime and migration database usernames for this release", () => {
    const result = run({
      DIRECT_URL:
        "postgresql://migration:direct@ep-league.us-west-2.aws.neon.tech:5432/league?sslmode=require",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("same PostgreSQL username for this release");
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

  it("allows separate passwords for one username on the same custom host and port", () => {
    const result = run({
      DATABASE_URL:
        "postgresql://runtime:pooled@database.internal/league?schema=league",
      DIRECT_URL:
        "postgresql://runtime:direct@database.internal:5432/league?schema=league",
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
