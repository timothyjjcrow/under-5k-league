import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Vercel build's DB step is a deploy-safety gate: committed migrations are
// validated and deployed before the new client/build, only production may
// mutate the schema, and there is no data-loss override. Drive the real script
// through its exact test-only dry-run seam so the decision remains pinned
// without touching a database.
const SCRIPT = path.resolve(process.cwd(), "scripts/build-db.mjs");

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      ![
        "BUILD_DB_DRY_RUN",
        "NODE_ENV",
        "VERCEL_ENV",
      ].includes(key),
  ),
);

function decide(vercelEnv?: string): string {
  return execFileSync("node", [SCRIPT], {
    env: {
      ...CLEAN_ENV,
      NODE_ENV: "test",
      BUILD_DB_DRY_RUN: "1",
      ...(vercelEnv === undefined ? {} : { VERCEL_ENV: vercelEnv }),
    },
    encoding: "utf8",
  });
}

describe("build-db deploy gate", () => {
  it("deploys validated migrations before generating or building new code", () => {
    const config = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as { buildCommand: string };
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const stages = manifest.scripts["build:vercel"].split(" && ");

    expect(config.buildCommand).toBe("npm run build:vercel");
    expect(stages).toEqual([
      "node scripts/validate-prod-env.mjs",
      "node scripts/switch-db-provider.mjs postgresql",
      "npm run db:migrate:validate",
      "npm run db:migrate:preflight",
      "node scripts/build-db.mjs",
      "npm run db:migrate:postflight",
      "npx prisma generate",
      "next build",
    ]);
  });

  it("deploys committed production migrations without a schema-push escape hatch", () => {
    const out = decide("production");
    expect(out).toContain("prisma migrate deploy");
    expect(out).not.toContain("db push");
    expect(out).not.toContain("--accept-data-loss");
  });

  it("preview and development deploys do not mutate or regenerate", () => {
    expect(decide("preview")).toContain("skip migration deploy");
    expect(decide("preview")).not.toContain("db push");
    expect(decide("preview")).not.toContain("migrate deploy");
    expect(decide("preview")).not.toContain("prisma generate");
    expect(decide("development")).toContain("skip migration deploy");
  });

  it("an unset VERCEL_ENV (local build) never deploys migrations", () => {
    const out = execFileSync("node", [SCRIPT], {
      env: {
        ...CLEAN_ENV,
        NODE_ENV: "test",
        BUILD_DB_DRY_RUN: "1",
      },
      encoding: "utf8",
    });
    expect(out).toContain("skip migration deploy");
    expect(out).not.toContain("db push");
    expect(out).not.toContain("migrate deploy");
  });

  it.each([
    ["1", "production"],
    ["1", "development"],
    ["true", "test"],
    ["0", "test"],
    ["", "test"],
  ] as const)(
    "fails closed for BUILD_DB_DRY_RUN=%j with NODE_ENV=%s",
    (dryRun, nodeEnv) => {
      const result = spawnSync(process.execPath, [SCRIPT], {
        env: {
          ...CLEAN_ENV,
          NODE_ENV: nodeEnv,
          VERCEL_ENV: "production",
          BUILD_DB_DRY_RUN: dryRun,
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "BUILD_DB_DRY_RUN is allowed only as exact value 1 when NODE_ENV=test",
      );
      expect(result.stdout).not.toContain("prisma db push");
      expect(result.stdout).not.toContain("prisma migrate deploy");
    },
  );
});
