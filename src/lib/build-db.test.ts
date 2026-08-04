import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Vercel build's final DB step is a deploy-safety gate: client generation
// and `next build` run before it, only production may mutate the schema, and
// Prisma must not regenerate after the successful compile. Drive the real
// script through its exact test-only dry-run seam so the decision remains
// pinned without touching a database.
const SCRIPT = path.resolve(process.cwd(), "scripts/build-db.mjs");

const ACK = "I_UNDERSTAND_THIS_MAY_DELETE_PRODUCTION_DATA";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      ![
        "BUILD_DB_DRY_RUN",
        "NODE_ENV",
        "PRISMA_ACCEPT_DATA_LOSS",
        "VERCEL_ENV",
        "VERCEL_GIT_COMMIT_SHA",
      ].includes(key),
  ),
);

function decide(
  vercelEnv?: string,
  acknowledgement?: string,
  commitSha = SHA,
): string {
  return execFileSync("node", [SCRIPT], {
    env: {
      ...CLEAN_ENV,
      NODE_ENV: "test",
      BUILD_DB_DRY_RUN: "1",
      PRISMA_ACCEPT_DATA_LOSS: acknowledgement ?? "",
      VERCEL_GIT_COMMIT_SHA: commitSha,
      ...(vercelEnv === undefined ? {} : { VERCEL_ENV: vercelEnv }),
    },
    encoding: "utf8",
  });
}

describe("build-db deploy gate", () => {
  it("runs schema mutation only after client generation and a successful build", () => {
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
      "npx prisma validate",
      "npx prisma generate",
      "next build",
      "node scripts/build-db.mjs",
    ]);
  });

  it("pushes production schema changes without accepting data loss by default", () => {
    const out = decide("production");
    expect(out).toContain("prisma db push --skip-generate");
    expect(out).not.toContain("--accept-data-loss");
  });

  it("accepts data loss only for the exact current deployment commit", () => {
    expect(decide("production", `${ACK}:${SHA}`)).toContain(
      "prisma db push --skip-generate --accept-data-loss",
    );
    for (const nearMiss of [
      "true",
      "1",
      ACK,
      `${ACK}:${"f".repeat(40)}`,
      `${ACK.toLowerCase()}:${SHA}`,
      `${ACK}:${SHA} `,
    ]) {
      expect(decide("production", nearMiss)).not.toContain("--accept-data-loss");
    }
    expect(decide("production", `${ACK}:${SHA}`, "missing-sha")).not.toContain(
      "--accept-data-loss",
    );
  });

  it("preview and development deploys do not mutate or regenerate", () => {
    expect(decide("preview")).toContain("skip schema push");
    expect(decide("preview")).not.toContain("db push");
    expect(decide("preview")).not.toContain("prisma generate");
    expect(decide("development")).toContain("skip schema push");
  });

  it("an unset VERCEL_ENV (local build) never pushes", () => {
    const out = execFileSync("node", [SCRIPT], {
      env: {
        ...CLEAN_ENV,
        NODE_ENV: "test",
        BUILD_DB_DRY_RUN: "1",
      },
      encoding: "utf8",
    });
    expect(out).toContain("skip schema push");
    expect(out).not.toContain("db push");
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
    },
  );
});
