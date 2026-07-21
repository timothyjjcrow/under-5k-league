import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Vercel build's DB step is a deploy-safety gate: only production may
// `prisma db push` (it mutates the live DB with no migration history); every
// other environment — preview deploys of WIP branches included — must only
// generate the client. Drive the real script in dry-run mode so the decision
// logic that protects the prod database is pinned by a test.
const SCRIPT = path.resolve(process.cwd(), "scripts/build-db.mjs");

function decide(vercelEnv?: string): string {
  return execFileSync("node", [SCRIPT], {
    env: {
      ...process.env,
      BUILD_DB_DRY_RUN: "1",
      ...(vercelEnv === undefined ? {} : { VERCEL_ENV: vercelEnv }),
    },
    encoding: "utf8",
  });
}

describe("build-db deploy gate", () => {
  it("pushes the schema ONLY on production deploys", () => {
    expect(decide("production")).toContain("prisma db push");
  });

  it("preview and development deploys only generate the client", () => {
    expect(decide("preview")).toContain("prisma generate");
    expect(decide("preview")).not.toContain("db push");
    expect(decide("development")).toContain("prisma generate");
  });

  it("an unset VERCEL_ENV (local build) never pushes", () => {
    const out = execFileSync("node", [SCRIPT], {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== "VERCEL_ENV"),
        ),
        NODE_ENV: "test",
        BUILD_DB_DRY_RUN: "1",
      },
      encoding: "utf8",
    });
    expect(out).toContain("prisma generate");
    expect(out).not.toContain("db push");
  });
});
